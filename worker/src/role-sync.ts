import { rolesFor } from './criteria';
import { guildId, type GuildEnv } from './discord';
import { MAPPING } from './mapping';
import { fetchMember, listMembers } from './roles';
import { sendNow, type SendEnv } from './send';
import { fetchLists, peopleFrom, type VatusaPerson } from './vatusa';

/**
 * The role sync, Discord half: makes each member's Discord roles match what VATUSA's lists say,
 * through the mapping (mapping.ts). Only roles the mapping names are ever added or removed.
 *
 * Every 15 minutes the cron (startRoleSync) fetches the lists once, keeps them in KV for that run, and
 * queues one job per Discord member on `role-sync`. A member who joins the server is queued straight
 * away (`sync-member`, from larry's bot through bot-events.ts) and synced against the latest run's
 * lists. The consumer (consumeRoleSync) hands each job to syncDiscordMember. In `dry-run`, the only mode so far, that logs what it would change and changes
 * nothing.
 */

/** Every message on the `role-sync` queue. Each new kind of job is a new member of this union. */
export type RoleSyncMessage =
  | {
      /** One member's job from a cron run, with the roles they held when the run listed the server. */
      type: 'run-member';
      runId: string;
      discordId: string;
      roleIds: string[];
    }
  | {
      /** One member, now: someone joined the server (larry's bot, POST /bot/events). */
      type: 'sync-member';
      discordId: string;
    };

export type RoleSyncEnv = GuildEnv &
  Pick<SendEnv, 'SEND_CHANNELS' | 'LARRY_QUEUE'> & {
    KV: KVNamespace;
    ROLE_SYNC_QUEUE: Queue<RoleSyncMessage>;
    /** `dry-run` (the default): log what would change, change nothing. */
    ROLE_SYNC_MODE?: string;
  };

/** The lists a run fetched, as kept in KV for that run's jobs. */
type RunLists = { people: VatusaPerson[] };

const ALERT_CHANNEL = 'tech-team-alerts';
/** Set while a skipped run's alert stands, so an outage is posted once, not every 15 minutes. */
const OUTAGE_KEY = 'role-sync:outage';
const runKey = (runId: string) => `role-sync:run:${runId}`;
/** The last good run's ID, so a job that isn't from a run (sync-member) can use its lists. */
const LATEST_RUN_KEY = 'role-sync:latest-run';
// Long past the time a run's jobs take; a job whose lists have gone is left to the next run.
const RUN_LISTS_TTL_SECONDS = 60 * 60;
// Queues takes at most 100 messages in one sendBatch.
const SEND_BATCH = 100;

function checkMode(env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE'>): 'dry-run' {
  const mode = env.ROLE_SYNC_MODE ?? 'dry-run';
  if (mode !== 'dry-run') throw new Error(`ROLE_SYNC_MODE "${mode}" isn't supported; the role sync only runs in dry-run`);
  return mode;
}

/** The cron: fetch VATUSA's lists, then queue one job per Discord member. A bad fetch skips the run. */
export async function startRoleSync(env: RoleSyncEnv): Promise<void> {
  checkMode(env);
  const fetched = await fetchLists();
  if ('failed' in fetched) {
    await alertOnce(env, `Role sync skipped: couldn't fetch ${joinNames(fetched.failed)} from VATUSA.`);
    return;
  }
  await env.KV.delete(OUTAGE_KEY);

  const members = await listMembers(env.DISCORD_TOKEN, guildId(env));
  if (!members) throw new Error("Role sync can't list the server's members: switch on the Server Members intent");

  const runId = crypto.randomUUID();
  const run: RunLists = { people: peopleFrom(fetched.lists) };
  await env.KV.put(runKey(runId), JSON.stringify(run), { expirationTtl: RUN_LISTS_TTL_SECONDS });
  await env.KV.put(LATEST_RUN_KEY, runId, { expirationTtl: RUN_LISTS_TTL_SECONDS });

  const jobs: MessageSendRequest<RoleSyncMessage>[] = members.flatMap((member) =>
    member.user ? [{ body: { type: 'run-member', runId, discordId: member.user.id, roleIds: member.roles } }] : [],
  );
  for (let i = 0; i < jobs.length; i += SEND_BATCH) await env.ROLE_SYNC_QUEUE.sendBatch(jobs.slice(i, i + SEND_BATCH));
  console.log(`Role sync run ${runId}: ${run.people.length} people on VATUSA's lists; queued ${jobs.length} members`);
}

/** The `role-sync` consumer. A job that throws is retried, then parked in role-sync-dlq. */
export async function consumeRoleSync(batch: MessageBatch<RoleSyncMessage>, env: RoleSyncEnv): Promise<void> {
  checkMode(env);
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
          if (!run) console.warn(`Role sync: run ${job.runId}'s lists have expired; ${job.discordId} waits for the next run`);
          else await syncDiscordMember(env, run.people, { discordId: job.discordId, roleIds: job.roleIds });
          break;
        }
        case 'sync-member': {
          // A join: the latest run's lists, and the roles the member holds now.
          const runId = await env.KV.get(LATEST_RUN_KEY);
          const run = runId ? await listsOf(runId) : null;
          const member = run ? await fetchMember(env.DISCORD_TOKEN, guildId(env), job.discordId) : null;
          if (!run) console.warn(`Role sync: no run's lists are kept; ${job.discordId} waits for the next run`);
          else if (!member) console.warn(`Role sync: ${job.discordId} isn't in the server; nothing to sync`);
          else await syncDiscordMember(env, run.people, { discordId: job.discordId, roleIds: member.roles });
          break;
        }
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

/** What the sync makes of one member: their CID (null when unresolved) and the mapped roles to change. */
export type MemberSync = { discordId: string; cid: number | null; add: string[]; remove: string[] };

/**
 * Sync one Discord member: find their CID, work out their mapped roles, and (in dry-run) log what
 * would change. The one place a member is synced, whatever asked for it.
 */
export async function syncDiscordMember(env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE'>, people: VatusaPerson[], member: { discordId: string; roleIds: string[] }): Promise<MemberSync> {
  checkMode(env);
  // Their CID is the one whose VATUSA Discord ID is theirs. Two CIDs claiming it is no answer.
  const matches = people.filter((person) => person.discordId === member.discordId);
  const person = matches.length === 1 ? matches[0]! : null;

  const result: MemberSync = { discordId: member.discordId, cid: person?.cid ?? null, add: [], remove: [] };
  if (person) {
    const wanted = new Set(rolesFor(person));
    for (const entry of MAPPING) {
      if (!entry.discordRoleId) continue;
      const holds = member.roleIds.includes(entry.discordRoleId);
      if (wanted.has(entry) && !holds) result.add.push(entry.name);
      if (!wanted.has(entry) && holds) result.remove.push(entry.name);
    }
  }

  const who = person ? `CID ${person.cid}` : matches.length > 1 ? `unresolved (${matches.length} CIDs give this Discord ID)` : 'unresolved';
  const changes = person ? `add ${result.add.join(', ') || 'nothing'}; remove ${result.remove.join(', ') || 'nothing'}` : 'no changes';
  console.log(`Role sync (dry run): ${member.discordId} ${who}: ${changes}`);
  return result;
}

/** Post to the tech team once per outage. If the post fails, the next skipped run tries again. */
async function alertOnce(env: RoleSyncEnv, content: string): Promise<void> {
  console.warn(content);
  if (await env.KV.get(OUTAGE_KEY)) return;
  try {
    await sendNow(env as SendEnv, 'channel', { channel: ALERT_CHANNEL, content, allowedMentions: { parse: [] } });
    await env.KV.put(OUTAGE_KEY, new Date().toISOString());
  } catch (error) {
    console.error(`Role sync couldn't post its alert to ${ALERT_CHANNEL}: ${String(error)}`);
  }
}

function joinNames(names: string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
