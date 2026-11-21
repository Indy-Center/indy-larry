import type { Links, SyncMemberResult } from './client/api';
import { rolesFor } from './criteria';
import { guildId, SNOWFLAKE, type GuildEnv } from './discord';
import { linksOf, listIdentityMembers, writeDiscordId, type IdentityBinding, type Member } from './identity';
import { lookupVatsimRating, lookupVatusa } from './lookups';
import { checkMapping, MAPPING } from './mapping';
import { getMember, listMembers } from './roles';
import { sendNow, type SendEnv } from './send';
import { fetchCredentials, type Credentials, type TrainingBinding } from './training';
import { fetchLists, peopleFrom, type VatusaPerson } from './vatusa';

/**
 * The role sync, Discord half: makes each member's Discord roles match what VATUSA's lists say,
 * through the mapping (mapping.ts). Only roles the mapping names are ever added or removed.
 *
 * Every 15 minutes the cron (startRoleSync) fetches the lists once, keeps them in KV for that run, and
 * queues one job per Discord member on `role-sync`. The consumer (consumeRoleSync) hands each job to
 * syncDiscordMember. In `dry-run`, the only mode so far, that logs what it would change and changes
 * nothing.
 *
 * A member's Discord link lives in identity and is read through identity.ts: a Discord account that is
 * someone's link takes that CID, whatever VATUSA says. syncMember() and the link writes queue one
 * member's job by CID (`sync-cid`).
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
      /** One member's job by CID, from syncMember() and the link writes. Their roles are read when it runs. */
      type: 'sync-cid';
      cid: number;
      discordId: string;
    };

export type RoleSyncEnv = GuildEnv &
  Pick<SendEnv, 'SEND_CHANNELS' | 'LARRY_QUEUE'> & {
    KV: KVNamespace;
    /** `training-tools`' `TrainingRpc`: certifications and endorsements. */
    TRAINING: TrainingBinding;
    /** identity's RPC: who has linked which Discord account. */
    IDENTITY: IdentityBinding;
    ROLE_SYNC_QUEUE: Queue<RoleSyncMessage>;
    /** `dry-run` (the default): log what would change, change nothing. */
    ROLE_SYNC_MODE?: string;
  };

/** The lists a run fetched, as kept in KV for that run's jobs; `links` are identity's Discord links. */
export type RunLists = { people: VatusaPerson[]; credentials: Credentials; links: { cid: number; discordId: string }[] };

const ALERT_CHANNEL = 'tech-team-alerts';
/** Set while a skipped run's alert stands, so an outage is posted once, not every 15 minutes. */
const OUTAGE_KEY = 'role-sync:outage';
const runKey = (runId: string) => `role-sync:run:${runId}`;
/** The newest run's ID, so a job that has no run of its own can read that run's lists. */
const LATEST_RUN_KEY = 'role-sync:latest-run';
/** Set when a member's sync is queued by syncMember(), so the profile buttons can't flood the queue. */
const memberKey = (cid: number) => `role-sync:member:${cid}`;
const MEMBER_COOLDOWN_SECONDS = 120;
// Long past the time a run's jobs take; a job whose lists have gone is left to the next run.
const RUN_LISTS_TTL_SECONDS = 60 * 60;
// Queues takes at most 100 messages in one sendBatch.
const SEND_BATCH = 100;

function checkMode(env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE'>): 'dry-run' {
  const mode = env.ROLE_SYNC_MODE ?? 'dry-run';
  if (mode !== 'dry-run') throw new Error(`ROLE_SYNC_MODE "${mode}" isn't supported; the role sync only runs in dry-run`);
  return mode;
}

/** Identity's members, or null when the call fails (a run on a partial or empty link list would strip linked accounts). */
async function fetchIdentityMembers(env: Pick<RoleSyncEnv, 'IDENTITY'>): Promise<Member[] | null> {
  try {
    return await listIdentityMembers(env.IDENTITY);
  } catch (error) {
    console.warn(`identity's member list failed: ${String(error)}`);
    return null;
  }
}

/** The cron: fetch VATUSA's lists, then queue one job per Discord member. A bad fetch skips the run. */
export async function startRoleSync(env: RoleSyncEnv): Promise<void> {
  checkMode(env);
  checkMapping(MAPPING);
  const fetched = await fetchLists();
  if ('failed' in fetched) {
    await alertOnce(env, `Role sync skipped: couldn't fetch ${joinNames(fetched.failed)} from VATUSA.`);
    return;
  }
  const credentials = await fetchCredentials(env.TRAINING);
  if (!credentials) {
    await alertOnce(env, "Role sync skipped: couldn't fetch the training roster.");
    return;
  }
  const identityMembers = await fetchIdentityMembers(env);
  if (!identityMembers) {
    await alertOnce(env, "Role sync skipped: couldn't fetch the Discord links from identity.");
    return;
  }
  await env.KV.delete(OUTAGE_KEY);

  const members = await listMembers(env.DISCORD_TOKEN, guildId(env));
  if (!members) throw new Error("Role sync can't list the server's members: switch on the Server Members intent");

  const runId = crypto.randomUUID();
  const run: RunLists = { people: peopleFrom(fetched.lists), credentials, links: linksOf(identityMembers) };
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

  for (const message of batch.messages) {
    try {
      const job = message.body;
      if (job.type === 'sync-cid') {
        await syncMemberJob(env, { discordId: job.discordId, cid: job.cid });
      } else {
        if (!runs.has(job.runId)) runs.set(job.runId, await env.KV.get<RunLists>(runKey(job.runId), 'json'));
        const run = runs.get(job.runId);
        if (!run) {
          console.warn(`Role sync: run ${job.runId}'s lists have expired; ${job.discordId} waits for the next run`);
        } else {
          await syncDiscordMember(env, run, { discordId: job.discordId, roleIds: job.roleIds });
        }
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
export async function syncDiscordMember(
  env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE' | 'KV'>,
  run: RunLists,
  member: { discordId: string; roleIds: string[]; cid?: number },
): Promise<MemberSync> {
  checkMode(env);
  const { person: found, ambiguous, linkedElsewhere } = await resolvePerson(env, run, member);
  const person = found && { ...found, credentials: run.credentials[String(found.cid)] ?? [] };

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

  const who = person
    ? `CID ${person.cid}`
    : linkedElsewhere
      ? 'unresolved (their CID is linked to another Discord account)'
      : ambiguous
        ? `unresolved (${ambiguous} CIDs give this Discord ID)`
        : 'unresolved';
  const changes = person ? `add ${result.add.join(', ') || 'nothing'}; remove ${result.remove.join(', ') || 'nothing'}` : 'no changes';
  console.log(`Role sync (dry run): ${member.discordId} ${who}: ${changes}`);
  return result;
}

/**
 * Who a Discord member is, from the cheapest source up. A CID given, or the CID whose identity link is
 * this Discord account, is looked for on the lists; otherwise their CID is the one whose VATUSA Discord ID
 * is theirs, and two CIDs claiming it is no answer. A VATUSA-only match whose CID is linked to a different
 * Discord account is a stale account and gets nothing. Off the lists, VATUSA's per-user lookup; for a CID
 * VATUSA doesn't know, only their rating from VATSIM. Null when nothing identifies them.
 */
async function resolvePerson(
  env: Pick<RoleSyncEnv, 'KV'>,
  run: RunLists,
  member: { discordId: string; cid?: number },
): Promise<{ person: VatusaPerson | null; ambiguous?: number; linkedElsewhere?: boolean }> {
  const cid = member.cid ?? run.links.find((link) => link.discordId === member.discordId)?.cid;
  const matches = run.people.filter((person) => (cid !== undefined ? person.cid === cid : person.discordId === member.discordId));
  if (matches.length > 1) return { person: null, ambiguous: matches.length };

  const person = matches[0] ?? (await lookupVatusa(env.KV, cid !== undefined ? { cid } : { discordId: member.discordId }));
  if (person) {
    const linkedElsewhere = cid === undefined && run.links.some((link) => link.cid === person.cid && link.discordId !== member.discordId);
    return linkedElsewhere ? { person: null, linkedElsewhere } : { person };
  }
  if (cid === undefined) return { person: null };

  const vatsim = await lookupVatsimRating(env.KV, cid);
  if (!vatsim) return { person: null };
  return {
    person: { cid, discordId: member.discordId, rating: vatsim.rating, ratingShort: vatsim.ratingShort, facility: '', rosters: [], roles: [], credentials: [] },
  };
}

/**
 * The lists a single member's job reads, which has no run of its own: the newest run's if it is still
 * kept, otherwise only the training roster and no VATUSA lists (the per-user lookups cover the member).
 * The links are always read fresh, so a link written a moment ago counts.
 */
export async function runListsForMember(env: RoleSyncEnv): Promise<RunLists> {
  const latestId = await env.KV.get(LATEST_RUN_KEY);
  const latest = latestId ? await env.KV.get<RunLists>(runKey(latestId), 'json') : null;
  const links = linksOf(await listIdentityMembers(env.IDENTITY));
  if (latest) return { ...latest, links };
  const credentials = await fetchCredentials(env.TRAINING);
  if (!credentials) throw new Error("Can't sync a member: couldn't fetch the training roster");
  return { people: [], credentials, links };
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
  return syncDiscordMember(env, run, { discordId: member.discordId, roleIds: inServer.roles, cid: member.cid });
}

const NO_ACCOUNT = 'No Discord account or TeamSpeak identity is known for this member.';

/** The Discord account to sync for a CID: their identity link, else the VATUSA Discord ID (from the lists, else VATUSA's per-user lookup). */
async function discordIdFor(env: RoleSyncEnv, cid: number): Promise<{ id: string; source: 'linked' | 'vatusa' } | null> {
  const linked = (await listIdentityMembers(env.IDENTITY)).find((member) => member.cid === cid)?.discordId;
  if (linked) return { id: linked, source: 'linked' };
  const latestId = await env.KV.get(LATEST_RUN_KEY);
  const latest = latestId ? await env.KV.get<RunLists>(runKey(latestId), 'json') : null;
  const person = latest?.people.find((candidate) => candidate.cid === cid) ?? (await lookupVatusa(env.KV, { cid }));
  return person?.discordId ? { id: person.discordId, source: 'vatusa' } : null;
}

async function queueMemberSync(env: RoleSyncEnv, cid: number): Promise<SyncMemberResult> {
  const account = await discordIdFor(env, cid);
  if (!account) return { queued: false, reason: NO_ACCOUNT };
  await env.ROLE_SYNC_QUEUE.send({ type: 'sync-cid', cid, discordId: account.id });
  await env.KV.put(memberKey(cid), new Date().toISOString(), { expirationTtl: MEMBER_COOLDOWN_SECONDS });
  return { queued: true };
}

/** RPC: queue one member's sync now. At most once every 2 minutes per member. */
export async function syncMember(env: RoleSyncEnv, cid: number): Promise<SyncMemberResult> {
  checkMode(env);
  if (await env.KV.get(memberKey(cid))) return { queued: false, reason: 'Synced moments ago; try again in a minute.' };
  return queueMemberSync(env, cid);
}

/** RPC: link a Discord account to a member in identity, and queue their sync. */
export async function linkDiscord(env: RoleSyncEnv, cid: number, discordId: string): Promise<void> {
  checkMode(env);
  if (!SNOWFLAKE.test(discordId)) throw new Error('discordId must be a Discord user ID.');
  const members = await listIdentityMembers(env.IDENTITY);
  if (members.some((member) => member.discordId === discordId && member.cid !== cid)) throw new Error('That Discord account is linked to another member.');
  if (!members.some((member) => member.cid === cid)) throw new Error('Sign in to flyindycenter.com once before linking.');
  await writeDiscordId(env.IDENTITY, cid, discordId);
  await env.ROLE_SYNC_QUEUE.send({ type: 'sync-cid', cid, discordId });
}

/** RPC: clear a link, then queue the sync of the account the member falls back to, if any. */
export async function unlink(env: RoleSyncEnv, cid: number, service: 'discord' | 'teamspeak'): Promise<void> {
  checkMode(env);
  if (service === 'teamspeak') throw new Error("TeamSpeak links aren't available yet.");
  await writeDiscordId(env.IDENTITY, cid, null);
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
