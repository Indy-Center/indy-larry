/**
 * FROZEN: worker/src/role-sync.ts as it was before the platform seam (commit cef209b), its code unchanged
 * but for import paths (its comments are dropped; read them at that commit). role-sync-compare.test.ts runs it beside the new code to show both make the same
 * changes. Don't edit it; delete it, and that test, once TeamSpeak's adapter has shipped.
 */
import { postOnce, type AlertEnv } from '../../src/alerts';
import type { Links, SyncMemberResult, SyncMembersResult } from '../../src/client/api';
import { rolesFor } from '../../src/criteria';
import { discord, guildId, SNOWFLAKE, type GuildEnv } from '../../src/discord';
import { GROUP_SOURCES, type GroupSourcesEnv } from '../../src/group-sources';
import { groupChanges, refreshSource, syncGroups, type GroupChanges } from '../../src/groups';
import { findByDiscordId, getUser, IdentityConflict, writeDiscordId, type IdentityEnv, type IdentityUser } from '../../src/identity';
import { lookupVatsimRating, lookupVatusa } from '../../src/lookups';
import { MAPPING } from '../../src/mapping';
import { nicknameFor } from '../../src/nickname-rule';
import { applyNickname, nicknameGuard, type NicknameGuard, type NicknameOutcome } from '../../src/nicknames';
import { getMember, listMembers, syncRefusal, type DiscordMember, type DiscordRole } from '../../src/roles';
import type { SendEnv } from '../../src/send';
import { fetchLists, peopleFrom, type VatusaPerson } from '../../src/vatusa';

/** Every message on the `role-sync` queue. Each new kind of job is a new member of this union. */
export type RoleSyncMessage =
  | {
      type: 'run-member';
      runId: string;
      discordId: string;
      roleIds: string[];
      nick?: string | null;
      bot?: boolean;
    }
  | {
      type: 'sync-member';
      discordId: string;
    }
  | {
      type: 'sync-cid';
      cid: number;
      discordId: string;
    };

export type RoleSyncEnv = GuildEnv &
  Pick<SendEnv, 'SEND_CHANNELS' | 'LARRY_QUEUE'> &
  IdentityEnv &
  GroupSourcesEnv & {
    KV: KVNamespace;
    ROLE_SYNC_QUEUE: Queue<RoleSyncMessage>;
    ROLE_SYNC_MODE?: string;
    DISCORD_JOIN_BOT_TOKEN?: string;
  };

export type RunServer = { skippedRoles: string[]; guard: NicknameGuard };

export type RunLists = { people: VatusaPerson[]; server: RunServer };

type Mode = 'dry-run' | 'live';

const OUTAGE_KEY = 'role-sync:outage';
const SHARED_PREFIX = 'role-sync:shared:';
const runKey = (runId: string) => `role-sync:run:${runId}`;
const LATEST_RUN_KEY = 'role-sync:latest-run';
const memberKey = (cid: number) => `role-sync:member:${cid}`;
const MEMBER_COOLDOWN_SECONDS = 120;
const RUN_LISTS_TTL_SECONDS = 60 * 60;
const SEND_BATCH = 100;

function checkMode(env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE'>): Mode {
  const mode = env.ROLE_SYNC_MODE ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'live') throw new Error(`ROLE_SYNC_MODE "${mode}" isn't supported; use dry-run or live`);
  return mode;
}

async function readServer(env: GuildEnv): Promise<RunServer> {
  const guild = guildId(env);
  const [info, me] = await Promise.all([
    discord<{ owner_id: string; roles: DiscordRole[] }>(env.DISCORD_TOKEN, 'GET', `/guilds/${guild}`),
    discord<{ id: string }>(env.DISCORD_TOKEN, 'GET', '/users/@me'),
  ]);
  const larry = await getMember(env.DISCORD_TOKEN, guild, me.id);
  const position = (id: string) => info.roles.find((role) => role.id === id)?.position ?? 0;
  const larryTop = Math.max(0, ...(larry?.roles ?? []).map(position));

  const skippedRoles: string[] = [];
  for (const entry of MAPPING) {
    if (!entry.discordRoleId) continue;
    const role = info.roles.find((candidate) => candidate.id === entry.discordRoleId);
    if (!role) {
      skippedRoles.push(entry.discordRoleId);
      console.warn(`Role sync: mapped role ${entry.name} (${entry.discordRoleId}) isn't on the server; skipping it.`);
      continue;
    }
    const reason = syncRefusal(role, guild) ?? ((role.position ?? 0) >= larryTop ? "it is at or above Larry's highest role" : null);
    if (!reason) continue;
    skippedRoles.push(role.id);
    console.warn(`Role sync: skipping mapped role ${entry.name} this run: ${reason}`);
  }
  const others = info.roles.filter((role) => role.id !== guild);
  return { skippedRoles, guard: nicknameGuard(info.owner_id, me.id, others, larryTop) };
}

export async function startRoleSync(env: RoleSyncEnv): Promise<void> {
  checkMode(env);
  const fetched = await fetchLists();
  if ('failed' in fetched) {
    await alertOnce(env, `Role sync skipped: couldn't fetch ${joinNames(fetched.failed)} from VATUSA.`);
    return;
  }
  await env.KV.delete(OUTAGE_KEY);
  await clearSharedAlerts(env, peopleFrom(fetched.lists));

  const members = await listMembers(env.DISCORD_TOKEN, guildId(env));
  if (!members) throw new Error("Role sync can't list the server's members: switch on the Server Members intent");

  await syncGroups(env);
  const runId = crypto.randomUUID();
  const run: RunLists = { people: peopleFrom(fetched.lists), server: await readServer(env) };
  await env.KV.put(runKey(runId), JSON.stringify(run), { expirationTtl: RUN_LISTS_TTL_SECONDS });
  await env.KV.put(LATEST_RUN_KEY, runId, { expirationTtl: RUN_LISTS_TTL_SECONDS });

  const jobs: MessageSendRequest<RoleSyncMessage>[] = members.flatMap((member) =>
    member.user
      ? [{ body: { type: 'run-member', runId, discordId: member.user.id, roleIds: member.roles, nick: member.nick ?? null, ...(member.user.bot ? { bot: true } : {}) } }]
      : [],
  );
  for (let i = 0; i < jobs.length; i += SEND_BATCH) await env.ROLE_SYNC_QUEUE.sendBatch(jobs.slice(i, i + SEND_BATCH));
  console.log(`Role sync run ${runId}: ${run.people.length} people on VATUSA's lists; queued ${jobs.length} members`);
}

export async function consumeRoleSync(batch: MessageBatch<RoleSyncMessage>, env: RoleSyncEnv): Promise<void> {
  const mode = checkMode(env);
  const runs = new Map<string, RunLists | null>();
  const listsOf = async (runId: string) => {
    if (!runs.has(runId)) runs.set(runId, await env.KV.get<RunLists>(runKey(runId), 'json'));
    return runs.get(runId) ?? null;
  };

  for (const message of batch.messages) {
    try {
      const job = message.body;
      switch (job.type) {
        case 'run-member': {
          const run = await listsOf(job.runId);
          if (!run) {
            console.warn(`Role sync: run ${job.runId}'s lists have expired; ${job.discordId} waits for the next run`);
          } else {
            const now = mode === 'live' ? await getMember(env.DISCORD_TOKEN, guildId(env), job.discordId) : { roles: job.roleIds, nick: job.nick, user: { id: job.discordId, bot: job.bot } };
            if (!now) console.log(`Role sync: ${job.discordId} isn't in the server`);
            else await syncDiscordMember(env, run, memberFrom(job.discordId, now));
          }
          break;
        }
        case 'sync-member':
          await syncMemberJob(env, { discordId: job.discordId });
          break;
        case 'sync-cid':
          await syncMemberJob(env, { discordId: job.discordId, cid: job.cid });
          break;
        default:
          throw new Error(`Unknown role-sync job type "${(job as { type?: unknown }).type}"`);
      }
      message.ack();
    } catch (error) {
      console.error(`Role sync job failed, retrying: ${String(error)}`);
      message.retry({ delaySeconds: 10 * message.attempts });
    }
  }
}

export type MemberSync = { discordId: string; cid: number | null; add: string[]; remove: string[]; nickname: NicknameOutcome | null };

type SyncTarget = { discordId: string; roleIds: string[]; nick: string | null; cid?: number; bot?: boolean };

function memberFrom(discordId: string, held: DiscordMember): SyncTarget {
  return { discordId, roleIds: held.roles, nick: held.nick ?? null, bot: held.user?.bot === true };
}

async function syncDiscordMember(env: RoleSyncEnv, run: RunLists, member: SyncTarget): Promise<MemberSync> {
  const mode = checkMode(env);
  const label = mode === 'live' ? 'live' : 'dry run';
  const result: MemberSync = { discordId: member.discordId, cid: null, add: [], remove: [], nickname: null };
  if (member.bot) {
    console.log(`Role sync (${label}): ${member.discordId} is a bot account: left alone`);
    return result;
  }

  const found = await resolvePerson(env, run, member);
  if (found.kind === 'shared-id') await reportSharedId(env, member.discordId, found.sharedCids);
  const person = found.kind === 'person' ? found.person : null;
  result.cid = person?.cid ?? null;

  const addIds: string[] = [];
  const removeIds: string[] = [];
  if (found.kind !== 'account-taken') {
    const wanted = new Set(person ? rolesFor(person) : []);
    for (const entry of MAPPING) {
      if (!entry.discordRoleId || run.server.skippedRoles.includes(entry.discordRoleId)) continue;
      const holds = member.roleIds.includes(entry.discordRoleId);
      if (wanted.has(entry) && !holds) {
        result.add.push(entry.name);
        addIds.push(entry.discordRoleId);
      }
      if (!wanted.has(entry) && holds) {
        result.remove.push(entry.name);
        removeIds.push(entry.discordRoleId);
      }
    }
  }

  const groups = found.kind === 'account-taken' ? [] : await groupChanges(env, person?.cid ?? null, member.roleIds);

  if (mode === 'live') {
    const guild = guildId(env);
    const route = (id: string) => `/guilds/${guild}/members/${member.discordId}/roles/${id}`;
    for (const id of addIds) await discord(env.DISCORD_TOKEN, 'PUT', route(id), undefined, 'Role sync');
    for (const id of removeIds) await discord(env.DISCORD_TOKEN, 'DELETE', route(id), undefined, 'Role sync');
    for (const change of groups) {
      if (!change.apply) continue;
      for (const role of change.add) await discord(env.DISCORD_TOKEN, 'PUT', route(role.id), undefined, `Group sync: ${change.source}`);
      for (const role of change.remove) await discord(env.DISCORD_TOKEN, 'DELETE', route(role.id), undefined, `Group sync: ${change.source}`);
    }
  }

  if (person && found.kind === 'person') {
    const to = nicknameFor(person, person.rating < 1 ? null : await identityForNickname(env, person.cid, member.discordId, found.identity));
    if (to) result.nickname = await applyNickname(env, run.server.guard, member, to, mode === 'dry-run');
  }

  console.log(`Role sync (${label}): ${member.discordId} ${summary(found, result)}${groupNote(groups, mode)}`);
  return result;
}

function groupNote(groups: GroupChanges[], mode: Mode): string {
  return groups
    .filter((change) => change.add.length > 0 || change.remove.length > 0)
    .map((change) => {
      const label = mode === 'live' && change.apply ? 'live' : 'dry run';
      const names = (roles: { name: string }[]) => roles.map((role) => role.name).join(', ') || 'nothing';
      return `; ${change.source} groups (${label}): add ${names(change.add)}; remove ${names(change.remove)}`;
    })
    .join('');
}

function summary(found: Resolution, result: MemberSync): string {
  const removes = `remove ${result.remove.join(', ') || 'nothing'}`;
  switch (found.kind) {
    case 'person':
      return `CID ${found.person.cid}: add ${result.add.join(', ') || 'nothing'}; ${removes}${nicknameNote(result.nickname)}`;
    case 'account-taken':
      return 'unresolved (this Discord account is linked to another member): no changes';
    case 'linked-elsewhere':
      return `unresolved (their CID is linked to another Discord account): ${removes}`;
    case 'shared-id':
      return `unresolved (${found.sharedCids.length} CIDs give this Discord ID): ${removes}`;
    case 'no-one':
      return `unresolved: ${removes}`;
  }
}

async function reportSharedId(env: AlertEnv, discordId: string, cids: number[]): Promise<void> {
  const list = [...new Set(cids)].join(', ');
  console.log(`Role sync: Discord account ${discordId} is on VATUSA for more than one member (CIDs ${list})`);
  await postOnce(env, `${SHARED_PREFIX}${discordId}`, `Role sync: Discord account ${discordId} is on VATUSA for more than one member (CIDs ${list}). It gets no roles until one of them links it on their profile.`);
}

function nicknameNote(nickname: NicknameOutcome | null): string {
  if (!nickname || nickname.outcome === 'unchanged') return '';
  if (nickname.outcome === 'skipped') return `; nickname left alone (${nickname.reason})`;
  return `; nickname "${nickname.to}"`;
}

async function identityForNickname(env: IdentityEnv, cid: number, discordId: string, known: IdentityUser | null | undefined): Promise<IdentityUser | null> {
  if (known !== undefined) return known;
  try {
    return await getUser(env, cid);
  } catch (error) {
    console.warn(`Role sync: couldn't reach identity for ${discordId}'s name; using VATUSA's name: ${String(error)}`);
    return null;
  }
}

type Resolution =
  | { kind: 'person'; person: VatusaPerson; identity?: IdentityUser | null }
  | { kind: 'no-one' }
  | { kind: 'shared-id'; sharedCids: number[] }
  | { kind: 'linked-elsewhere' }
  | { kind: 'account-taken' };

type LinkAnswer = { holder: IdentityUser | null } | { holder: null; unreachable: unknown };

async function resolvePerson(env: Pick<RoleSyncEnv, 'KV'> & IdentityEnv, run: RunLists, member: { discordId: string; cid?: number }): Promise<Resolution> {
  const link: LinkAnswer =
    member.cid === undefined
      ? { holder: await findByDiscordId(env, member.discordId) }
      : await findByDiscordId(env, member.discordId).then(
          (holder) => ({ holder }),
          (error: unknown) => ({ holder: null, unreachable: error }),
        );
  const { holder } = link;
  if (member.cid !== undefined && holder && holder.cid !== member.cid) return { kind: 'account-taken' };
  const cid = member.cid ?? holder?.cid;
  const identity = holder ?? undefined;
  const matches = run.people.filter((person) => (cid !== undefined ? person.cid === cid : person.discordId === member.discordId));
  if (matches.length > 1) return { kind: 'shared-id', sharedCids: matches.map((match) => match.cid) };

  const person = matches[0] ?? (await lookupVatusa(env.KV, cid !== undefined ? { cid } : { discordId: member.discordId }));
  if (person) {
    if (cid !== undefined) return { kind: 'person', person, identity };
    const user = await getUser(env, person.cid);
    if (user?.discordId && user.discordId !== member.discordId) return { kind: 'linked-elsewhere' };
    return { kind: 'person', person, identity: user };
  }
  if (cid === undefined) return { kind: 'no-one' };

  const vatsim = await lookupVatsimRating(env.KV, cid);
  if (!vatsim) {
    if ('unreachable' in link) throw link.unreachable;
    return { kind: 'no-one' };
  }
  return {
    kind: 'person',
    person: { cid, discordId: member.discordId, rating: vatsim.rating, ratingShort: vatsim.ratingShort, facility: '', rosters: [], roles: [], name: null },
    identity,
  };
}

async function latestRun(env: Pick<RoleSyncEnv, 'KV'>): Promise<RunLists | null> {
  const latestId = await env.KV.get(LATEST_RUN_KEY);
  return latestId ? await env.KV.get<RunLists>(runKey(latestId), 'json') : null;
}

export async function runListsForMember(env: RoleSyncEnv): Promise<RunLists> {
  return (await latestRun(env)) ?? { people: [], server: await readServer(env) };
}

export async function syncMemberJob(env: RoleSyncEnv, member: { discordId: string; cid?: number }): Promise<MemberSync | null> {
  checkMode(env);
  const [run, inServer] = await Promise.all([runListsForMember(env), getMember(env.DISCORD_TOKEN, guildId(env), member.discordId)]);
  if (!inServer) {
    console.log(`Role sync: ${member.discordId} isn't in the server`);
    return null;
  }
  return syncDiscordMember(env, run, { ...memberFrom(member.discordId, inServer), cid: member.cid });
}

const NO_ACCOUNT = 'No Discord account or TeamSpeak identity is known for this member.';

export async function discordIdFor(env: RoleSyncEnv, cid: number): Promise<{ id: string; source: 'linked' | 'vatusa' } | null> {
  const linked = (await getUser(env, cid))?.discordId;
  if (linked) return { id: linked, source: 'linked' };
  const latest = await latestRun(env);
  const person = latest?.people.find((candidate) => candidate.cid === cid) ?? (await lookupVatusa(env.KV, { cid }));
  if (!person?.discordId) return null;
  if (latest && sharedDiscordIds(latest.people).has(person.discordId)) return null;
  const holder = await findByDiscordId(env, person.discordId);
  return holder && holder.cid !== cid ? null : { id: person.discordId, source: 'vatusa' };
}

async function queueMemberSync(env: RoleSyncEnv, cid: number): Promise<SyncMemberResult> {
  const account = await discordIdFor(env, cid);
  if (!account) return { queued: false, reason: NO_ACCOUNT };
  await env.ROLE_SYNC_QUEUE.send({ type: 'sync-cid', cid, discordId: account.id });
  await env.KV.put(memberKey(cid), new Date().toISOString(), { expirationTtl: MEMBER_COOLDOWN_SECONDS });
  return { queued: true };
}

const MAX_SYNC_MEMBERS = 100;

export async function syncMembers(env: RoleSyncEnv, cids: number[]): Promise<SyncMembersResult> {
  checkMode(env);
  if (!Array.isArray(cids) || cids.length === 0 || cids.length > MAX_SYNC_MEMBERS) throw new Error(`cids must be a list of 1 to ${MAX_SYNC_MEMBERS} CIDs`);
  for (const cid of cids) if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error(`"${cid}" isn't a CID`);

  const unique = [...new Set(cids)];
  const due: number[] = [];
  const results = new Map<number, SyncMemberResult>();
  for (const cid of unique) {
    if (await env.KV.get(memberKey(cid))) results.set(cid, { queued: false, reason: 'Synced moments ago; try again in a minute.' });
    else due.push(cid);
  }
  for (const config of GROUP_SOURCES) await refreshSource(env, config);
  for (const cid of due) results.set(cid, await queueMemberSync(env, cid));
  return unique.map((cid) => ({ cid, ...results.get(cid)! }));
}

export async function linkDiscord(env: RoleSyncEnv, cid: number, discordId: string, accessToken?: string): Promise<{ joined: boolean }> {
  const mode = checkMode(env);
  if (!SNOWFLAKE.test(discordId)) throw new Error('discordId must be a Discord user ID.');
  const holder = await findByDiscordId(env, discordId);
  if (holder && holder.cid !== cid) throw new Error('That Discord account is linked to another member.');
  const signIn = 'Sign in to flyindycenter.com once before linking.';
  if (!(await getUser(env, cid))) throw new Error(signIn);
  try {
    if (!(await writeDiscordId(env, cid, discordId))) throw new Error(signIn);
  } catch (error) {
    if (error instanceof IdentityConflict) throw new Error('That Discord account is linked to another member.');
    throw error;
  }
  const join = accessToken ? await joinServer(env, mode, discordId, accessToken) : { joined: false };
  await env.ROLE_SYNC_QUEUE.send({ type: 'sync-cid', cid, discordId });
  if (join.failed) throw new Error("Your Discord account is linked, but we couldn't add you to the Indy Center Discord. Ask a staff member for an invite.");
  return { joined: join.joined };
}

async function joinServer(env: RoleSyncEnv, mode: Mode, discordId: string, accessToken: string): Promise<{ joined: boolean; failed?: true }> {
  if (!env.DISCORD_JOIN_BOT_TOKEN) {
    console.warn(`Link Discord: DISCORD_JOIN_BOT_TOKEN isn't set, so ${discordId} was linked without being added to the server`);
    return { joined: false };
  }
  if (mode !== 'live') {
    console.log(`Link Discord (dry run): would add ${discordId} to the server`);
    return { joined: false };
  }
  try {
    const member = await discord<DiscordMember | undefined>(env.DISCORD_JOIN_BOT_TOKEN, 'PUT', `/guilds/${guildId(env)}/members/${discordId}`, { access_token: accessToken });
    return { joined: member !== undefined };
  } catch (error) {
    console.error(`Link Discord: couldn't add ${discordId} to the server: ${error instanceof Error ? error.message : String(error)}`);
    return { joined: false, failed: true };
  }
}

export async function unlink(env: RoleSyncEnv, cid: number, service: 'discord' | 'teamspeak'): Promise<void> {
  checkMode(env);
  if (service === 'teamspeak') throw new Error("TeamSpeak links aren't available yet.");
  await writeDiscordId(env, cid, null);
  await queueMemberSync(env, cid);
}

export async function getLinks(env: RoleSyncEnv, cid: number): Promise<Links> {
  const account = await discordIdFor(env, cid);
  return { discord: account && { id: account.id, source: account.source }, teamspeak: null };
}

async function alertOnce(env: RoleSyncEnv, content: string): Promise<void> {
  console.warn(content);
  await postOnce(env, OUTAGE_KEY, content);
}

function sharedDiscordIds(people: VatusaPerson[]): Set<string> {
  const owners = new Map<string, Set<number>>();
  for (const person of people) {
    if (!person.discordId) continue;
    owners.set(person.discordId, (owners.get(person.discordId) ?? new Set()).add(person.cid));
  }
  return new Set([...owners].filter(([, cids]) => cids.size > 1).map(([id]) => id));
}

async function clearSharedAlerts(env: Pick<RoleSyncEnv, 'KV'>, people: VatusaPerson[]): Promise<void> {
  const shared = sharedDiscordIds(people);
  let cursor: string | undefined;
  do {
    const page = await env.KV.list({ prefix: SHARED_PREFIX, cursor });
    for (const { name } of page.keys) if (!shared.has(name.slice(SHARED_PREFIX.length))) await env.KV.delete(name);
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
}

function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
