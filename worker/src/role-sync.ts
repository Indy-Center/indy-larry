import { postOnce, type AlertEnv } from './alerts';
import type { Links, SyncMemberResult, SyncMembersResult } from './client/api';
import { rolesFor } from './criteria';
import { discord, guildId, SNOWFLAKE, type GuildEnv } from './discord';
import { GROUP_SOURCES, type GroupSourcesEnv } from './group-sources';
import { groupChanges, refreshSource, syncGroups, type GroupChanges } from './groups';
import { findByDiscordId, getUser, IdentityConflict, writeDiscordId, type IdentityEnv, type IdentityUser } from './identity';
import { lookupVatsimRating, lookupVatusa } from './lookups';
import { MAPPING } from './mapping';
import { nicknameFor } from './nickname-rule';
import { applyNickname, nicknameGuard, type NicknameGuard, type NicknameOutcome } from './nicknames';
import { getMember, listMembers, syncRefusal, type DiscordMember, type DiscordRole } from './roles';
import type { SendEnv } from './send';
import { fetchLists, peopleFrom, type VatusaPerson } from './vatusa';

/**
 * The role sync, Discord half: makes each member's Discord roles match what VATUSA's lists say,
 * through the mapping (mapping.ts), and sets their nickname (nickname-rule.ts). Only roles the mapping
 * names are ever added or removed.
 *
 * A member the sources confirm are no one (unresolved: see resolvePerson) loses every mapped role they
 * hold, as with VATUSA's bot; a lookup that fails throws instead, so the job retries and removes nothing.
 * Bot accounts are left alone.
 *
 * Every 15 minutes the cron (startRoleSync) fetches the lists once, keeps them in KV for that run, and
 * queues one job per Discord member on `role-sync`. A member who joins the server is queued straight
 * away (`sync-member`, from larry's bot through bot-events.ts) and synced against the latest run's
 * lists, or the per-user lookups when no run's lists are kept. The consumer (consumeRoleSync) hands each job to syncDiscordMember. `ROLE_SYNC_MODE` says what
 * that does: `dry-run` logs what it would change and changes nothing; `live` changes it. A Discord
 * failure fails that member's job, so the queue retries it.
 *
 * A member's Discord link lives in identity and is read through identity.ts: a Discord account that is
 * someone's link takes that CID, whatever VATUSA says. syncMembers() and the link writes queue one
 * member's job by CID (`sync-cid`).
 *
 * Every job also gives and takes the roles of the groups apps serve (groups.ts), from each source's
 * latest copy as it stands when the job runs, under that source's mode as well as `ROLE_SYNC_MODE`.
 */

/** Every message on the `role-sync` queue. Each new kind of job is a new member of this union. */
export type RoleSyncMessage =
  | {
      /**
       * One member's job from a cron run, with the roles and nickname they had when the run listed the
       * server. `live` reads them again before changing anything.
       */
      type: 'run-member';
      runId: string;
      discordId: string;
      roleIds: string[];
      nick?: string | null;
      /** A Discord bot account, which the sync leaves alone. */
      bot?: boolean;
    }
  | {
      /** One member, now: someone joined the server (larry's bot, POST /bot/events). */
      type: 'sync-member';
      discordId: string;
    }
  | {
      /** One member's job by CID, from syncMembers() and the link writes. Their roles are read when it runs. */
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
    /** `dry-run` (the default): log what would change, change nothing. `live`: change it. */
    ROLE_SYNC_MODE?: string;
  };

/** What a run read from the server once: the mapped roles it skips, and who it won't rename. */
export type RunServer = { skippedRoles: string[]; guard: NicknameGuard };

/** The lists a run fetched, as kept in KV for that run's jobs. */
export type RunLists = { people: VatusaPerson[]; server: RunServer };

type Mode = 'dry-run' | 'live';

/** Set while a skipped run's alert stands, so an outage is posted once, not every 15 minutes. */
const OUTAGE_KEY = 'role-sync:outage';
/** Set while a shared Discord ID's alert stands, so it is posted once per ID until a run no longer finds it shared. */
const SHARED_PREFIX = 'role-sync:shared:';
const runKey = (runId: string) => `role-sync:run:${runId}`;
/** The newest run's ID, so a job that has no run of its own (sync-member, sync-cid) can read that run's lists. */
const LATEST_RUN_KEY = 'role-sync:latest-run';
/** Set when a member's sync is queued by syncMembers(), so the profile buttons can't flood the queue. */
const memberKey = (cid: number) => `role-sync:member:${cid}`;
const MEMBER_COOLDOWN_SECONDS = 120;
// Long past the time a run's jobs take; a job whose lists have gone is left to the next run.
const RUN_LISTS_TTL_SECONDS = 60 * 60;
// Queues takes at most 100 messages in one sendBatch.
const SEND_BATCH = 100;

function checkMode(env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE'>): Mode {
  const mode = env.ROLE_SYNC_MODE ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'live') throw new Error(`ROLE_SYNC_MODE "${mode}" isn't supported; use dry-run or live`);
  return mode;
}

/**
 * Read the server once for a run: its roles, its owner and Larry's own roles. A mapped role the sync
 * won't touch is skipped for the whole run, with one log line: @everyone, a bot's role, and any role at
 * or above Larry's highest, which Discord wouldn't let Larry change anyway. So is a mapped role that
 * isn't on the server, which Discord would refuse (404) for every member due it.
 */
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
      // Discord would answer 404 for every job that gives it. Skipped for resolved and unresolved members alike.
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

/**
 * The cron: fetch VATUSA's lists, make the groups' roles and rooms (groups.ts), then queue one job per
 * Discord member. A bad VATUSA fetch skips the run; a group source's trouble skips only its groups.
 */
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

/** The `role-sync` consumer. A job that throws (a Discord failure included) is retried, then parked in role-sync-dlq. */
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
            // The run listed the server minutes ago: before changing anything, read what they hold now.
            const now = mode === 'live' ? await getMember(env.DISCORD_TOKEN, guildId(env), job.discordId) : { roles: job.roleIds, nick: job.nick, user: { id: job.discordId, bot: job.bot } };
            if (!now) console.log(`Role sync: ${job.discordId} isn't in the server`);
            else await syncDiscordMember(env, run, memberFrom(job.discordId, now));
          }
          break;
        }
        case 'sync-member':
          // A join: the latest run's lists if one is kept (else the per-user lookups), and the roles the member holds now.
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

/**
 * What the sync makes of one member: their CID (null when unresolved), the mapped roles to change, by
 * name, and what happened to their nickname (null when it is left as it is).
 */
export type MemberSync = { discordId: string; cid: number | null; add: string[]; remove: string[]; nickname: NicknameOutcome | null };

/** A Discord member as syncDiscordMember takes them: what they hold now. */
type SyncTarget = { discordId: string; roleIds: string[]; nick: string | null; cid?: number; bot?: boolean };

function memberFrom(discordId: string, held: DiscordMember): SyncTarget {
  return { discordId, roleIds: held.roles, nick: held.nick ?? null, bot: held.user?.bot === true };
}

/**
 * Sync one Discord member: find their CID, work out their mapped roles and nickname, and change them
 * (`live`) or log what would change (`dry-run`). `roleIds` and `nick` are what they hold now. The one
 * place a member is synced, whatever asked for it. Throws when Discord refuses a change.
 */
async function syncDiscordMember(env: RoleSyncEnv, run: RunLists, member: SyncTarget): Promise<MemberSync> {
  const mode = checkMode(env);
  const label = mode === 'live' ? 'live' : 'dry run';
  const result: MemberSync = { discordId: member.discordId, cid: null, add: [], remove: [], nickname: null };
  if (member.bot) {
    // As VATUSA's bot does: a bot account is never looked up, and keeps its roles.
    console.log(`Role sync (${label}): ${member.discordId} is a bot account: left alone`);
    return result;
  }

  const found = await resolvePerson(env, run, member);
  if (found.kind === 'shared-id') await reportSharedId(env, member.discordId, found.sharedCids);
  const person = found.kind === 'person' ? found.person : null;
  result.cid = person?.cid ?? null;

  const addIds: string[] = [];
  const removeIds: string[] = [];
  // A confirmed "no one" wants no mapped role, so loses every one they hold. A lookup that failed has
  // already thrown. An account another member has linked isn't no one: its own job syncs it.
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

  // The groups' roles, the same way: an account another member has linked is left to its own job.
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

/** The log line's account of a member's group roles, per source, when any would change. */
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

/** The log line's account of a member: who they are, and what the sync changes. */
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

/** One Discord ID on more than one CID: log it, and tell the tech team once until a run no longer finds it shared. */
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

/**
 * The identity user whose names the nickname reads. resolvePerson has already asked identity when it
 * looked for the member's link (`known`, undefined when it didn't); otherwise this asks by CID. Identity
 * failing here doesn't fail the job: the nickname falls back to VATUSA's name, and it is logged.
 */
async function identityForNickname(env: IdentityEnv, cid: number, discordId: string, known: IdentityUser | null | undefined): Promise<IdentityUser | null> {
  if (known !== undefined) return known;
  try {
    return await getUser(env, cid);
  } catch (error) {
    console.warn(`Role sync: couldn't reach identity for ${discordId}'s name; using VATUSA's name: ${String(error)}`);
    return null;
  }
}

/**
 * Who a Discord member is, from the cheapest source up. A CID given, or the CID whose identity link is
 * this Discord account, is looked for on the lists; otherwise their CID is the one whose VATUSA Discord ID
 * is theirs, and two CIDs claiming it is no answer. A VATUSA-only match whose CID is linked to a different
 * Discord account is a stale account and gets nothing. Off the lists, VATUSA's per-user lookup; for a CID
 * VATUSA doesn't know, only their rating from VATSIM. Every kind but `person` is unresolved, which the
 * caller takes as a confirmed "no one": every lookup that fails (anything but a 404) throws instead.
 */
type Resolution =
  /** `identity` is the identity user the lookup found for them (undefined when it didn't ask identity). */
  | { kind: 'person'; person: VatusaPerson; identity?: IdentityUser | null }
  | { kind: 'no-one' }
  /** VATUSA gives this Discord ID to every one of `sharedCids`. */
  | { kind: 'shared-id'; sharedCids: number[] }
  /** Found by VATUSA's Discord ID, but their CID has linked a different account: this one is stale. */
  | { kind: 'linked-elsewhere' }
  /** Another member has linked this account in identity: its own job syncs it. */
  | { kind: 'account-taken' };

/** identity's answer to "whose link is this account?", or the error when it couldn't answer. */
type LinkAnswer = { holder: IdentityUser | null } | { holder: null; unreachable: unknown };

async function resolvePerson(env: Pick<RoleSyncEnv, 'KV'> & IdentityEnv, run: RunLists, member: { discordId: string; cid?: number }): Promise<Resolution> {
  // A CID was given (a link write, syncMembers) and its account was settled when the job was queued. Look
  // again for the race (another member linked it since); if identity can't answer now, go on with the job.
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
    // Found by Discord ID alone: if their CID has linked a different account, this one is stale.
    const user = await getUser(env, person.cid);
    if (user?.discordId && user.discordId !== member.discordId) return { kind: 'linked-elsewhere' };
    return { kind: 'person', person, identity: user };
  }
  if (cid === undefined) return { kind: 'no-one' };

  const vatsim = await lookupVatsimRating(env.KV, cid);
  if (!vatsim) {
    // Unresolved loses its roles, so don't settle on it while identity's answer is missing: the
    // account may be another member's link. Retry instead.
    if ('unreachable' in link) throw link.unreachable;
    return { kind: 'no-one' };
  }
  return {
    kind: 'person',
    person: { cid, discordId: member.discordId, rating: vatsim.rating, ratingShort: vatsim.ratingShort, facility: '', rosters: [], roles: [], name: null },
    identity,
  };
}

/** The newest run's lists, while they are kept. */
async function latestRun(env: Pick<RoleSyncEnv, 'KV'>): Promise<RunLists | null> {
  const latestId = await env.KV.get(LATEST_RUN_KEY);
  return latestId ? await env.KV.get<RunLists>(runKey(latestId), 'json') : null;
}

/**
 * The lists a single member's job reads, which has no run of its own: the newest run's if it is still
 * kept, otherwise no VATUSA lists (the per-user lookups cover the member).
 */
export async function runListsForMember(env: RoleSyncEnv): Promise<RunLists> {
  return (await latestRun(env)) ?? { people: [], server: await readServer(env) };
}

/**
 * Sync one Discord member now: read their roles from the server, then hand them to syncDiscordMember.
 * `cid` is given when it is already known. Null when they aren't in the server.
 */
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

/**
 * The Discord account to sync for a CID, by the role sync's rule: their identity link, else the VATUSA
 * Discord ID (from the lists, else VATUSA's per-user lookup), unless another member has linked that
 * account or the lists give it to more than one CID.
 */
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

/** The most CIDs one syncMembers() call takes. */
const MAX_SYNC_MEMBERS = 100;

/**
 * RPC: sync these members now. Reads every group source again first (groups.ts), so their jobs see what
 * the app has just changed, then queues each CID's job. At most once every 2 minutes per member; a
 * declined member still gets the fresh read, which a job of theirs that hasn't run yet picks up.
 */
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

/** RPC: link a Discord account to a member in identity, and queue their sync. */
export async function linkDiscord(env: RoleSyncEnv, cid: number, discordId: string): Promise<void> {
  checkMode(env);
  if (!SNOWFLAKE.test(discordId)) throw new Error('discordId must be a Discord user ID.');
  const holder = await findByDiscordId(env, discordId);
  if (holder && holder.cid !== cid) throw new Error('That Discord account is linked to another member.');
  const signIn = 'Sign in to flyindycenter.com once before linking.';
  if (!(await getUser(env, cid))) throw new Error(signIn);
  try {
    if (!(await writeDiscordId(env, cid, discordId))) throw new Error(signIn);
  } catch (error) {
    // Someone linked it between the check and the write.
    if (error instanceof IdentityConflict) throw new Error('That Discord account is linked to another member.');
    throw error;
  }
  await env.ROLE_SYNC_QUEUE.send({ type: 'sync-cid', cid, discordId });
}

/** RPC: clear a link, then queue the sync of the account the member falls back to, if any. */
export async function unlink(env: RoleSyncEnv, cid: number, service: 'discord' | 'teamspeak'): Promise<void> {
  checkMode(env);
  if (service === 'teamspeak') throw new Error("TeamSpeak links aren't available yet.");
  await writeDiscordId(env, cid, null);
  await queueMemberSync(env, cid);
}

/** RPC: which Discord account is in use for a member, and where it came from. */
export async function getLinks(env: RoleSyncEnv, cid: number): Promise<Links> {
  const account = await discordIdFor(env, cid);
  return { discord: account && { id: account.id, source: account.source }, teamspeak: null };
}

/** Post to the tech team once per outage. If the post fails, the next skipped run tries again. */
async function alertOnce(env: RoleSyncEnv, content: string): Promise<void> {
  console.warn(content);
  await postOnce(env, OUTAGE_KEY, content);
}

/** The Discord IDs VATUSA's lists give to more than one CID. */
function sharedDiscordIds(people: VatusaPerson[]): Set<string> {
  const owners = new Map<string, Set<number>>();
  for (const person of people) {
    if (!person.discordId) continue;
    owners.set(person.discordId, (owners.get(person.discordId) ?? new Set()).add(person.cid));
  }
  return new Set([...owners].filter(([, cids]) => cids.size > 1).map(([id]) => id));
}

/** A run that no longer finds a Discord ID shared forgets its alert, so a recurrence posts again. */
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
