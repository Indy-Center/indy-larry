import { clearAlert, postOnce, type AlertEnv } from './alerts';
import type { Group, GroupState, GroupStatus } from './client/api';
import { discord, DiscordError, guildId, MAX_NAME_LENGTH, type GuildEnv } from './discord';
import { GROUP_SOURCES, sourceMode, type GroupMode, type GroupSourceConfig, type GroupSourcesEnv } from './group-sources';
import { categories, channelName, GUILD_TEXT, placeChannel, type ChannelPlace, type DiscordChannel } from './managed-channels';
import { MAPPING } from './mapping';
import { getMember, refusal, type DiscordRole } from './roles';

/**
 * Group sync: apps serve groups (group-sources.ts, the contract in client/api.ts), and larry turns each
 * into a Discord role, plus a private channel for a group with a room, and keeps them in step. It knows
 * nothing about why a group exists. The role sync (role-sync.ts) puts the roles on each member's account.
 *
 * Each cron run reads every source that isn't `off` (syncGroups), before the role sync lists the
 * server. An answer that fails, is malformed or trips the drop guard is refused: that source's roles
 * aren't managed that run and its groups are left as they are. An accepted answer becomes the source's
 * latest copy, which every member job reads when it runs (groupChanges). syncMembers() and postToGroup()
 * read the source again (refreshSource), so a change lands at once, but make no roles or channels.
 *
 * KV, per source:
 * - `group:<source>:<key>`: the group's record, `{ roleId, channelId, missingSince }`. No TTL.
 * - `group-sync:<source>:copy`: the latest accepted answer's members by key (hold groups left out), kept an hour.
 * - `group-sync:<source>:last`: how many distinct CIDs the last accepted answer had, for the drop guard. No TTL.
 * - `group-sync:<source>:roles`: the groups the last cron run manages: key -> role ID and name.
 * - `group-sync:<source>:status`: what the last cron run did (getGroupStatus).
 * - `group-sync:<source>:alert:...`: alerts that stand, so each is posted once.
 */

export type GroupsEnv = GuildEnv & AlertEnv & GroupSourcesEnv & { ROLE_SYNC_MODE?: string };

type GroupRecord = { roleId: string | null; channelId: string | null; missingSince: string | null };
/** The latest accepted answer: each managed group's members (CIDs), by key. */
type GroupCopy = { at: string; groups: Record<string, string[]> };
/** The groups the last cron run manages, by key. */
export type ManagedRoles = Record<string, { roleId: string; name: string }>;
type GroupLine = GroupStatus['groups'][number];

const recordKey = (source: string, key: string) => `group:${source}:${key}`;
const recordPrefix = (source: string) => `group:${source}:`;
const copyKey = (source: string) => `group-sync:${source}:copy`;
const lastKey = (source: string) => `group-sync:${source}:last`;
const rolesKey = (source: string) => `group-sync:${source}:roles`;
const statusKey = (source: string) => `group-sync:${source}:status`;
const refusedAlertKey = (source: string) => `group-sync:${source}:alert:refused`;
const groupAlertKey = (source: string, kind: 'failed' | 'missing', key: string) => `group-sync:${source}:alert:${kind}:${key}`;

// As long as a run's lists are kept (role-sync.ts): past the time a run's jobs take.
const COPY_TTL_SECONDS = 60 * 60;
const GRACE_MS = 48 * 60 * 60 * 1000;
/** Roles and channels created per run, together; the rest wait for the next run. */
const MAX_CREATES = 25;
/** The drop guard: an answer whose distinct members fall by more than half, and by more than this many, is refused. */
const DROP_FLOOR = 10;

/** A source's mode as the sync applies it: `ROLE_SYNC_MODE` `dry-run` makes nothing for any role. */
export function effectiveMode(env: GroupsEnv, config: GroupSourceConfig): GroupMode {
  const mode = sourceMode(env, config);
  return mode === 'live' && (env.ROLE_SYNC_MODE ?? 'dry-run') !== 'live' ? 'dry-run' : mode;
}

export function findSource(source: string): GroupSourceConfig {
  const config = GROUP_SOURCES.find((candidate) => candidate.source === source);
  if (!config) throw new Error(`Unknown group source "${source}". Known sources: ${GROUP_SOURCES.map((known) => known.source).join(', ')}`);
  return config;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Check an answer, and return its groups with their names trimmed. Throws with what is wrong. */
export function checkAnswer(answer: unknown): Group[] {
  const groups = (answer as { groups?: unknown } | null)?.groups;
  if (!Array.isArray(groups)) throw new Error('it has no groups list');
  const keys = new Set<string>();
  return groups.map((group: Group) => {
    if (!group || typeof group.key !== 'string' || !group.key) throw new Error('a group has no key');
    const label = `group "${group.key}"`;
    if (keys.has(group.key)) throw new Error(`${label} is listed twice`);
    keys.add(group.key);
    const name = typeof group.name === 'string' ? group.name.trim() : '';
    if (!name || name.length > MAX_NAME_LENGTH || name === '@everyone') throw new Error(`${label} needs a name of 1 to ${MAX_NAME_LENGTH} characters`);
    if (!Array.isArray(group.members) || group.members.some((cid) => typeof cid !== 'string' || !/^\d{1,10}$/.test(cid))) throw new Error(`${label}'s members must be CIDs, as digit strings`);
    if (new Set(group.members).size !== group.members.length) throw new Error(`${label} lists a member twice`);
    if (group.room !== undefined) {
      const { room } = group;
      if (!room || typeof room.name !== 'string' || typeof room.fallbackName !== 'string' || !channelName(room.name) || !channelName(room.fallbackName)) {
        throw new Error(`${label}'s room needs a name and a fallbackName`);
      }
    }
    if (group.hold !== undefined && group.hold !== true) throw new Error(`${label}: hold must be true or left out`);
    return { ...group, name };
  });
}

export type SourceRead = { accepted: true; groups: Group[] } | { accepted: false; reason: string };

/**
 * Read a source and check its answer: the call, the answer's shape, and the drop guard. An accepted
 * answer becomes the source's latest copy. A refused one alerts once per outage and changes nothing.
 */
export async function readSource(env: GroupsEnv, config: GroupSourceConfig): Promise<SourceRead> {
  let answer: unknown;
  try {
    answer = await env[config.binding].getGroups();
  } catch (error) {
    return refuse(env, config, `the call failed: ${errorText(error)}`);
  }
  let groups: Group[];
  try {
    groups = checkAnswer(answer);
  } catch (error) {
    return refuse(env, config, `the answer is malformed: ${errorText(error)}`);
  }

  const members = new Set(groups.flatMap((group) => group.members)).size;
  const last = await env.KV.get<{ members: number }>(lastKey(config.source), 'json');
  const drop = last ? last.members - members : 0;
  if (last && drop > last.members / 2 && drop > DROP_FLOOR) {
    return refuse(env, config, `its members fell from ${last.members} to ${members}, by more than half. If that is right, reset its last answer (README, Group sync)`);
  }

  const at = new Date().toISOString();
  await env.KV.put(lastKey(config.source), JSON.stringify({ at, members }));
  const copy: GroupCopy = { at, groups: Object.fromEntries(groups.filter((group) => !group.hold).map((group) => [group.key, group.members])) };
  await env.KV.put(copyKey(config.source), JSON.stringify(copy), { expirationTtl: COPY_TTL_SECONDS });
  await clearAlert(env, refusedAlertKey(config.source));
  return { accepted: true, groups };
}

async function refuse(env: GroupsEnv, config: GroupSourceConfig, reason: string): Promise<SourceRead> {
  console.warn(`Group sync: refused ${config.source}'s answer: ${reason}`);
  await postOnce(env, refusedAlertKey(config.source), `Group sync: refused ${config.source}'s groups, so they are left as they are: ${reason}.`);
  return { accepted: false, reason };
}

/** Read a source again for syncMembers() and postToGroup(), unless it is `off`. Makes no roles or channels. */
export async function refreshSource(env: GroupsEnv, config: GroupSourceConfig): Promise<SourceRead | null> {
  return sourceMode(env, config) === 'off' ? null : readSource(env, config);
}

/** A group's record, or null when larry has made nothing for it. */
export async function groupRecord(env: Pick<GroupsEnv, 'KV'>, source: string, key: string): Promise<GroupRecord | null> {
  return env.KV.get<GroupRecord>(recordKey(source, key), 'json');
}

/** RPC: what the last cron run did with a source's groups. */
export async function getGroupStatus(env: GroupsEnv, source: string): Promise<GroupStatus> {
  const config = findSource(source);
  return (await env.KV.get<GroupStatus>(statusKey(source), 'json')) ?? { mode: effectiveMode(env, config), at: null, groups: [] };
}

/** The server as a cron run reads it once for every source. */
type GroupServer = ChannelPlace & { roles: DiscordRole[]; larryTop: number };

async function readGroupServer(env: GroupsEnv): Promise<GroupServer> {
  const guild = guildId(env);
  const token = env.DISCORD_TOKEN;
  const [roles, channels, me] = await Promise.all([
    discord<DiscordRole[]>(token, 'GET', `/guilds/${guild}/roles`),
    discord<DiscordChannel[]>(token, 'GET', `/guilds/${guild}/channels`),
    discord<{ id: string }>(token, 'GET', '/users/@me'),
  ]);
  const larry = await getMember(token, guild, me.id);
  const position = (id: string) => roles.find((role) => role.id === id)?.position ?? 0;
  return { token, guild, me: me.id, roles, channels, larryTop: Math.max(0, ...(larry?.roles ?? []).map(position)) };
}

/**
 * The cron's part: for each source that isn't `off`, read it, make or find each group's role and room,
 * retire groups no longer served, and keep the status. Before the role sync lists the server, so the
 * members' jobs this run manage what it found. A source that throws is logged and alerted; the role sync
 * carries on without it.
 */
export async function syncGroups(env: GroupsEnv): Promise<void> {
  let server: GroupServer | null = null;
  for (const config of GROUP_SOURCES) {
    const mode = effectiveMode(env, config);
    const at = new Date().toISOString();
    if (mode === 'off') {
      await env.KV.put(statusKey(config.source), JSON.stringify({ mode, at, groups: [] } satisfies GroupStatus));
      continue;
    }
    try {
      server ??= await readGroupServer(env);
      await syncSource(env, config, mode, server, at);
    } catch (error) {
      // Nothing of this source's is managed this run: its members' jobs leave its roles alone.
      await env.KV.delete(copyKey(config.source));
      await env.KV.put(statusKey(config.source), JSON.stringify({ mode, at, refused: `the run failed: ${errorText(error)}`, groups: [] } satisfies GroupStatus));
      console.error(`Group sync: ${config.source} failed this run: ${errorText(error)}`);
      await postOnce(env, refusedAlertKey(config.source), `Group sync: ${config.source}'s run failed, so its groups are left as they are: ${errorText(error)}.`);
    }
  }
}

async function syncSource(env: GroupsEnv, config: GroupSourceConfig, mode: GroupMode, server: GroupServer, at: string): Promise<void> {
  const read = await readSource(env, config);
  if (!read.accepted) {
    // Not managed this run: without a copy, the members' jobs leave this source's roles alone.
    await env.KV.delete(copyKey(config.source));
    await env.KV.put(statusKey(config.source), JSON.stringify({ mode, at, refused: read.reason, groups: [] } satisfies GroupStatus));
    return;
  }

  const records = await loadRecords(env, config.source);
  const run: SourceRun = { env, config, live: mode === 'live', server, creates: 0, categoryId: categories(env).get(config.roomCategory), mappedLogged: false };
  const roomNames = roomNamesFor(read.groups);
  const lines: GroupLine[] = [];
  const managed: ManagedRoles = {};

  for (const group of read.groups) {
    const stored = records.get(group.key);
    if (group.hold) {
      // Kept exactly as it is, and not made if there's nothing yet.
      lines.push({ key: group.key, name: group.name, role: 'held', ...(group.room ? { room: 'held' as const } : {}) });
      continue;
    }
    const record: GroupRecord = stored ? { ...stored } : { roleId: null, channelId: null, missingSince: null };
    const line = await makeGroup(run, group, record, roomNames.get(group.key));
    lines.push(line);
    if (record.roleId && ['found', 'created', 'renamed'].includes(line.role)) managed[group.key] = { roleId: record.roleId, name: group.name };
    if (record.roleId || record.channelId || stored) await saveRecord(env, config.source, group.key, stored ?? null, record);
  }

  const served = new Set(read.groups.map((group) => group.key));
  for (const [key, stored] of records) if (!served.has(key)) lines.push(await retireGroup(run, key, stored));

  await env.KV.put(rolesKey(config.source), JSON.stringify(managed));
  await env.KV.put(statusKey(config.source), JSON.stringify({ mode, at, groups: lines } satisfies GroupStatus));
  console.log(`Group sync (${mode === 'live' ? 'live' : 'dry run'}): ${config.source}: ${read.groups.length} groups served, ${Object.keys(managed).length} managed`);
}

type SourceRun = {
  env: GroupsEnv;
  config: GroupSourceConfig;
  live: boolean;
  server: GroupServer;
  /** Roles and channels created (or that would be, in dry-run) so far this run. */
  creates: number;
  categoryId: string | undefined;
  mappedLogged: boolean;
};

async function loadRecords(env: Pick<GroupsEnv, 'KV'>, source: string): Promise<Map<string, GroupRecord>> {
  const records = new Map<string, GroupRecord>();
  const prefix = recordPrefix(source);
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix, cursor });
    for (const { name } of page.keys) {
      const record = await env.KV.get<GroupRecord>(name, 'json');
      if (record) records.set(name.slice(prefix.length), record);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return records;
}

async function saveRecord(env: Pick<GroupsEnv, 'KV'>, source: string, key: string, before: GroupRecord | null, after: GroupRecord): Promise<void> {
  if (JSON.stringify(before) !== JSON.stringify(after)) await env.KV.put(recordKey(source, key), JSON.stringify(after));
}

/** Each room's channel name: its `name`, or its `fallbackName` when another served room's name is the same in Discord. */
function roomNamesFor(groups: Group[]): Map<string, string> {
  const uses = new Map<string, number>();
  for (const group of groups) if (group.room) uses.set(channelName(group.room.name), (uses.get(channelName(group.room.name)) ?? 0) + 1);
  const names = new Map<string, string>();
  for (const group of groups) {
    if (!group.room) continue;
    const clash = (uses.get(channelName(group.room.name)) ?? 0) > 1;
    names.set(group.key, channelName(clash ? group.room.fallbackName : group.room.name));
  }
  return names;
}

const MAPPED_ROLE_IDS = new Set(MAPPING.flatMap((entry) => (entry.discordRoleId ? [entry.discordRoleId] : [])));

/** Make or find a served group's role and room, updating `record`. Says what happened (or would). */
async function makeGroup(run: SourceRun, group: Group, record: GroupRecord, roomName: string | undefined): Promise<GroupLine> {
  const { env, config } = run;
  const line: GroupLine = { key: group.key, name: group.name, role: 'found', ...(group.room ? { room: 'found' as const } : {}) };
  if (record.missingSince) {
    // Served again within the grace period: managed again.
    record.missingSince = null;
    await clearAlert(env, groupAlertKey(config.source, 'missing', group.key));
  }

  try {
    line.role = await placeRole(run, group, record);
  } catch (error) {
    return failGroup(run, group, line, 'role', error);
  }
  if (group.room && roomName) {
    try {
      line.room = await placeRoom(run, record, roomName);
    } catch (error) {
      return failGroup(run, group, line, 'room', error);
    }
  }
  await clearAlert(env, groupAlertKey(config.source, 'failed', group.key));
  return line;
}

/** A failure that needs no alert: it is logged, and settles itself or is a choice. */
class Quiet extends Error {}
/** Quiet, and already logged once for the whole run. */
class Ignored extends Quiet {}

const waitsForNextRun = () => new Quiet(`waits for the next run: ${MAX_CREATES} roles and channels are made at most per run`);

async function failGroup(run: SourceRun, group: Group, line: GroupLine, part: 'role' | 'room', error: unknown): Promise<GroupLine> {
  line.error = errorText(error);
  line[part] = 'failed';
  // A room isn't made, or kept in step, while its role fails.
  if (part === 'role' && line.room) line.room = 'failed';
  const what = `Group sync: ${run.config.source} group "${group.key}" (${group.name}): its ${part} failed: ${line.error}`;
  if (error instanceof Ignored) return line;
  if (error instanceof Quiet) console.warn(what);
  else {
    console.error(what);
    await postOnce(run.env, groupAlertKey(run.config.source, 'failed', group.key), `${what}.`);
  }
  return line;
}

async function placeRole(run: SourceRun, group: Group, record: GroupRecord): Promise<GroupState> {
  const { server } = run;
  const byId = record.roleId ? server.roles.find((role) => role.id === record.roleId) : undefined;
  let role = byId;
  if (!role) {
    // Matched by name once, before the ID is stored; from then on by ID.
    const named = server.roles.filter((candidate) => candidate.name === group.name);
    if (named.length > 1) throw new Error(`${named.length} roles are named "${group.name}"`);
    role = named[0];
  }

  if (role) {
    if (MAPPED_ROLE_IDS.has(role.id)) {
      if (!run.mappedLogged) console.warn(`Group sync: ${run.config.source}: ignoring group roles the mapping manages this run`);
      run.mappedLogged = true;
      throw new Ignored(`role ${role.id} is one the mapping manages; ignored`);
    }
    // Without this, a name clash would hand a moderator role to a group and take it from everyone else.
    const refused = refusal(role, server.guild);
    if (refused) throw new Error(refused);
    if ((role.position ?? 0) >= server.larryTop) throw new Quiet(`"${role.name}" is at or above Larry's highest role`);
    // Stored even in dry-run: finding changes nothing in Discord.
    record.roleId = role.id;
    if (!byId || role.name === group.name) return 'found';
    if (run.live) await discord(server.token, 'PATCH', `/guilds/${server.guild}/roles/${role.id}`, { name: group.name }, 'Group sync: renamed');
    role.name = group.name;
    return 'renamed';
  }

  if (run.creates >= MAX_CREATES) throw waitsForNextRun();
  run.creates += 1;
  if (!run.live) return 'created';
  // No permissions, at the bottom of the list (Discord's default for a new role).
  const created = await discord<DiscordRole>(server.token, 'POST', `/guilds/${server.guild}/roles`, { name: group.name, permissions: '0' }, 'Group sync');
  server.roles.push(created);
  record.roleId = created.id;
  return 'created';
}

async function placeRoom(run: SourceRun, record: GroupRecord, name: string): Promise<GroupState> {
  const { server, config } = run;
  if (!run.categoryId) throw new Error(`the room category "${config.roomCategory}" isn't in CHANNEL_CATEGORIES`);
  const visibleTo = [...(record.roleId ? [record.roleId] : []), ...config.roomViewers];
  const mayCreate = run.creates < MAX_CREATES;
  const placed = await placeChannel(server, { categoryId: run.categoryId, id: record.channelId, name, rename: true, visibleTo }, { dryRun: !run.live, mayCreate });
  if (placed.channelId) record.channelId = placed.channelId;
  if (placed.outcome === 'would-create') {
    if (!mayCreate) throw waitsForNextRun();
    run.creates += 1;
    return 'created';
  }
  if (placed.outcome === 'created') run.creates += 1;
  return placed.outcome;
}

/**
 * A stored group the source no longer serves: left exactly as it is and alerted once, then after the
 * grace period its channel is deleted, then its role. The record goes only once Discord confirms each.
 */
async function retireGroup(run: SourceRun, key: string, stored: GroupRecord): Promise<GroupLine> {
  const { env, config, server } = run;
  const role = stored.roleId ? server.roles.find((candidate) => candidate.id === stored.roleId) : undefined;
  const line: GroupLine = { key, name: role?.name ?? key, role: 'missing', ...(stored.channelId ? { room: 'missing' as const } : {}) };
  const now = Date.now();

  if (!stored.missingSince) {
    // Kept in dry-run too: it is larry's own record, not a change in Discord, and lets the status say what would happen.
    await env.KV.put(recordKey(config.source, key), JSON.stringify({ ...stored, missingSince: new Date(now).toISOString() }));
    await postOnce(
      env,
      groupAlertKey(config.source, 'missing', key),
      `Group sync: ${config.source} no longer serves group "${key}" (${line.name}). Its role and room are left as they are, and deleted in 48 hours unless it is served again.`,
    );
    return line;
  }
  if (now - Date.parse(stored.missingSince) < GRACE_MS) return line;

  if (!run.live) return { ...line, role: 'deleted', ...(stored.channelId ? { room: 'deleted' as const } : {}) };
  const record = { ...stored };
  try {
    if (record.channelId) {
      await deleteRoom(server, run.categoryId, record.channelId);
      record.channelId = null;
      line.room = 'deleted';
      await env.KV.put(recordKey(config.source, key), JSON.stringify(record));
    }
    if (record.roleId) {
      if (role) {
        const refused = refusal(role, server.guild) ?? (MAPPED_ROLE_IDS.has(role.id) ? 'it is a role the mapping manages' : null);
        if (refused) throw new Error(refused);
      }
      await deleteGone(server.token, `/guilds/${server.guild}/roles/${record.roleId}`, 'Group sync: no longer served');
    }
  } catch (error) {
    line.error = errorText(error);
    if (line.room === 'missing') line.room = 'failed';
    else line.role = 'failed';
    console.error(`Group sync: couldn't delete ${config.source} group "${key}": ${line.error}`);
    await postOnce(env, groupAlertKey(config.source, 'failed', key), `Group sync: couldn't delete ${config.source} group "${key}" (${line.name}): ${line.error}.`);
    return line;
  }
  await env.KV.delete(recordKey(config.source, key));
  await clearAlert(env, groupAlertKey(config.source, 'missing', key));
  await clearAlert(env, groupAlertKey(config.source, 'failed', key));
  return { ...line, role: 'deleted' };
}

/** Delete a room, only if it is a text channel under the source's category. One already gone counts as deleted. */
async function deleteRoom(server: GroupServer, categoryId: string | undefined, channelId: string): Promise<void> {
  const channel = server.channels.find((candidate) => candidate.id === channelId);
  if (!channel) return;
  if (channel.type !== GUILD_TEXT || !categoryId || channel.parent_id !== categoryId) throw new Error(`#${channel.name} isn't a text channel under the source's room category`);
  await deleteGone(server.token, `/channels/${channelId}`, 'Group sync: no longer served');
}

async function deleteGone(token: string, route: string, reason: string): Promise<void> {
  try {
    await discord(token, 'DELETE', route, undefined, reason);
  } catch (error) {
    if (!(error instanceof DiscordError && error.status === 404)) throw error;
  }
}

/** One source's group-role changes for a member, and whether to make them. */
export type GroupChanges = { source: string; apply: boolean; add: { id: string; name: string }[]; remove: { id: string; name: string }[] };

/**
 * The group roles a member should gain and lose, from each source's latest copy: the roles of the
 * managed groups listing their CID, and none of the others. `cid` null is an unresolved account, which
 * loses them all. A source with no copy (expired, or every read refused) is left alone: no copy isn't
 * "listed nowhere". `apply` is false unless the role sync and the source are both `live`.
 */
export async function groupChanges(env: GroupsEnv, cid: number | null, holds: string[]): Promise<GroupChanges[]> {
  const changes: GroupChanges[] = [];
  for (const config of GROUP_SOURCES) {
    const mode = effectiveMode(env, config);
    if (mode === 'off') continue;
    const [copy, managed] = await Promise.all([env.KV.get<GroupCopy>(copyKey(config.source), 'json'), env.KV.get<ManagedRoles>(rolesKey(config.source), 'json')]);
    if (!copy || !managed) continue;
    const change: GroupChanges = { source: config.source, apply: mode === 'live', add: [], remove: [] };
    for (const [key, role] of Object.entries(managed)) {
      const members = copy.groups[key];
      // Not in the latest copy: not in use, so left alone until the next run settles it.
      if (!members) continue;
      const wanted = cid !== null && members.includes(String(cid));
      const has = holds.includes(role.roleId);
      if (wanted && !has) change.add.push({ id: role.roleId, name: role.name });
      if (!wanted && has) change.remove.push({ id: role.roleId, name: role.name });
    }
    changes.push(change);
  }
  return changes;
}
