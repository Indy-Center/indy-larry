import { findByTeamspeakUid, getUser, writeTeamspeakUid } from '../identity';
import { lookupVatsimRating, lookupVatusa, vatsimOnlyPerson } from '../lookups';
import { MAPPING } from '../mapping';
import { sendInBatches } from '../queues';
import type { RoleSyncEnv } from '../role-sync';
import { enqueueTeamSpeakGroups, jobsStore, type TeamSpeakJobsEnv } from '../teamspeak-jobs';
import type { TeamSpeakResult } from '../teamspeak-shape';
import type { VatusaPerson } from '../vatusa';
import { checkMode, type Change, type Mode, type Platform } from './platform';

/**
 * The role sync's TeamSpeak adapter: TeamSpeak identities (their unique IDs, UIDs) are its accounts, and
 * the server groups the mapping names (`teamspeakGroupId`) what it sets. It never reaches TeamSpeak itself:
 * teamspeak-bot does, through the jobs store (teamspeak-jobs.ts).
 *
 * The cron asks the bot for its accounts with a `report-accounts` job. Its `accounts` result (on
 * `teamspeak-results`, through receiveAccounts) is kept for an hour and queues one job per UID it names:
 * every identity holding a managed group, and every one connected. Each job resolves its UID through
 * identity's `teamspeak_uid` lookup, whatever Discord's part of the run does. A member's groups change by a
 * `set-groups` job, in `live` only and only when something differs. A UID no member has linked, or whose
 * member VATUSA and VATSIM don't know, loses every managed group. Admin groups are never in the mapping
 * (mapping.ts refuses them), so never in a change.
 *
 * A link is made only from the bot's private message (platforms/teamspeak-links.ts). unlink() takes every
 * managed group from the UID before clearing it.
 */

/** The role-sync queue's TeamSpeak messages. */
export type TeamSpeakMessage =
  | {
      /** One identity's job from a run's `accounts` result, with the groups the result gave it. */
      type: 'ts-run-account';
      runId: string;
      uid: string;
      groups: number[];
    }
  | {
      /** One member's job by CID: syncMembers(), a connect, a link write. */
      type: 'ts-sync-cid';
      cid: number;
      uid: string;
    };

const MESSAGE_TYPES: string[] = ['ts-run-account', 'ts-sync-cid'] satisfies TeamSpeakMessage['type'][];

export type TeamSpeakPlatformEnv = TeamSpeakJobsEnv;

/** A TeamSpeak identity as the sync takes it: the server groups it holds. */
export type TeamSpeakAccount = { uid: string; groups: number[] };
export type TeamSpeakRef = { uid: string };

/** The run whose `report-accounts` job is waiting for its answer. */
const ASKED_KEY = 'role-sync:teamspeak:asked';
/** The latest `accounts` result: each listed UID's server groups, and the run that asked for it. */
const ACCOUNTS_KEY = 'role-sync:teamspeak:accounts';
// As long as a run's lists are kept.
const KEEP_SECONDS = 60 * 60;

/** `expiresAt` (ms) is kept so a patch after a queued change doesn't extend the report's life. */
type KeptAccounts = { runId: string; groups: Record<string, number[]>; expiresAt?: number };

/** Every group the mapping names: the only ones the sync adds or removes. */
const managedGroups = () => MAPPING.flatMap((entry) => (entry.teamspeakGroupId === undefined ? [] : [entry.teamspeakGroupId]));

/** TeamSpeak's part of a run: nothing read once; its accounts come with the bot's answer. */
type TeamSpeakRun = Record<string, never>;

type TeamSpeakTypes = { ref: TeamSpeakRef; account: TeamSpeakAccount; found: never; message: TeamSpeakMessage; run: TeamSpeakRun; id: number };

export const teamspeakPlatform: Platform<TeamSpeakTypes> = {
  name: 'teamspeak',

  async startRun(env, runId) {
    const unanswered = await env.KV.get(ASKED_KEY);
    if (unanswered) console.warn(`Role sync: TeamSpeak's part of run ${unanswered} skipped: teamspeak-bot didn't answer report-accounts before the next run`);
    try {
      // An older one nobody pulled is dropped, so the newest (with the current groups) is the only one waiting.
      await jobsStore(env).enqueueReplacing({ type: 'report-accounts', groups: managedGroups() });
      await env.KV.put(ASKED_KEY, runId, { expirationTtl: KEEP_SECONDS });
    } catch (error) {
      // TeamSpeak's trouble doesn't hold up the rest of the run.
      await env.KV.delete(ASKED_KEY);
      console.warn(`Role sync: TeamSpeak's part of run ${runId} skipped: couldn't queue report-accounts: ${String(error)}`);
    }
    // Its jobs are queued when the bot answers (receiveAccounts).
    return { run: {}, jobs: [] };
  },

  readRun: async () => ({}),

  isOwnMessage: (message): message is TeamSpeakMessage => MESSAGE_TYPES.includes(message.type),

  describeJob: (message) => ({ accountId: `TeamSpeak ${message.uid}`, ...(message.type === 'ts-sync-cid' ? { cid: message.cid } : { runId: message.runId }) }),

  async readAccount(env, _mode, message) {
    // The run's result is the newest word on what it holds: the bot answers only when asked.
    if (message.type === 'ts-run-account') return { uid: message.uid, groups: message.groups };
    return currentAccount(env, message.uid);
  },

  async findAccount(_env, _cid, member) {
    const uid = (await member.identity())?.teamspeakUid;
    return uid ? { uid } : null;
  },

  messageFor: (cid, ref) => ({ type: 'ts-sync-cid', cid, uid: ref.uid }),
  linkOf: (ref) => ({ uid: ref.uid }),

  async unlink(env, cid) {
    // The identity loses its groups first: once the link is cleared, nothing points the sync at it.
    const uid = (await getUser(env, cid))?.teamspeakUid;
    if (uid) await removeManagedGroups(env, checkMode(env), uid);
    await writeTeamspeakUid(env, cid, null);
  },

  async resolve(env, run, account) {
    // The UID's link in identity is the only way to a member.
    const user = await findByTeamspeakUid(env, account.uid);
    if (!user) return { kind: 'unresolved' };
    const person = await personFor(env, run.people, user.cid);
    return person ? { kind: 'person', person, identity: user } : { kind: 'unresolved' };
  },

  heldIds: (account) => account.groups,
  idFor: (entry) => entry.teamspeakGroupId,
  // Admin groups can't be in the mapping, so nothing the mapping names is off limits.
  untouchable: () => [],
  apply: applyTeamSpeak,
};

/**
 * Queue one `set-groups` job with the change (`live`, and only when there is one), or log what it would be
 * (`dry-run`), then log one line for the identity.
 */
async function applyTeamSpeak(env: RoleSyncEnv, change: Change<TeamSpeakTypes>): Promise<void> {
  const { mode, account, resolution, add, remove } = change;
  const label = mode === 'live' ? 'live' : 'dry run';
  const names = (entries: typeof add) => entries.map((entry) => entry.name).join(', ') || 'nothing';
  if (resolution.kind === 'left-alone') {
    console.log(`Role sync (${label}): TeamSpeak ${account.uid}: left alone`);
    return;
  }
  if (mode === 'live' && (add.length > 0 || remove.length > 0)) {
    await queueGroups(env, account.uid, add.map((entry) => entry.teamspeakGroupId!), remove.map((entry) => entry.teamspeakGroupId!));
  }
  const who = resolution.kind === 'person' ? `CID ${resolution.person.cid}: add ${names(add)};` : 'unresolved:';
  console.log(`Role sync (${label}): TeamSpeak ${account.uid} ${who} remove ${names(remove)}`);
}

/**
 * Take every group the mapping names from a TeamSpeak identity that is losing its link (an unlink, or a
 * relink to another UID): one `set-groups` job in `live`, logged in `dry-run`, as the sync's own changes are.
 */
export async function removeManagedGroups(env: TeamSpeakJobsEnv & Pick<RoleSyncEnv, 'KV'>, mode: Mode, uid: string): Promise<void> {
  if (mode !== 'live') {
    console.log(`Link TeamSpeak (dry run): would remove every managed group from TeamSpeak ${uid}`);
    return;
  }
  await queueGroups(env, uid, [], managedGroups());
  console.log(`Link TeamSpeak (live): removing every managed group from TeamSpeak ${uid}`);
}

/**
 * Take the managed groups a TeamSpeak identity no member holds is in, when it connects: the ones the
 * latest `accounts` result names for it, or every managed group when no result is kept. Nothing when it
 * holds none. One `set-groups` job in `live`, logged in `dry-run`.
 */
export async function removeHeldManagedGroups(env: TeamSpeakJobsEnv & Pick<RoleSyncEnv, 'KV'>, mode: Mode, uid: string): Promise<void> {
  const kept = await env.KV.get<KeptAccounts>(ACCOUNTS_KEY, 'json');
  const managed = managedGroups();
  const held = kept ? (kept.groups[uid] ?? []).filter((group) => managed.includes(group)) : managed;
  if (held.length === 0) return;
  if (mode !== 'live') {
    console.log(`Link TeamSpeak (dry run): would remove groups ${held.join(', ')} from unlinked TeamSpeak ${uid}`);
    return;
  }
  await queueGroups(env, uid, [], held);
  console.log(`Link TeamSpeak (live): removing groups ${held.join(', ')} from unlinked TeamSpeak ${uid}`);
}

/**
 * Queue a `set-groups` job, and make the kept `accounts` result show the groups it leaves the identity
 * with. Otherwise a sync before the next run compares against groups larry has already queued away (a
 * member stripped on an unlinked connect who then links would be "add nothing"). Best effort: the next
 * run's result replaces it whatever happens here.
 */
async function queueGroups(env: TeamSpeakJobsEnv & Pick<RoleSyncEnv, 'KV'>, uid: string, add: number[], remove: number[]): Promise<void> {
  await enqueueTeamSpeakGroups(env, uid, add, remove);
  const kept = await env.KV.get<KeptAccounts>(ACCOUNTS_KEY, 'json');
  if (!kept) return;
  const left = (kept.groups[uid] ?? []).filter((group) => !remove.includes(group));
  const groups = { ...kept.groups, [uid]: [...left, ...add.filter((group) => !left.includes(group))] };
  // KV wants an expiry at least 60 s ahead; a report closer to its end than that is left to expire.
  const expiresAt = kept.expiresAt ?? Date.now() + KEEP_SECONDS * 1000;
  if (expiresAt - Date.now() < 60_000) return;
  await env.KV.put(ACCOUNTS_KEY, JSON.stringify({ ...kept, groups, expiresAt } satisfies KeptAccounts), { expiration: Math.floor(expiresAt / 1000) });
}

/**
 * The identity's groups by the latest `accounts` result: a UID it doesn't name (just linked, never
 * connected) holds no managed group. Null (logged) when no result is kept, so TeamSpeak waits.
 */
async function currentAccount(env: Pick<RoleSyncEnv, 'KV'>, uid: string): Promise<TeamSpeakAccount | null> {
  const kept = await env.KV.get<KeptAccounts>(ACCOUNTS_KEY, 'json');
  if (!kept) {
    console.log(`Role sync: no TeamSpeak accounts are kept from a recent run; TeamSpeak ${uid} waits for the next one`);
    return null;
  }
  return { uid, groups: kept.groups[uid] ?? [] };
}

/** Who a linked CID is: VATUSA's record (the run's lists, else its per-user lookup), else their VATSIM rating; null when neither knows them. */
async function personFor(env: Pick<RoleSyncEnv, 'KV'>, people: VatusaPerson[], cid: number): Promise<VatusaPerson | null> {
  const person = people.find((candidate) => candidate.cid === cid) ?? (await lookupVatusa(env.KV, { cid }));
  if (person) return person;
  const vatsim = await lookupVatsimRating(env.KV, cid);
  return vatsim ? vatsimOnlyPerson(cid, vatsim) : null;
}

/**
 * teamspeak-bot's answer to the run's `report-accounts` job (the `teamspeak-results` consumer): keep each
 * identity's groups for the run, and queue one job per UID it names. An answer no run is waiting for (a
 * second answer, or one after its run was skipped) is logged and dropped.
 */
export async function receiveAccounts(env: Pick<RoleSyncEnv, 'KV' | 'ROLE_SYNC_QUEUE'>, result: Extract<TeamSpeakResult, { type: 'accounts' }>): Promise<void> {
  const runId = await env.KV.get(ASKED_KEY);
  if (!runId) {
    console.warn('Role sync: teamspeak-bot sent its accounts, but no run is waiting for them; ignored');
    return;
  }
  const groups: Record<string, number[]> = {};
  for (const holder of result.holders) groups[holder.uid] = holder.groups;
  const expiresAt = Date.now() + KEEP_SECONDS * 1000;
  await env.KV.put(ACCOUNTS_KEY, JSON.stringify({ runId, groups, expiresAt } satisfies KeptAccounts), { expirationTtl: KEEP_SECONDS });
  await env.KV.delete(ASKED_KEY);

  const uids = [...new Set([...result.holders.map((holder) => holder.uid), ...result.connected])];
  const jobs = uids.map((uid) => ({ type: 'ts-run-account' as const, runId, uid, groups: groups[uid] ?? [] }));
  await sendInBatches(env.ROLE_SYNC_QUEUE, jobs);
  console.log(`Role sync run ${runId}: teamspeak-bot reported ${result.holders.length} identities holding a managed group and ${result.connected.length} connected; queued ${jobs.length}`);
}
