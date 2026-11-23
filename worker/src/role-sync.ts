import { postOnce } from './alerts';
import type { Links, SyncMemberResult, SyncMembersResult } from './client/api';
import { rolesFor } from './criteria';
import type { GuildEnv } from './discord';
import { GROUP_SOURCES, type GroupSourcesEnv } from './group-sources';
import { refreshSource } from './groups';
import { getUser, type IdentityEnv, type IdentityUser } from './identity';
import { MAPPING, type MappingEntry } from './mapping';
import { discordPlatform, type DiscordMessage, type DiscordPlatformEnv } from './platforms/discord';
import { checkMode, type AnyPlatform, type JobRun, type MemberLookups, type Mode, type Resolution } from './platforms/platform';
import { teamspeakPlatform, type TeamSpeakMessage, type TeamSpeakPlatformEnv } from './platforms/teamspeak';
import { consumeEach, sendInBatches } from './queues';
import type { SendEnv } from './send';
import { fetchLists, peopleFrom, type VatusaPerson } from './vatusa';

/**
 * The role sync: makes each member's roles on every platform match what VATUSA's lists say, through the
 * mapping (mapping.ts). This file is the shared part: the cron, the queue, the RPCs, the run's lists, and
 * the job, which works out which mapping entries an account's member matches. Everything about one
 * platform (finding, reading and writing its accounts, its guards and extras such as Discord's nickname)
 * is its adapter's, in platforms/ (the seam is platforms/platform.ts), registered in PLATFORMS.
 *
 * **Each platform on its own.** A job is one account on one platform, and nothing in it waits on, reads or
 * writes another platform: a member on both platforms has a job on each. One platform's failure (its run
 * part, its lookups, its writes) never holds up the other's.
 *
 * Every 15 minutes the cron (startRoleSync) fetches the lists once, keeps them in KV for that run, and
 * starts each platform's part of the run, which queues one job per account it lists (TeamSpeak's when its
 * bot answers). Other jobs come from the bots (a member who joins the Discord server, through
 * bot-events.ts; a member who connects to TeamSpeak), from syncMembers() and from the link writes. The
 * consumer (consumeRoleSync) hands each job to the adapter whose message it is, which reads the account,
 * and then to syncAccount. `ROLE_SYNC_MODE` says what that does: `dry-run` logs what it would change and
 * changes nothing; `live` changes it. A platform's failure fails that job, so the queue retries it.
 */

/** Every message on the `role-sync` queue: each platform's. Each new kind of job is a new member of this union. */
export type RoleSyncMessage = DiscordMessage | TeamSpeakMessage;

export type RoleSyncEnv = GuildEnv &
  Pick<SendEnv, 'SEND_CHANNELS' | 'LARRY_QUEUE'> &
  IdentityEnv &
  GroupSourcesEnv &
  DiscordPlatformEnv &
  TeamSpeakPlatformEnv & {
    KV: KVNamespace;
    ROLE_SYNC_QUEUE: Queue<RoleSyncMessage>;
    /** `dry-run` (the default): log what would change, change nothing. `live`: change it. */
    ROLE_SYNC_MODE?: string;
  };

/** A run as kept in KV for its jobs: VATUSA's lists, and each platform's part of the run, by name, for the platforms that started one. */
export type RunRecord = { people: VatusaPerson[]; platforms: Partial<Record<keyof Links, unknown>> };

/** The registered platform adapters, the one place a platform is added or removed. The consumer hands each message to the adapter that owns it. */
const PLATFORMS: AnyPlatform[] = [discordPlatform, teamspeakPlatform];

/** Set while a skipped run's alert stands, so an outage is posted once, not every 15 minutes. */
const OUTAGE_KEY = 'role-sync:outage';
const runKey = (runId: string) => `role-sync:run:${runId}`;
/** The newest run's ID, so a job that has no run of its own (sync-member, sync-cid, ts-sync-cid) can read that run's lists. */
const LATEST_RUN_KEY = 'role-sync:latest-run';
/** Set when syncMembers() queues a member's sync, so the profile buttons can't flood the queue. */
const memberKey = (cid: number) => `role-sync:member:${cid}`;
const MEMBER_COOLDOWN_SECONDS = 120;
// Long past the time a run's jobs take; a job whose lists have gone is left to the next run.
const RUN_LISTS_TTL_SECONDS = 60 * 60;

/**
 * The cron: fetch VATUSA's lists, then start each platform's part of the run (`only`: just those, as when
 * teamspeak-bot reconnects) and queue the jobs each lists. A bad VATUSA fetch skips the run. A platform
 * whose part fails doesn't stop the others': their jobs are queued, then the run throws with its error.
 */
export async function startRoleSync(env: RoleSyncEnv, only?: (keyof Links)[]): Promise<void> {
  checkMode(env);
  const fetched = await fetchLists();
  if ('failed' in fetched) {
    await alertOnce(env, `Role sync skipped: couldn't fetch ${joinNames(fetched.failed)} from VATUSA.`);
    return;
  }
  await env.KV.delete(OUTAGE_KEY);
  const people = peopleFrom(fetched.lists);

  const runId = crypto.randomUUID();
  const record: RunRecord = { people, platforms: {} };
  const jobs: RoleSyncMessage[] = [];
  const failed: string[] = [];
  for (const platform of PLATFORMS.filter((candidate) => !only || only.includes(candidate.name))) {
    try {
      const started = await platform.startRun(env, runId, people);
      record.platforms[platform.name] = started.run;
      jobs.push(...started.jobs);
    } catch (error) {
      console.error(`Role sync run ${runId}: ${platform.name}'s part failed: ${String(error)}`);
      failed.push(`${platform.name}: ${String(error)}`);
    }
  }
  await env.KV.put(runKey(runId), JSON.stringify(record), { expirationTtl: RUN_LISTS_TTL_SECONDS });
  await env.KV.put(LATEST_RUN_KEY, runId, { expirationTtl: RUN_LISTS_TTL_SECONDS });
  await sendInBatches(env.ROLE_SYNC_QUEUE, jobs);
  console.log(`Role sync run ${runId}: ${people.length} people on VATUSA's lists; queued ${jobs.length} accounts`);
  if (failed.length > 0) throw new Error(`Role sync run ${runId}: ${failed.join('; ')}`);
}

/** The `role-sync` consumer. A job that throws (a platform's failure included) is retried, then parked in role-sync-dlq. */
export async function consumeRoleSync(batch: MessageBatch<RoleSyncMessage>, env: RoleSyncEnv): Promise<void> {
  const mode = checkMode(env);
  const records = new Map<string, Promise<RunRecord | null>>();
  const recordOf = (runId: string) => {
    if (!records.has(runId)) records.set(runId, env.KV.get<RunRecord>(runKey(runId), 'json'));
    return records.get(runId)!;
  };
  await consumeEach(batch, 'Role sync job', (message) => runJob(env, mode, message, recordOf));
}

/**
 * One queue message's job: its run's lists (else the newest run's, else none) and its platform's part of
 * that run (else read now), the account as its adapter reads it now, then syncAccount.
 */
async function runJob(env: RoleSyncEnv, mode: Mode, message: RoleSyncMessage, recordOf: (runId: string) => Promise<RunRecord | null>): Promise<void> {
  const platform = PLATFORMS.find((candidate) => candidate.isOwnMessage(message));
  if (!platform) throw new Error(`Unknown role-sync job type "${(message as { type?: unknown }).type}"`);
  const job = platform.describeJob(message);
  const record = job.runId === undefined ? await latestRecord(env) : await recordOf(job.runId);
  if (job.runId !== undefined && !record) {
    console.warn(`Role sync: run ${job.runId}'s lists have expired; ${job.accountId} waits for the next run`);
    return;
  }
  const kept = record?.platforms[platform.name];
  const run: JobRun<unknown> = { people: record?.people ?? [], platform: kept !== undefined ? kept : await platform.readRun(env) };
  const account = await platform.readAccount(env, mode, message);
  if (account) await syncAccount(env, run, platform, account, job.cid);
}

/**
 * Sync one queue message's account now, without the queue (postToGroup(), so a mentioned member can see
 * the room before the post).
 */
export async function syncNow(env: RoleSyncEnv, message: RoleSyncMessage): Promise<void> {
  const mode = checkMode(env);
  await runJob(env, mode, message, (runId) => env.KV.get<RunRecord>(runKey(runId), 'json'));
}

/**
 * The job, for one account on one platform. The adapter resolves the account to a member (`cid` given when
 * the job knows it), the mapping is matched, and the adapter makes the account match it. An account that
 * resolves to no one loses its managed roles.
 */
export async function syncAccount(env: RoleSyncEnv, run: JobRun<unknown>, platform: AnyPlatform, account: unknown, cid?: number): Promise<void> {
  const mode = checkMode(env);
  const resolution = await platform.resolve(env, run, account, cid);
  const person = resolution.kind === 'person' ? resolution.person : null;
  const member = memberLookups(env, person?.cid ?? null, resolution.kind === 'person' ? resolution.identity : null);
  const { add, remove } = changeFor(platform, run, account, resolution, new Set(person ? rolesFor(person) : []));
  await platform.apply(env, { mode, run, account, resolution, add, remove, identity: member.identity });
}

/** The mapping entries to give and take on one account, past the run's untouchable IDs. */
function changeFor(platform: AnyPlatform, run: JobRun<unknown>, account: unknown, resolution: Resolution<unknown>, wanted: Set<MappingEntry>) {
  const add: MappingEntry[] = [];
  const remove: MappingEntry[] = [];
  if (resolution.kind === 'left-alone') return { add, remove };
  const held: unknown[] = platform.heldIds(account);
  const untouchable: unknown[] = platform.untouchable(run.platform);
  for (const entry of MAPPING) {
    const id = platform.idFor(entry);
    if (id === undefined || untouchable.includes(id)) continue;
    const holds = held.includes(id);
    if (wanted.has(entry) && !holds) add.push(entry);
    if (!wanted.has(entry) && holds) remove.push(entry);
  }
  return { add, remove };
}

/**
 * What a job looks up about one CID: the newest run's lists and their identity record, each read once, on
 * first use. `known` is the identity record already read (undefined: not read). No CID (an account that
 * resolved to no one): no identity record.
 */
export function memberLookups(env: RoleSyncEnv, cid: number | null, known?: IdentityUser | null): MemberLookups {
  let identity: Promise<IdentityUser | null> | undefined = cid === null ? Promise.resolve(null) : known !== undefined ? Promise.resolve(known) : undefined;
  return {
    latestPeople: async () => (await latestRecord(env))?.people ?? null,
    identity: () => (identity ??= getUser(env, cid!)),
  };
}

/** The newest run's record, while it is kept. */
async function latestRecord(env: Pick<RoleSyncEnv, 'KV'>): Promise<RunRecord | null> {
  const latestId = await env.KV.get(LATEST_RUN_KEY);
  return latestId ? await env.KV.get<RunRecord>(runKey(latestId), 'json') : null;
}

const NO_ACCOUNT = 'No Discord account or TeamSpeak identity is known for this member.';

/**
 * Queue a CID's job on each of `platforms` they have an account on. A platform whose account can't be
 * looked up is skipped (logged) and the others still queue; with none queued, its error is thrown.
 */
async function queueMemberSync(env: RoleSyncEnv, cid: number, platforms: AnyPlatform[] = PLATFORMS, member = memberLookups(env, cid)): Promise<SyncMemberResult> {
  let queued = false;
  let failure: unknown;
  for (const platform of platforms) {
    try {
      const ref = await platform.findAccount(env, cid, member);
      if (!ref) continue;
      await env.ROLE_SYNC_QUEUE.send(platform.messageFor(cid, ref));
      queued = true;
    } catch (error) {
      console.warn(`Role sync: couldn't find CID ${cid}'s ${platform.name} account, so it isn't queued there: ${String(error)}`);
      failure ??= error;
    }
  }
  if (queued) return { queued: true };
  if (failure !== undefined) throw failure;
  return { queued: false, reason: NO_ACCOUNT };
}

/** Set when a member's TeamSpeak sync is queued because they connected, so reconnecting doesn't queue another for 5 minutes. */
const connectKey = (cid: number) => `role-sync:connect:${cid}`;
const CONNECT_SECONDS = 5 * 60;

/**
 * A linked member connected to TeamSpeak: queue their TeamSpeak job, unless they were synced in the last 5
 * minutes (by an earlier connect, or by syncMembers(), whose 2-minute mark is memberKey).
 */
export async function syncOnConnect(env: RoleSyncEnv, holder: IdentityUser): Promise<void> {
  const { cid } = holder;
  if ((await env.KV.get(connectKey(cid))) || (await env.KV.get(memberKey(cid)))) {
    console.log(`Role sync: CID ${cid} connected to TeamSpeak; synced in the last 5 minutes, so no new sync`);
    return;
  }
  const { queued } = await queueMemberSync(env, cid, [teamspeakPlatform], memberLookups(env, cid, holder));
  if (queued) await env.KV.put(connectKey(cid), new Date().toISOString(), { expirationTtl: CONNECT_SECONDS });
}

/** The most CIDs one syncMembers() call takes. */
const MAX_SYNC_MEMBERS = 100;

/**
 * RPC: sync these members now. Reads every group source again first (groups.ts), so their jobs see what
 * the app has just changed, then queues each CID's job on each platform. At most once every 2 minutes per
 * member; a declined member still gets the fresh read, which a job of theirs that hasn't run yet picks up.
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
  for (const cid of due) {
    const result = await queueMemberSync(env, cid);
    if (result.queued) await env.KV.put(memberKey(cid), new Date().toISOString(), { expirationTtl: MEMBER_COOLDOWN_SECONDS });
    results.set(cid, result);
  }
  return unique.map((cid) => ({ cid, ...results.get(cid)! }));
}

/** RPC: clear a link, then queue the sync of the account the member falls back to on that platform, if any. */
export async function unlink(env: RoleSyncEnv, cid: number, service: keyof Links): Promise<void> {
  checkMode(env);
  const platform = PLATFORMS.find((candidate) => candidate.name === service);
  if (!platform) throw new Error(`"${service}" isn't a platform larry links`);
  await platform.unlink(env, cid);
  await queueMemberSync(env, cid, [platform]);
}

/** RPC: which account is in use for a member on each platform, and where it came from. */
export async function getLinks(env: RoleSyncEnv, cid: number): Promise<Links> {
  const links: Links = { discord: null, teamspeak: null };
  const member = memberLookups(env, cid);
  for (const platform of PLATFORMS) {
    const ref = await platform.findAccount(env, cid, member);
    Object.assign(links, { [platform.name]: ref && platform.linkOf(ref) });
  }
  return links;
}

/** Post to the tech team once per outage. If the post fails, the next skipped run tries again. */
async function alertOnce(env: RoleSyncEnv, content: string): Promise<void> {
  console.warn(content);
  await postOnce(env, OUTAGE_KEY, content);
}

function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
