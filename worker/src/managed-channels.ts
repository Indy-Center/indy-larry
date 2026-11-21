import { parseChannels } from './channels';
import type { ChannelIdSend, ChannelSyncResult, ChannelsResult, ChannelsSync, DeleteRequest, DeleteResult, Deletion, ManagedChannel } from './client/api';
import { checkIds, discord, guildId, MAX_NAME_LENGTH, SNOWFLAKE, type GuildEnv } from './discord';
import { checkMessage, type Job } from './send';

/**
 * Channels Larry looks after: private text channels under a category named in CHANNEL_CATEGORIES.
 * syncChannels() finds each one or creates it; sendToChannel()/enqueueToChannel() post to one by ID.
 * It knows nothing about what a channel is for.
 *
 * The bot needs Manage Channels. A caller can only reach categories in the setting, so this isn't a
 * way to create or post in channels anywhere else on the server.
 */

const GUILD_TEXT = 0;
const VIEW_CHANNEL = 1n << 10n;
// What the roles a channel is visible to can do in one Larry creates.
const MEMBER_PERMISSIONS =
  VIEW_CHANNEL |
  (1n << 11n) | // Send Messages
  (1n << 16n) | // Read Message History
  (1n << 14n) | // Embed Links
  (1n << 15n) | // Attach Files
  (1n << 6n); // Add Reactions

export const GUILD_TEXT_CHANNEL = GUILD_TEXT;

export type DiscordChannel = { id: string; name: string; type: number; parent_id?: string | null; guild_id?: string };

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

/** CHANNEL_CATEGORIES, "training:111, events:222", as name -> category ID. Same format as SEND_CHANNELS. */
export function categories(env: Pick<GuildEnv, 'CHANNEL_CATEGORIES'>): Map<string, string> {
  return parseChannels(env.CHANNEL_CATEGORIES);
}

/** Check a request before anything is asked of Discord. Throws on the first thing wrong. */
export function checkChannels(env: Pick<GuildEnv, 'CHANNEL_CATEGORIES'>, request: ChannelsSync): ManagedChannel[] {
  if (!request || !Array.isArray(request.channels)) throw new Error('Expected { channels: [...] }');
  const known = categories(env);
  const keys = new Set<string>();
  const names = new Set<string>();

  for (const channel of request.channels) {
    if (!channel?.key || typeof channel.key !== 'string') throw new Error('Every channel needs a key');
    if (keys.has(channel.key)) throw new Error(`Channel "${channel.key}" is listed twice`);
    keys.add(channel.key);

    if (!known.has(channel.category)) {
      throw new Error(`Unknown category "${channel.category}". Known categories: ${[...known.keys()].join(', ') || 'none'}`);
    }
    const name = channelName(channel.name ?? '');
    if (!name) throw new Error(`Channel "${channel.key}" needs a name`);
    const place = `${channel.category}/${name}`;
    if (names.has(place)) throw new Error(`Two entries ask for the channel "${name}" in "${channel.category}"`);
    names.add(place);

    if (channel.id != null && !SNOWFLAKE.test(channel.id)) throw new Error(`Channel "${channel.key}": "${channel.id}" isn't a Discord ID`);
    // A channel nobody is allowed into is a mistake, not a request.
    if (!Array.isArray(channel.visibleTo) || channel.visibleTo.length === 0) throw new Error(`Channel "${channel.key}" must be visible to at least one role`);
    for (const id of channel.visibleTo) {
      if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new Error(`Channel "${channel.key}": "${id}" isn't a Discord role ID`);
    }
  }
  return request.channels;
}

/** RPC: find each channel or create it, and say which. */
export async function syncChannels(env: GuildEnv, request: ChannelsSync): Promise<ChannelsResult> {
  const guild = guildId(env);
  const wantedChannels = checkChannels(env, request);
  const known = categories(env);
  const dryRun = request.dryRun === true;
  const token = env.DISCORD_TOKEN;

  const [channels, me] = await Promise.all([
    discord<DiscordChannel[]>(token, 'GET', `/guilds/${guild}/channels`),
    discord<{ id: string }>(token, 'GET', '/users/@me'),
  ]);
  const place: ChannelPlace = { token, guild, me: me.id, channels };

  const results: ChannelSyncResult[] = [];

  for (const wanted of wantedChannels) {
    const name = channelName(wanted.name);
    const result: ChannelSyncResult = { key: wanted.key, channelId: null, channelName: name, channel: 'found' };
    results.push(result);

    try {
      const placed = await placeChannel(place, { categoryId: known.get(wanted.category)!, id: wanted.id, name, rename: wanted.rename, visibleTo: wanted.visibleTo }, { dryRun });
      result.channelId = placed.channelId;
      result.channelName = placed.channelName;
      result.channel = placed.outcome === 'renamed' ? 'found' : placed.outcome;
      if (placed.renamedFrom !== undefined) result.renamedFrom = placed.renamedFrom;
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      console.error(`Channel "${wanted.key}" could not be synced: ${result.error}`);
    }
  }

  return { dryRun, channels: results };
}

/** The server's channels as read once, and who Larry is there. A channel placeChannel() creates is added to `channels`. */
export type ChannelPlace = { token: string; guild: string; me: string; channels: DiscordChannel[] };

/** A private text channel to find or create. `name` is already a channelName(). */
export type WantedChannel = { categoryId: string; id?: string | null; name: string; rename?: boolean; visibleTo: string[] };

export type PlacedChannel = { channelId: string | null; channelName: string; outcome: 'found' | 'renamed' | 'created' | 'would-create'; renamedFrom?: string };

/**
 * Find a channel by ID, then by name under its category, else create it there, visible only to
 * `visibleTo` and Larry. A found channel keeps its permissions; one found by ID is renamed when `rename`
 * and its name has drifted. `dryRun` changes nothing; `mayCreate: false` reports `would-create` instead
 * of creating. Throws when two channels in the category share the name, or Discord refuses.
 */
export async function placeChannel(place: ChannelPlace, wanted: WantedChannel, { dryRun, mayCreate = true }: { dryRun: boolean; mayCreate?: boolean }): Promise<PlacedChannel> {
  const { token, guild, channels } = place;
  const { categoryId, name } = wanted;
  const inCategory = channels.filter((channel) => channel.type === GUILD_TEXT && channel.parent_id === categoryId);
  const sameName = inCategory.filter((channel) => channel.name === name);
  const byId = wanted.id ? inCategory.find((candidate) => candidate.id === wanted.id) : undefined;
  const channel = byId ?? (sameName.length === 1 ? sameName[0] : undefined);
  if (!channel && sameName.length > 1) throw new Error(`${sameName.length} channels are named "${name}"; give the channel's ID`);

  if (channel) {
    // Found, so its permissions are left as they are: someone set them, and they are not Larry's to change.
    // Only a channel the caller knows by ID can have drifted: one found by name already has it.
    if (!(wanted.rename && channel.name !== name)) return { channelId: channel.id, channelName: channel.name, outcome: 'found' };
    if (!dryRun) await discord(token, 'PATCH', `/channels/${channel.id}`, { name }, 'Channel sync: renamed');
    const renamedFrom = channel.name;
    channel.name = name;
    return { channelId: channel.id, channelName: name, outcome: 'renamed', renamedFrom };
  }
  if (dryRun || !mayCreate) return { channelId: null, channelName: name, outcome: 'would-create' };

  const allow = MEMBER_PERMISSIONS.toString();
  const created = await discord<DiscordChannel>(
    token,
    'POST',
    `/guilds/${guild}/channels`,
    {
      name,
      type: GUILD_TEXT,
      parent_id: categoryId,
      permission_overwrites: [
        { id: guild, type: 0, deny: VIEW_CHANNEL.toString() }, // @everyone
        ...[...new Set(wanted.visibleTo)].map((id) => ({ id, type: 0, allow })),
        { id: place.me, type: 1, allow }, // Larry itself, or it could not post here
      ],
    },
    'Channel sync',
  );
  channels.push(created);
  return { channelId: created.id, channelName: created.name, outcome: 'created' };
}

/** RPC: delete channels, and every message in them. One that is already gone counts as done. */
export async function deleteChannels(env: GuildEnv, request: DeleteRequest): Promise<DeleteResult> {
  const guild = guildId(env);
  const ids = checkIds(request);
  const dryRun = request.dryRun === true;
  const token = env.DISCORD_TOKEN;
  const allowed = new Set(categories(env).values());

  const channels = ids.length > 0 ? await discord<DiscordChannel[]>(token, 'GET', `/guilds/${guild}/channels`) : [];
  const deleted: Deletion[] = [];

  for (const id of ids) {
    const channel = channels.find((candidate) => candidate.id === id);
    if (!channel) {
      deleted.push({ id, outcome: 'gone' });
      continue;
    }
    // The same fence as posting: only a text channel under a category Larry looks after.
    if (channel.type !== GUILD_TEXT || !channel.parent_id || !allowed.has(channel.parent_id)) {
      deleted.push({ id, outcome: 'would-delete', error: `#${channel.name} isn't a text channel under a category in CHANNEL_CATEGORIES` });
      continue;
    }
    if (dryRun) {
      deleted.push({ id, outcome: 'would-delete' });
      continue;
    }
    try {
      await discord(token, 'DELETE', `/channels/${id}`, undefined, 'Channel deleted by a caller');
      deleted.push({ id, outcome: 'deleted' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Channel ${id} could not be deleted: ${message}`);
      deleted.push({ id, outcome: 'would-delete', error: message });
    }
  }

  return { dryRun, deleted };
}

/**
 * Check a message for a channel named by ID and turn it into a Job. The channel is looked up, so a
 * caller can only reach channels under a category in CHANNEL_CATEGORIES.
 */
export async function prepareChannelIdSend(env: GuildEnv, request: ChannelIdSend): Promise<Job> {
  const guild = guildId(env);
  if (!request || typeof request !== 'object') throw new Error('Expected a message object');
  if (typeof request.channelId !== 'string' || !SNOWFLAKE.test(request.channelId)) throw new Error(`"${request.channelId}" isn't a Discord channel ID`);
  const message = checkMessage(request);
  const allowed = new Set(categories(env).values());

  let channel: DiscordChannel;
  try {
    console.log(`[debug prepareChannelIdSend ${request.channelId}] message ok; asking Discord for the channel`);
    channel = await discord<DiscordChannel>(env.DISCORD_TOKEN, 'GET', `/channels/${request.channelId}`);
    console.log(`[debug prepareChannelIdSend ${request.channelId}] got type ${channel.type}, parent ${channel.parent_id}, guild ${channel.guild_id}`);
  } catch (error) {
    console.log(`[debug prepareChannelIdSend ${request.channelId}] the lookup threw: ${String(error)}`);
    throw new Error(`Larry can't see channel ${request.channelId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (channel.guild_id !== guild || channel.type !== GUILD_TEXT || !channel.parent_id || !allowed.has(channel.parent_id)) {
    throw new Error(`Channel ${request.channelId} isn't one Larry looks after: it is not a text channel under a category in CHANNEL_CATEGORIES`);
  }

  return { target: { channelId: channel.id }, message };
}
