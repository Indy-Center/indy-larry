import type { Room, RoomResult, RoomSend, RoomsResult, RoomsSync } from './client/api';
import { checkMessage, type Job, type SendEnv } from './send';

/**
 * Rooms: a role, and a private channel under one category that only the role and the room admins see.
 * syncRooms() makes Discord match what a caller asks for and reports what it changed.
 *
 * Everything is Discord's REST API with the bot token, so the bot on the VPS isn't involved. The bot
 * needs Manage Roles and Manage Channels, and its own role above every room role. Listing who holds a
 * role needs the Server Members intent switched on for the application; without it nobody is removed.
 */

const DISCORD_API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_NAME_LENGTH = 100;
const GUILD_TEXT = 0;
const MEMBERS_PAGE = 1000;
// 10,000 members is far past this server; hitting it means stop rather than remove on a partial list.
const MAX_MEMBER_PAGES = 10;
// A rate limit this short is waited out once; a longer one fails the call.
const MAX_WAIT_SECONDS = 5;
const UNKNOWN_MEMBER = 10007;

// What a room's role and its admins can do in a channel Larry creates.
const VIEW_CHANNEL = 1n << 10n;
const ROOM_PERMISSIONS =
  VIEW_CHANNEL |
  (1n << 11n) | // Send Messages
  (1n << 16n) | // Read Message History
  (1n << 14n) | // Embed Links
  (1n << 15n) | // Attach Files
  (1n << 6n); // Add Reactions

export type RoomEnv = Pick<SendEnv, 'DISCORD_TOKEN' | 'GUILD_ID' | 'ROOM_CATEGORY_ID' | 'ROOM_ADMIN_ROLE_ID'>;

type DiscordRole = { id: string; name: string };
type DiscordChannel = { id: string; name: string; type: number; parent_id?: string | null; guild_id?: string };
type DiscordMember = { user?: { id: string }; roles: string[] };

class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`Discord refused: ${status}${code ? ` (${code})` : ''} ${message}`);
  }
}

/** One Discord call. Waits out a short rate limit once. Throws DiscordError on anything else that isn't 2xx. */
async function discord<T>(token: string, method: string, route: string, body?: unknown, reason?: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${DISCORD_API}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const text = await res.text();
    let parsed: { message?: string; code?: number; retry_after?: number } = {};
    try {
      parsed = JSON.parse(text);
    } catch {}
    const wait = parsed.retry_after;
    if (res.status === 429 && attempt === 0 && wait != null && wait <= MAX_WAIT_SECONDS) {
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait * 1000)));
      continue;
    }
    throw new DiscordError(res.status, parsed.code, parsed.message ?? text);
  }
}

/** A channel name the way Discord stores it: lowercase, accents dropped, anything else a hyphen. */
export function channelName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LENGTH);
}

function settings(env: RoomEnv): { guildId: string; categoryId: string; adminRoleId: string } {
  const { GUILD_ID: guildId, ROOM_CATEGORY_ID: categoryId, ROOM_ADMIN_ROLE_ID: adminRoleId } = env;
  for (const [name, value] of Object.entries({ GUILD_ID: guildId, ROOM_CATEGORY_ID: categoryId, ROOM_ADMIN_ROLE_ID: adminRoleId })) {
    if (!value || !SNOWFLAKE.test(value)) throw new Error(`Rooms are not set up: ${name} is missing or isn't a Discord ID`);
  }
  return { guildId: guildId!, categoryId: categoryId!, adminRoleId: adminRoleId! };
}

/** Check a request before anything is asked of Discord. Throws on the first thing wrong. */
export function checkRooms(request: RoomsSync): Room[] {
  if (!request || !Array.isArray(request.rooms)) throw new Error('Expected { rooms: [...] }');
  const keys = new Set<string>();
  const roleNames = new Set<string>();
  const channelNames = new Set<string>();

  for (const room of request.rooms) {
    if (!room?.key || typeof room.key !== 'string') throw new Error('Every room needs a key');
    if (keys.has(room.key)) throw new Error(`Room "${room.key}" is listed twice`);
    keys.add(room.key);

    const roleName = room.role?.name?.trim();
    if (!roleName || roleName.length > MAX_NAME_LENGTH) throw new Error(`Room "${room.key}" needs a role name of 1 to ${MAX_NAME_LENGTH} characters`);
    if (roleName === '@everyone') throw new Error(`Room "${room.key}" can't use @everyone as its role`);
    // Two rooms sharing a role or a channel would each remove the other's members.
    if (roleNames.has(roleName)) throw new Error(`Two rooms ask for the role "${roleName}"`);
    roleNames.add(roleName);

    const channel = channelName(room.channel?.name ?? '');
    if (!channel) throw new Error(`Room "${room.key}" needs a channel name`);
    if (channelNames.has(channel)) throw new Error(`Two rooms ask for the channel "${channel}"`);
    channelNames.add(channel);

    for (const id of [room.role.id, room.channel.id]) {
      if (id != null && !SNOWFLAKE.test(id)) throw new Error(`Room "${room.key}": "${id}" isn't a Discord ID`);
    }
    if (!Array.isArray(room.members)) throw new Error(`Room "${room.key}" needs a members list`);
    for (const id of room.members) {
      if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new Error(`Room "${room.key}": "${id}" isn't a Discord user ID`);
    }
  }
  return request.rooms;
}

/** Every member of the server, or null when the bot isn't allowed to list them. */
async function listMembers(token: string, guildId: string): Promise<DiscordMember[] | null> {
  const members: DiscordMember[] = [];
  let after = '0';
  for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
    let batch: DiscordMember[];
    try {
      batch = await discord<DiscordMember[]>(token, 'GET', `/guilds/${guildId}/members?limit=${MEMBERS_PAGE}&after=${after}`);
    } catch (error) {
      // Server Members intent is off: carry on without removals rather than fail every room.
      if (error instanceof DiscordError && error.status === 403) return null;
      throw error;
    }
    members.push(...batch);
    if (batch.length < MEMBERS_PAGE) return members;
    after = batch[batch.length - 1]?.user?.id ?? after;
  }
  throw new Error(`The server has more than ${MAX_MEMBER_PAGES * MEMBERS_PAGE} members; refusing to sync rooms on a partial list`);
}

/** RPC: make each room match, and say what changed. */
export async function syncRooms(env: RoomEnv, request: RoomsSync): Promise<RoomsResult> {
  const { guildId, categoryId, adminRoleId } = settings(env);
  const rooms = checkRooms(request);
  const dryRun = request.dryRun === true;
  const token = env.DISCORD_TOKEN;

  const [roles, channels, members, me] = await Promise.all([
    discord<DiscordRole[]>(token, 'GET', `/guilds/${guildId}/roles`),
    discord<DiscordChannel[]>(token, 'GET', `/guilds/${guildId}/channels`),
    listMembers(token, guildId),
    discord<{ id: string }>(token, 'GET', '/users/@me'),
  ]);

  const inServer = members ? new Set(members.flatMap((member) => (member.user ? [member.user.id] : []))) : null;
  const results: RoomResult[] = [];

  for (const room of rooms) {
    const name = channelName(room.channel.name);
    const result: RoomResult = {
      key: room.key,
      roleId: null,
      role: 'found',
      channelId: null,
      channelName: name,
      channel: 'found',
      added: [],
      removed: [],
      notInServer: [],
    };
    results.push(result);

    try {
      // The role: by ID, then by exact name, then made.
      const roleName = room.role.name.trim();
      const named = roles.filter((role) => role.name === roleName);
      const role = roles.find((candidate) => candidate.id === room.role.id) ?? (named.length === 1 ? named[0] : undefined);
      if (!role && named.length > 1) throw new Error(`${named.length} roles are named "${roleName}"; give the role's ID`);
      if (role?.id === guildId || role?.id === adminRoleId) throw new Error(`"${roleName}" is @everyone or the room admin role`);

      if (role) {
        result.roleId = role.id;
      } else if (dryRun) {
        result.role = 'would-create';
      } else {
        const created = await discord<DiscordRole>(token, 'POST', `/guilds/${guildId}/roles`, { name: roleName, permissions: '0' }, 'Room role');
        roles.push(created);
        result.roleId = created.id;
        result.role = 'created';
      }

      // The channel: by ID, then by name under the category, then made there.
      const inCategory = channels.filter((channel) => channel.type === GUILD_TEXT && channel.parent_id === categoryId);
      const sameName = inCategory.filter((channel) => channel.name === name);
      const channel = channels.find((candidate) => candidate.id === room.channel.id && candidate.type === GUILD_TEXT) ?? (sameName.length === 1 ? sameName[0] : undefined);
      if (!channel && sameName.length > 1) throw new Error(`${sameName.length} channels are named "${name}"; give the channel's ID`);

      if (channel) {
        // Found, so left as it is: its permissions were set by hand and are not ours to change.
        result.channelId = channel.id;
        result.channelName = channel.name;
      } else if (dryRun || !result.roleId) {
        result.channel = 'would-create';
      } else {
        const allow = ROOM_PERMISSIONS.toString();
        const created = await discord<DiscordChannel>(
          token,
          'POST',
          `/guilds/${guildId}/channels`,
          {
            name,
            type: GUILD_TEXT,
            parent_id: categoryId,
            permission_overwrites: [
              { id: guildId, type: 0, deny: VIEW_CHANNEL.toString() }, // @everyone
              { id: result.roleId, type: 0, allow },
              { id: adminRoleId, type: 0, allow },
              { id: me.id, type: 1, allow }, // Larry itself, or it could not post here
            ],
          },
          'Room channel',
        );
        channels.push(created);
        result.channelId = created.id;
        result.channelName = created.name;
        result.channel = 'created';
      }

      // Who holds the role. With no member list, everyone wanted is tried and nobody is removed.
      const wanted = [...new Set(room.members)];
      const holders = members && result.roleId ? members.filter((member) => member.user && member.roles.includes(result.roleId!)).map((member) => member.user!.id) : [];
      const toAdd = wanted.filter((id) => !holders.includes(id));
      const toRemove = holders.filter((id) => !wanted.includes(id) && id !== me.id);

      for (const id of toAdd) {
        if (inServer && !inServer.has(id)) {
          result.notInServer.push(id);
          continue;
        }
        if (dryRun || !result.roleId) {
          result.added.push(id);
          continue;
        }
        try {
          await discord(token, 'PUT', `/guilds/${guildId}/members/${id}/roles/${result.roleId}`, undefined, 'Room member');
          result.added.push(id);
        } catch (error) {
          if (error instanceof DiscordError && error.status === 404 && error.code === UNKNOWN_MEMBER) result.notInServer.push(id);
          else throw error;
        }
      }

      for (const id of toRemove) {
        if (!dryRun) await discord(token, 'DELETE', `/guilds/${guildId}/members/${id}/roles/${result.roleId}`, undefined, 'No longer in the room');
        result.removed.push(id);
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      console.error(`Room "${room.key}" could not be synced: ${result.error}`);
    }
  }

  return { dryRun, canSeeMembers: members !== null, rooms: results };
}

/**
 * Check a message for a room's channel and turn it into a Job. The channel is looked up, so a caller
 * can only reach channels under the room category, not anywhere Larry happens to be able to post.
 */
export async function prepareRoomSend(env: RoomEnv, request: RoomSend): Promise<Job> {
  const { guildId, categoryId } = settings(env);
  if (!request || typeof request !== 'object') throw new Error('Expected a message object');
  if (typeof request.channelId !== 'string' || !SNOWFLAKE.test(request.channelId)) throw new Error(`"${request.channelId}" isn't a Discord channel ID`);
  const message = checkMessage(request);

  let channel: DiscordChannel;
  try {
    channel = await discord<DiscordChannel>(env.DISCORD_TOKEN, 'GET', `/channels/${request.channelId}`);
  } catch (error) {
    throw new Error(`Larry can't see channel ${request.channelId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (channel.guild_id !== guildId || channel.parent_id !== categoryId || channel.type !== GUILD_TEXT) {
    throw new Error(`Channel ${request.channelId} isn't a room: it is not a text channel under the room category`);
  }

  return { target: { channelId: channel.id }, message };
}
