import type { DeleteRequest, DeleteResult, Deletion, RoleSync, RoleSyncResult, RolesResult, RolesSync } from './client/api';
import { checkIds, discord, DiscordError, guildId, MAX_NAME_LENGTH, SNOWFLAKE, type GuildEnv } from './discord';

/**
 * Roles: who holds which. syncRoles() makes Discord match a list of roles and their members, and
 * reports what it changed. It knows nothing about what a role is for.
 *
 * The bot needs Manage Roles, and its own role above every role it manages. Listing who holds a role
 * needs the Server Members intent switched on for the application; without it nobody is removed.
 */

const MEMBERS_PAGE = 1000;
// 10,000 members is far past this server; hitting it means stop rather than remove on a partial list.
const MAX_MEMBER_PAGES = 10;
const UNKNOWN_MEMBER = 10007;

/**
 * Permissions that make a role more than a label. Larry won't hand out, take away or adopt a role
 * that carries any of them: a caller that could would be able to make anyone a moderator.
 */
const POWERFUL =
  (1n << 1n) | // Kick Members
  (1n << 2n) | // Ban Members
  (1n << 3n) | // Administrator
  (1n << 4n) | // Manage Channels
  (1n << 5n) | // Manage Server
  (1n << 7n) | // View Audit Log
  (1n << 13n) | // Manage Messages
  (1n << 17n) | // Mention @everyone
  (1n << 27n) | // Manage Nicknames
  (1n << 28n) | // Manage Roles
  (1n << 29n) | // Manage Webhooks
  (1n << 30n) | // Manage Expressions
  (1n << 33n) | // Manage Events
  (1n << 34n) | // Manage Threads
  (1n << 40n); // Timeout Members

type DiscordRole = { id: string; name: string; permissions?: string; managed?: boolean };
type DiscordMember = { user?: { id: string }; roles: string[] };

/** Why Larry won't touch a role, or null when it may. The one rule for syncing and deleting alike. */
function refusal(role: DiscordRole, guild: string): string | null {
  if (role.id === guild) return `"${role.name}" is @everyone`;
  if (role.managed) return `"${role.name}" belongs to a bot or an integration`;
  if (BigInt(role.permissions ?? '0') & POWERFUL) return `"${role.name}" carries moderation permissions; Larry only manages roles that are labels`;
  return null;
}

/** Check a request before anything is asked of Discord. Throws on the first thing wrong. */
export function checkRoles(request: RolesSync): RoleSync[] {
  if (!request || !Array.isArray(request.roles)) throw new Error('Expected { roles: [...] }');
  const keys = new Set<string>();
  const names = new Set<string>();

  for (const role of request.roles) {
    if (!role?.key || typeof role.key !== 'string') throw new Error('Every role needs a key');
    if (keys.has(role.key)) throw new Error(`Role "${role.key}" is listed twice`);
    keys.add(role.key);

    const name = role.name?.trim();
    if (!name || name.length > MAX_NAME_LENGTH) throw new Error(`Role "${role.key}" needs a name of 1 to ${MAX_NAME_LENGTH} characters`);
    if (name === '@everyone') throw new Error(`Role "${role.key}" can't be @everyone`);
    // Two entries for one role would each undo the other's members.
    if (names.has(name)) throw new Error(`Two entries ask for the role "${name}"`);
    names.add(name);

    if (role.id != null && !SNOWFLAKE.test(role.id)) throw new Error(`Role "${role.key}": "${role.id}" isn't a Discord ID`);
    if (typeof role.exclusive !== 'boolean') throw new Error(`Role "${role.key}" must say whether it is exclusive`);
    if (!Array.isArray(role.members)) throw new Error(`Role "${role.key}" needs a members list`);
    for (const id of role.members) {
      if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new Error(`Role "${role.key}": "${id}" isn't a Discord user ID`);
    }
  }
  return request.roles;
}

/** Every member of the server, or null when the bot isn't allowed to list them. */
async function listMembers(token: string, guild: string): Promise<DiscordMember[] | null> {
  const members: DiscordMember[] = [];
  let after = '0';
  for (let page = 0; page < MAX_MEMBER_PAGES; page++) {
    let batch: DiscordMember[];
    try {
      batch = await discord<DiscordMember[]>(token, 'GET', `/guilds/${guild}/members?limit=${MEMBERS_PAGE}&after=${after}`);
    } catch (error) {
      // Server Members intent is off: carry on without removals rather than fail every role.
      if (error instanceof DiscordError && error.status === 403) return null;
      throw error;
    }
    members.push(...batch);
    if (batch.length < MEMBERS_PAGE) return members;
    after = batch[batch.length - 1]?.user?.id ?? after;
  }
  throw new Error(`The server has more than ${MAX_MEMBER_PAGES * MEMBERS_PAGE} members; refusing to sync roles on a partial list`);
}

/** RPC: make each role's membership match, and say what changed. */
export async function syncRoles(env: GuildEnv, request: RolesSync): Promise<RolesResult> {
  const guild = guildId(env);
  const wantedRoles = checkRoles(request);
  const dryRun = request.dryRun === true;
  const token = env.DISCORD_TOKEN;

  const [roles, members, me] = await Promise.all([
    discord<DiscordRole[]>(token, 'GET', `/guilds/${guild}/roles`),
    listMembers(token, guild),
    discord<{ id: string }>(token, 'GET', '/users/@me'),
  ]);

  const inServer = members ? new Set(members.flatMap((member) => (member.user ? [member.user.id] : []))) : null;
  const results: RoleSyncResult[] = [];

  for (const wanted of wantedRoles) {
    const result: RoleSyncResult = { key: wanted.key, roleId: null, role: 'found', added: [], removed: [], notInServer: [] };
    results.push(result);

    try {
      // By ID, then by exact name, then made.
      const name = wanted.name.trim();
      const named = roles.filter((role) => role.name === name);
      const role = roles.find((candidate) => candidate.id === wanted.id) ?? (named.length === 1 ? named[0] : undefined);
      if (!role && named.length > 1) throw new Error(`${named.length} roles are named "${name}"; give the role's ID`);

      if (role) {
        const refused = refusal(role, guild);
        if (refused) throw new Error(refused);
        result.roleId = role.id;
        // Only a role the caller knows by ID can have drifted: one found by name already has it.
        if (wanted.rename && role.name !== name) {
          if (!dryRun) await discord(token, 'PATCH', `/guilds/${guild}/roles/${role.id}`, { name }, 'Role sync: renamed');
          result.renamedFrom = role.name;
          role.name = name;
        }
      } else if (dryRun) {
        result.role = 'would-create';
      } else {
        const created = await discord<DiscordRole>(token, 'POST', `/guilds/${guild}/roles`, { name, permissions: '0' }, 'Role sync');
        roles.push(created);
        result.roleId = created.id;
        result.role = 'created';
      }

      // With no member list, everyone wanted is tried and nobody is removed.
      const want = [...new Set(wanted.members)];
      const holders = members && result.roleId ? members.filter((member) => member.user && member.roles.includes(result.roleId!)).map((member) => member.user!.id) : [];
      const toAdd = want.filter((id) => !holders.includes(id));
      const toRemove = wanted.exclusive ? holders.filter((id) => !want.includes(id) && id !== me.id) : [];

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
          await discord(token, 'PUT', `/guilds/${guild}/members/${id}/roles/${result.roleId}`, undefined, 'Role sync');
          result.added.push(id);
        } catch (error) {
          if (error instanceof DiscordError && error.status === 404 && error.code === UNKNOWN_MEMBER) result.notInServer.push(id);
          else throw error;
        }
      }

      for (const id of toRemove) {
        if (!dryRun) await discord(token, 'DELETE', `/guilds/${guild}/members/${id}/roles/${result.roleId}`, undefined, 'Role sync: no longer listed');
        result.removed.push(id);
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      console.error(`Role "${wanted.key}" could not be synced: ${result.error}`);
    }
  }

  return { dryRun, canSeeMembers: members !== null, roles: results };
}

/** RPC: delete roles outright. One that is already gone counts as done. */
export async function deleteRoles(env: GuildEnv, request: DeleteRequest): Promise<DeleteResult> {
  const guild = guildId(env);
  const ids = checkIds(request);
  const dryRun = request.dryRun === true;
  const token = env.DISCORD_TOKEN;

  const roles = ids.length > 0 ? await discord<DiscordRole[]>(token, 'GET', `/guilds/${guild}/roles`) : [];
  const deleted: Deletion[] = [];

  for (const id of ids) {
    const role = roles.find((candidate) => candidate.id === id);
    if (!role) {
      deleted.push({ id, outcome: 'gone' });
      continue;
    }
    const refused = refusal(role, guild);
    if (refused) {
      deleted.push({ id, outcome: 'would-delete', error: refused });
      continue;
    }
    if (dryRun) {
      deleted.push({ id, outcome: 'would-delete' });
      continue;
    }
    try {
      await discord(token, 'DELETE', `/guilds/${guild}/roles/${id}`, undefined, 'Role deleted by a caller');
      deleted.push({ id, outcome: 'deleted' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Role ${id} could not be deleted: ${message}`);
      deleted.push({ id, outcome: 'would-delete', error: message });
    }
  }

  return { dryRun, deleted };
}
