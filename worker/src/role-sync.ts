import { postOnce } from './alerts';
import type { Links, SyncMemberResult, SyncMembersResult } from './client/api';
import { rolesFor } from './criteria';
import type { GuildEnv } from './discord';
import { GROUP_SOURCES, type GroupSourcesEnv } from './group-sources';
import { refreshSource } from './groups';
import { getUser, type IdentityEnv, type IdentityUser } from './identity';
import { MAPPING, type MappingEntry } from './mapping';
import { discordPlatform, type DiscordMessage, type DiscordPlatformEnv, type RunServer } from './platforms/discord';
import { checkMode, type AnyPlatform, type MemberLookups, type Mode, type Resolution } from './platforms/platform';
import { teamspeakPlatform, type TeamSpeakMessage, type TeamSpeakPlatformEnv } from './platforms/teamspeak';
import type { SendEnv } from './send';
import { fetchLists, peopleFrom, type VatusaPerson } from './vatusa';

/**
 * The role sync: makes each member's roles on every platform match what VATUSA's lists say, through the
 * mapping (mapping.ts). This file is the shared part: who a member is and which mapping entries they
 * match, worked out once per member, and the cron, the queue, the RPCs and the run's lists. Everything
 * about one platform (finding, reading and writing its accounts, its guards and extras such as Discord's
 * nickname) is its adapter's, in platforms/ (the seam is platforms/platform.ts), registered in PLATFORMS.
 *
 * Every 15 minutes the cron (startRoleSync) fetches the lists once, keeps them in KV for that run, and
 * queues one job per account each adapter lists (an adapter whose list arrives later queues its own when
 * it comes). Other jobs come from the bots (a member who joins the Discord server, through bot-events.ts),
 * from syncMembers() and from the link writes. The consumer (consumeRoleSync) hands each job to the adapter
 * whose message it is, which reads the account, and then to syncAccount. `ROLE_SYNC_MODE` says what that
 * does: `dry-run` logs what it would change and changes nothing; `live` changes it. A platform's failure
 * fails that member's job, so the queue retries it.
 *
 * One job per member: a job applies to every platform the member has an account on. In a run, a member's
 * job is the one of the first registered platform they have an account on; a later platform's run job for
 * them stops once it has found that. syncMembers() queues one job per CID the same way.
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

/** The lists a run fetched, as kept in KV for that run's jobs, with what each adapter read once for the run (Discord's `server`). */
export type RunLists = { people: VatusaPerson[]; server: RunServer };

/**
 * The registered platform adapters, the one place a platform is added or removed. The consumer hands each
 * message to the adapter that owns it; every member's job reaches every adapter they have an account on.
 */
const PLATFORMS: AnyPlatform[] = [discordPlatform, teamspeakPlatform];

/** Set while a skipped run's alert stands, so an outage is posted once, not every 15 minutes. */
const OUTAGE_KEY = 'role-sync:outage';
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

/**
 * The cron: fetch VATUSA's lists, then let each adapter read what it needs for the run and list its
 * accounts, and queue one job per account. A bad VATUSA fetch skips the run.
 */
export async function startRoleSync(env: RoleSyncEnv): Promise<void> {
  checkMode(env);
  const fetched = await fetchLists();
  if ('failed' in fetched) {
    await alertOnce(env, `Role sync skipped: couldn't fetch ${joinNames(fetched.failed)} from VATUSA.`);
    return;
  }
  await env.KV.delete(OUTAGE_KEY);
  const people = peopleFrom(fetched.lists);

  const runId = crypto.randomUUID();
  const listed = [];
  for (const platform of PLATFORMS) listed.push(await platform.listAccounts(env, people, runId));
  const run = Object.assign({ people }, ...listed.map((one) => one.run)) as RunLists;
  await env.KV.put(runKey(runId), JSON.stringify(run), { expirationTtl: RUN_LISTS_TTL_SECONDS });
  await env.KV.put(LATEST_RUN_KEY, runId, { expirationTtl: RUN_LISTS_TTL_SECONDS });

  const jobs: MessageSendRequest<RoleSyncMessage>[] = listed.flatMap((one) => one.jobs(runId)).map((body) => ({ body }));
  for (let i = 0; i < jobs.length; i += SEND_BATCH) await env.ROLE_SYNC_QUEUE.sendBatch(jobs.slice(i, i + SEND_BATCH));
  console.log(`Role sync run ${runId}: ${run.people.length} people on VATUSA's lists; queued ${jobs.length} members`);
}

/** The `role-sync` consumer. A job that throws (a platform's failure included) is retried, then parked in role-sync-dlq. */
export async function consumeRoleSync(batch: MessageBatch<RoleSyncMessage>, env: RoleSyncEnv): Promise<void> {
  const mode = checkMode(env);
  const runs = new Map<string, RunLists | null>();
  const listsOf = async (runId: string) => {
    if (!runs.has(runId)) runs.set(runId, await env.KV.get<RunLists>(runKey(runId), 'json'));
    return runs.get(runId) ?? null;
  };

  for (const message of batch.messages) {
    try {
      await runJob(env, mode, message.body, listsOf);
      message.ack();
    } catch (error) {
      console.error(`Role sync job failed, retrying: ${String(error)}`);
      message.retry({ delaySeconds: 10 * message.attempts });
    }
  }
}

/**
 * One queue message's job: the run it belongs to (else the newest run's lists, else none), the account
 * as its adapter reads it now, then syncAccount.
 */
async function runJob(env: RoleSyncEnv, mode: Mode, message: RoleSyncMessage, listsOf: (runId: string) => Promise<RunLists | null>): Promise<void> {
  const platform = PLATFORMS.find((candidate) => candidate.owns(message));
  if (!platform) throw new Error(`Unknown role-sync job type "${(message as { type?: unknown }).type}"`);
  const job = platform.jobOf(message);
  const run = job.runId === undefined ? await runForMember(env) : await listsOf(job.runId);
  if (!run) {
    console.warn(`Role sync: run ${job.runId}'s lists have expired; ${job.accountId} waits for the next run`);
    return;
  }
  const account = await platform.accountOf(env, mode, message);
  if (account) await syncAccount(env, run, platform, account, job.cid, PLATFORMS, job.runId !== undefined);
}

/**
 * Sync one queue message's member now, without the queue (postToGroup(), so a mentioned member can see
 * the room before the post).
 */
export async function syncNow(env: RoleSyncEnv, message: RoleSyncMessage): Promise<void> {
  const mode = checkMode(env);
  await runJob(env, mode, message, async (runId) => env.KV.get<RunLists>(runKey(runId), 'json'));
}

/**
 * The job, once per member. `origin` resolves `account` to a member (`cid` given when the job knows it),
 * and the mapping is matched once; then each adapter in `platforms` makes its account of that member
 * match it (`origin` on `account`; each other on the account it finds for the CID). An account that
 * resolves to no one loses its managed roles on its own platform only. `inRun` is set for a run's job: if
 * the member has an account on a platform registered before `origin`, that platform's job of the run syncs
 * them, so this one stops. Not finding the member's account on another platform (its lookup failing) skips
 * that platform, logged, and doesn't fail the job. `platforms` is PLATFORMS but in tests.
 */
export async function syncAccount<Account>(
  env: RoleSyncEnv,
  run: RunLists,
  origin: AnyPlatform,
  account: Account,
  cid?: number,
  platforms: AnyPlatform[] = PLATFORMS,
  inRun = false,
): Promise<void> {
  const mode = checkMode(env);
  const resolution = await origin.resolve(env, run, account, cid);
  const person = resolution.kind === 'person' ? resolution.person : null;
  const wanted = new Set(person ? rolesFor(person) : []);
  const member = memberLookups(env, person?.cid ?? null, resolution.kind === 'person' ? resolution.identity : null);

  const found = new Map<AnyPlatform, unknown>();
  if (person && inRun) {
    for (const earlier of platforms.slice(0, platforms.indexOf(origin))) {
      const other = await accountOn(env, earlier, person.cid, member);
      found.set(earlier, other);
      if (other) {
        console.log(`Role sync: CID ${person.cid} is synced by this run's ${earlier.name} job, not again from ${origin.name}`);
        return;
      }
    }
  }

  await applyTo(env, mode, run, origin, account, resolution, wanted, member);
  if (!person) return;

  for (const platform of platforms) {
    if (platform === origin) continue;
    const other = found.has(platform) ? found.get(platform) : await accountOn(env, platform, person.cid, member);
    if (other) await applyTo(env, mode, run, platform, other, { kind: 'person', person }, wanted, member);
  }
}

/** A member's account on one platform as it stands now, or null: none, gone, or (logged) not found because a lookup failed. */
async function accountOn(env: RoleSyncEnv, platform: AnyPlatform, cid: number, member: MemberLookups): Promise<unknown> {
  try {
    const ref = await platform.accountFor(env, cid, member);
    return ref ? await platform.current(env, ref) : null;
  } catch (error) {
    console.warn(`Role sync: couldn't find CID ${cid}'s ${platform.name} account; it waits for its next sync: ${String(error)}`);
    return null;
  }
}

/**
 * What every adapter shares about one CID: the newest run's record and their identity record, each read
 * once, on first use. `known` is the identity record an adapter has already read (undefined: not read).
 * No CID (an account that resolved to no one): no identity record.
 */
function memberLookups(env: RoleSyncEnv, cid: number | null, known?: IdentityUser | null): MemberLookups {
  let identity: Promise<IdentityUser | null> | undefined = cid === null ? Promise.resolve(null) : known !== undefined ? Promise.resolve(known) : undefined;
  return {
    latest: () => latestRun(env),
    identity: () => (identity ??= getUser(env, cid!)),
  };
}

/** The mapping entries to give and take on one account, past the adapter's guard, handed to its apply. */
async function applyTo<Account>(
  env: RoleSyncEnv,
  mode: Mode,
  run: RunLists,
  platform: AnyPlatform,
  account: Account,
  resolution: Resolution<unknown>,
  wanted: Set<MappingEntry>,
  member: MemberLookups,
): Promise<void> {
  const add: MappingEntry[] = [];
  const remove: MappingEntry[] = [];
  if (resolution.kind !== 'left-alone') {
    const held = platform.held(account);
    const skipped = platform.skipped(run);
    for (const entry of MAPPING) {
      const id = platform.idOf(entry);
      if (!id || skipped.includes(id)) continue;
      const holds = held.includes(id);
      if (wanted.has(entry) && !holds) add.push(entry);
      if (!wanted.has(entry) && holds) remove.push(entry);
    }
  }
  await platform.apply(env, { mode, run, account, resolution, add, remove, identity: member.identity });
}

/** The newest run's lists, while they are kept. */
async function latestRun(env: Pick<RoleSyncEnv, 'KV'>): Promise<RunLists | null> {
  const latestId = await env.KV.get(LATEST_RUN_KEY);
  return latestId ? await env.KV.get<RunLists>(runKey(latestId), 'json') : null;
}

/**
 * The lists a single member's job reads, which has no run of its own: the newest run's if it is still
 * kept, otherwise no VATUSA lists (the per-user lookups cover the member) and what each adapter reads now.
 */
async function runForMember(env: RoleSyncEnv): Promise<RunLists> {
  const latest = await latestRun(env);
  if (latest) return latest;
  const read = [];
  for (const platform of PLATFORMS) read.push(await platform.freshRun(env));
  return Object.assign({ people: [] }, ...read) as RunLists;
}

/** The account a CID syncs on, on one platform, by that platform's rule. */
export function accountFor<Ref>(env: RoleSyncEnv, platform: AnyPlatform, cid: number): Promise<Ref | null> {
  return platform.accountFor(env, cid, memberLookups(env, cid));
}

const NO_ACCOUNT = 'No Discord account or TeamSpeak identity is known for this member.';

/**
 * Queue a CID's one job, on the first platform they have an account on: it applies to the others too.
 * The identity record is read once for all of them.
 */
async function queueMemberSync(env: RoleSyncEnv, cid: number): Promise<SyncMemberResult> {
  const member = memberLookups(env, cid);
  for (const platform of PLATFORMS) {
    const ref = await platform.accountFor(env, cid, member);
    if (!ref) continue;
    await env.ROLE_SYNC_QUEUE.send(platform.messageFor(cid, ref));
    await env.KV.put(memberKey(cid), new Date().toISOString(), { expirationTtl: MEMBER_COOLDOWN_SECONDS });
    return { queued: true };
  }
  return { queued: false, reason: NO_ACCOUNT };
}

/** Set when a member's sync is queued because they connected to TeamSpeak, so reconnecting doesn't queue another for 5 minutes. */
const connectKey = (cid: number) => `role-sync:connect:${cid}`;
const CONNECT_SECONDS = 5 * 60;

/**
 * A linked member connected to TeamSpeak: queue their one job, unless they were synced in the last 5
 * minutes (by an earlier connect, or by syncMembers(), whose 2-minute mark is memberKey).
 */
export async function syncOnConnect(env: RoleSyncEnv, cid: number): Promise<void> {
  if ((await env.KV.get(connectKey(cid))) || (await env.KV.get(memberKey(cid)))) {
    console.log(`Role sync: CID ${cid} connected to TeamSpeak; synced in the last 5 minutes, so no new sync`);
    return;
  }
  const { queued } = await queueMemberSync(env, cid);
  if (queued) await env.KV.put(connectKey(cid), new Date().toISOString(), { expirationTtl: CONNECT_SECONDS });
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

/** RPC: clear a link, then queue the sync of the account the member falls back to, if any. */
export async function unlink(env: RoleSyncEnv, cid: number, service: keyof Links): Promise<void> {
  checkMode(env);
  const platform = PLATFORMS.find((candidate) => candidate.name === service);
  if (!platform) throw new Error(`"${service}" isn't a platform larry links`);
  await platform.unlink(env, cid);
  await queueMemberSync(env, cid);
}

/** RPC: which account is in use for a member on each platform, and where it came from. */
export async function getLinks(env: RoleSyncEnv, cid: number): Promise<Links> {
  const links: Links = { discord: null, teamspeak: null };
  const member = memberLookups(env, cid);
  for (const platform of PLATFORMS) {
    const ref = await platform.accountFor(env, cid, member);
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
