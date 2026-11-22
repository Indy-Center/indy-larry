import { findByTeamspeakUid } from '../identity';
import { lookupVatsimRating, lookupVatusa } from '../lookups';
import { MAPPING } from '../mapping';
import type { RoleSyncEnv, RunLists } from '../role-sync';
import { enqueueTsGroups, jobsStore, type TeamSpeakJobsEnv } from '../teamspeak-jobs';
import type { TsResult } from '../teamspeak-shape';
import type { VatusaPerson } from '../vatusa';
import type { Change, Platform } from './platform';

/**
 * The role sync's TeamSpeak adapter: TeamSpeak identities (their unique IDs, UIDs) are its accounts, and
 * the server groups the mapping names (`teamspeakGroupId`) what it sets. It never reaches TeamSpeak itself:
 * teamspeak-bot does, through the jobs store (teamspeak-jobs.ts).
 *
 * The cron asks the bot for its accounts with a `report-accounts` job. Its `accounts` result (on
 * `teamspeak-results`, through receiveAccounts) is kept for an hour and queues one job per UID it names:
 * every identity holding a managed group, and every one connected. Each job resolves its UID through
 * identity's `teamspeak_uid` lookup; a member is synced on every platform they are on by one job a run, so
 * a member Discord's part of the run already lists is left to that job. A member's groups change by a
 * `set-groups` job, in `live` only and only when something differs. A UID no member has linked, or whose
 * member VATUSA and VATSIM don't know, loses every managed group. Admin groups are never in the mapping
 * (mapping.ts refuses them), so never in a change.
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
      /** One member's job by CID, from syncMembers() when they have no Discord account. */
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
// Queues takes at most 100 messages in one sendBatch.
const SEND_BATCH = 100;

type KeptAccounts = { runId: string; groups: Record<string, number[]> };

/** Every group the mapping names: the only ones the sync adds or removes. */
const managedGroups = () => MAPPING.flatMap((entry) => (entry.teamspeakGroupId === undefined ? [] : [entry.teamspeakGroupId]));

export const teamspeakPlatform: Platform<TeamSpeakRef, TeamSpeakAccount, never, TeamSpeakMessage> = {
  name: 'teamspeak',

  async listAccounts(env, _people, runId) {
    const unanswered = await env.KV.get(ASKED_KEY);
    if (unanswered) console.warn(`Role sync: TeamSpeak's part of run ${unanswered} skipped: teamspeak-bot didn't answer report-accounts before the next run`);
    try {
      await jobsStore(env).enqueue({ type: 'report-accounts', groups: managedGroups() });
      await env.KV.put(ASKED_KEY, runId, { expirationTtl: KEEP_SECONDS });
    } catch (error) {
      // TeamSpeak's trouble doesn't hold up the rest of the run.
      await env.KV.delete(ASKED_KEY);
      console.warn(`Role sync: TeamSpeak's part of run ${runId} skipped: couldn't queue report-accounts: ${String(error)}`);
    }
    // Its jobs are queued when the bot answers (receiveAccounts).
    return { run: {}, jobs: () => [] };
  },

  freshRun: async () => ({}),

  owns: (message) => MESSAGE_TYPES.includes(message.type),

  jobOf: (message) => ({ accountId: `TeamSpeak ${message.uid}`, ...(message.type === 'ts-sync-cid' ? { cid: message.cid } : { runId: message.runId }) }),

  async accountOf(env, _mode, message) {
    // The run's result is the newest word on what it holds: the bot answers only when asked.
    if (message.type === 'ts-run-account') return { uid: message.uid, groups: message.groups };
    return currentAccount(env, message.uid);
  },

  async accountFor(_env, _cid, member) {
    const uid = (await member.identity())?.teamspeakUid;
    return uid ? { uid } : null;
  },

  current: (env, ref) => currentAccount(env, ref.uid),
  messageFor: (cid, ref) => ({ type: 'ts-sync-cid', cid, uid: ref.uid }),
  linkOf: (ref) => ({ uid: ref.uid }),

  async unlink() {
    throw new Error("TeamSpeak links aren't available yet.");
  },

  async resolve(env, run, account) {
    // The UID's link in identity is the only way to a member.
    const user = await findByTeamspeakUid(env, account.uid);
    if (!user) return { kind: 'unresolved' };
    const person = await personFor(env, run, user.cid);
    return person ? { kind: 'person', person, identity: user } : { kind: 'unresolved' };
  },

  held: (account) => account.groups.map(String),
  idOf: (entry) => (entry.teamspeakGroupId === undefined ? undefined : String(entry.teamspeakGroupId)),
  // Admin groups can't be in the mapping, so nothing the mapping names is off limits.
  skipped: () => [],
  apply: applyTeamSpeak,
};

/**
 * Queue one `set-groups` job with the change (`live`, and only when there is one), or log what it would be
 * (`dry-run`), then log one line for the identity.
 */
async function applyTeamSpeak(env: RoleSyncEnv, change: Change<TeamSpeakAccount, never>): Promise<void> {
  const { mode, account, resolution, add, remove } = change;
  const label = mode === 'live' ? 'live' : 'dry run';
  const names = (entries: typeof add) => entries.map((entry) => entry.name).join(', ') || 'nothing';
  if (resolution.kind === 'left-alone') {
    console.log(`Role sync (${label}): TeamSpeak ${account.uid}: left alone`);
    return;
  }
  if (mode === 'live' && (add.length > 0 || remove.length > 0)) {
    await enqueueTsGroups(env, account.uid, add.map((entry) => entry.teamspeakGroupId!), remove.map((entry) => entry.teamspeakGroupId!));
  }
  const who = resolution.kind === 'person' ? `CID ${resolution.person.cid}: add ${names(add)};` : 'unresolved:';
  console.log(`Role sync (${label}): TeamSpeak ${account.uid} ${who} remove ${names(remove)}`);
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
async function personFor(env: Pick<RoleSyncEnv, 'KV'>, run: RunLists, cid: number): Promise<VatusaPerson | null> {
  const person = run.people.find((candidate) => candidate.cid === cid) ?? (await lookupVatusa(env.KV, { cid }));
  if (person) return person;
  const vatsim = await lookupVatsimRating(env.KV, cid);
  if (!vatsim) return null;
  return { cid, discordId: null, rating: vatsim.rating, ratingShort: vatsim.ratingShort, facility: '', rosters: [], roles: [], name: null };
}

/**
 * teamspeak-bot's answer to the run's `report-accounts` job (the `teamspeak-results` consumer): keep each
 * identity's groups for the run, and queue one job per UID it names. An answer no run is waiting for (a
 * second answer, or one after its run was skipped) is logged and dropped.
 */
export async function receiveAccounts(env: Pick<RoleSyncEnv, 'KV' | 'ROLE_SYNC_QUEUE'>, result: Extract<TsResult, { type: 'accounts' }>): Promise<void> {
  const runId = await env.KV.get(ASKED_KEY);
  if (!runId) {
    console.warn('Role sync: teamspeak-bot sent its accounts, but no run is waiting for them; ignored');
    return;
  }
  const groups: Record<string, number[]> = {};
  for (const holder of result.holders) groups[holder.uid] = holder.groups;
  await env.KV.put(ACCOUNTS_KEY, JSON.stringify({ runId, groups } satisfies KeptAccounts), { expirationTtl: KEEP_SECONDS });
  await env.KV.delete(ASKED_KEY);

  const uids = [...new Set([...result.holders.map((holder) => holder.uid), ...result.connected])];
  const jobs = uids.map((uid) => ({ body: { type: 'ts-run-account' as const, runId, uid, groups: groups[uid] ?? [] } }));
  for (let i = 0; i < jobs.length; i += SEND_BATCH) await env.ROLE_SYNC_QUEUE.sendBatch(jobs.slice(i, i + SEND_BATCH));
  console.log(`Role sync run ${runId}: teamspeak-bot reported ${result.holders.length} identities holding a managed group and ${result.connected.length} connected; queued ${jobs.length}`);
}
