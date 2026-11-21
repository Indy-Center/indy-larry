import type { Links, SyncMemberResult } from './client/api';
import { rolesFor } from './criteria';
import { discord, guildId, SNOWFLAKE, type GuildEnv } from './discord';
import { findByDiscordId, getUser, IdentityConflict, writeDiscordId, type IdentityEnv, type IdentityUser } from './identity';
import { lookupVatsimRating, lookupVatusa } from './lookups';
import { checkMapping, MAPPING } from './mapping';
import { nicknameFor } from './nickname-rule';
import { applyNickname, nicknameGuard, type NicknameGuard, type NicknameOutcome } from './nicknames';
import { getMember, listMembers, syncRefusal, type DiscordRole } from './roles';
import { sendNow, type SendEnv } from './send';
import { fetchCredentials, type Credentials, type TrainingBinding } from './training';
import { fetchLists, peopleFrom, type VatusaPerson } from './vatusa';

/**
 * The role sync, Discord half: makes each member's Discord roles match what VATUSA's lists say,
 * through the mapping (mapping.ts), and sets their nickname (nickname-rule.ts). Only roles the mapping
 * names are ever added or removed.
 *
 * Every 15 minutes the cron (startRoleSync) fetches the lists once, keeps them in KV for that run, and
 * queues one job per Discord member on `role-sync`. The consumer (consumeRoleSync) hands each job to
 * syncDiscordMember. `ROLE_SYNC_MODE` says what that does: `dry-run` logs what it would change and
 * changes nothing; `live` changes it. A Discord failure fails that member's job, so the queue retries it.
 *
 * A member's Discord link lives in identity and is read through identity.ts: a Discord account that is
 * someone's link takes that CID, whatever VATUSA says. syncMember() and the link writes queue one
 * member's job by CID (`sync-cid`).
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
    }
  | {
      /** One member's job by CID, from syncMember() and the link writes. Their roles are read when it runs. */
      type: 'sync-cid';
      cid: number;
      discordId: string;
    };

export type RoleSyncEnv = GuildEnv &
  Pick<SendEnv, 'SEND_CHANNELS' | 'LARRY_QUEUE'> &
  IdentityEnv & {
    KV: KVNamespace;
    /** `training-tools`' `TrainingRpc`: certifications and endorsements. */
    TRAINING: TrainingBinding;
    ROLE_SYNC_QUEUE: Queue<RoleSyncMessage>;
    /** `dry-run` (the default): log what would change, change nothing. `live`: change it. */
    ROLE_SYNC_MODE?: string;
  };

/** What a run read from the server once: the mapped roles it skips, and who it won't rename. */
export type RunServer = { skippedRoles: string[]; guard: NicknameGuard };

/** The lists a run fetched, as kept in KV for that run's jobs. */
export type RunLists = { people: VatusaPerson[]; credentials: Credentials; server: RunServer };

type Mode = 'dry-run' | 'live';

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

function checkMode(env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE'>): Mode {
  const mode = env.ROLE_SYNC_MODE ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'live') throw new Error(`ROLE_SYNC_MODE "${mode}" isn't supported; use dry-run or live`);
  return mode;
}

/**
 * Read the server once for a run: its roles, its owner and Larry's own roles. A mapped role the sync
 * won't touch is skipped for the whole run, with one log line: @everyone, a bot's role, and any role at
 * or above Larry's highest, which Discord wouldn't let Larry change anyway. A mapped role that isn't on
 * the server is left for Discord to refuse.
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
    const role = entry.discordRoleId ? info.roles.find((candidate) => candidate.id === entry.discordRoleId) : undefined;
    if (!role) continue;
    const reason = syncRefusal(role, guild) ?? ((role.position ?? 0) >= larryTop ? "it is at or above Larry's highest role" : null);
    if (!reason) continue;
    skippedRoles.push(role.id);
    console.warn(`Role sync: skipping mapped role ${entry.name} this run: ${reason}`);
  }
  const others = info.roles.filter((role) => role.id !== guild);
  return { skippedRoles, guard: nicknameGuard(info.owner_id, me.id, others, larryTop) };
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
  await env.KV.delete(OUTAGE_KEY);

  const members = await listMembers(env.DISCORD_TOKEN, guildId(env));
  if (!members) throw new Error("Role sync can't list the server's members: switch on the Server Members intent");

  const runId = crypto.randomUUID();
  const run: RunLists = { people: peopleFrom(fetched.lists), credentials, server: await readServer(env) };
  await env.KV.put(runKey(runId), JSON.stringify(run), { expirationTtl: RUN_LISTS_TTL_SECONDS });
  await env.KV.put(LATEST_RUN_KEY, runId, { expirationTtl: RUN_LISTS_TTL_SECONDS });

  const jobs: MessageSendRequest<RoleSyncMessage>[] = members.flatMap((member) =>
    member.user ? [{ body: { type: 'run-member', runId, discordId: member.user.id, roleIds: member.roles, nick: member.nick ?? null } }] : [],
  );
  for (let i = 0; i < jobs.length; i += SEND_BATCH) await env.ROLE_SYNC_QUEUE.sendBatch(jobs.slice(i, i + SEND_BATCH));
  console.log(`Role sync run ${runId}: ${run.people.length} people on VATUSA's lists; queued ${jobs.length} members`);
}

/** The `role-sync` consumer. A job that throws (a Discord failure included) is retried, then parked in role-sync-dlq. */
export async function consumeRoleSync(batch: MessageBatch<RoleSyncMessage>, env: RoleSyncEnv): Promise<void> {
  const mode = checkMode(env);
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
          // The run listed the server minutes ago: before changing anything, read what they hold now.
          const now = mode === 'live' ? await getMember(env.DISCORD_TOKEN, guildId(env), job.discordId) : { roles: job.roleIds, nick: job.nick };
          if (!now) console.log(`Role sync: ${job.discordId} isn't in the server`);
          else await syncDiscordMember(env, run, { discordId: job.discordId, roleIds: now.roles, nick: now.nick ?? null });
        }
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

/**
 * Sync one Discord member: find their CID, work out their mapped roles and nickname, and change them
 * (`live`) or log what would change (`dry-run`). `roleIds` and `nick` are what they hold now. The one
 * place a member is synced, whatever asked for it. Throws when Discord refuses a change.
 */
export async function syncDiscordMember(
  env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE' | 'KV' | 'DISCORD_TOKEN' | 'GUILD_ID'> & IdentityEnv,
  run: RunLists,
  member: { discordId: string; roleIds: string[]; nick: string | null; cid?: number },
): Promise<MemberSync> {
  const mode = checkMode(env);
  const { person: found, ambiguous, linkedElsewhere, identity } = await resolvePerson(env, run, member);
  const person = found && { ...found, credentials: run.credentials[String(found.cid)] ?? [] };

  const result: MemberSync = { discordId: member.discordId, cid: person?.cid ?? null, add: [], remove: [], nickname: null };
  const addIds: string[] = [];
  const removeIds: string[] = [];
  if (person) {
    const wanted = new Set(rolesFor(person));
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

  if (mode === 'live') {
    const guild = guildId(env);
    for (const id of addIds) await discord(env.DISCORD_TOKEN, 'PUT', `/guilds/${guild}/members/${member.discordId}/roles/${id}`, undefined, 'Role sync');
    for (const id of removeIds) await discord(env.DISCORD_TOKEN, 'DELETE', `/guilds/${guild}/members/${member.discordId}/roles/${id}`, undefined, 'Role sync');
  }

  if (person) {
    const to = nicknameFor(person, person.rating < 1 ? null : await identityForNickname(env, person.cid, member.discordId, identity));
    if (to) result.nickname = await applyNickname(env, run.server.guard, member, to, mode === 'dry-run');
  }

  const who = person
    ? `CID ${person.cid}`
    : linkedElsewhere
      ? 'unresolved (their CID is linked to another Discord account)'
      : ambiguous
        ? `unresolved (${ambiguous} CIDs give this Discord ID)`
        : 'unresolved';
  const changes = person ? `add ${result.add.join(', ') || 'nothing'}; remove ${result.remove.join(', ') || 'nothing'}${nicknameNote(result.nickname)}` : 'no changes';
  console.log(`Role sync (${mode === 'live' ? 'live' : 'dry run'}): ${member.discordId} ${who}: ${changes}`);
  return result;
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
    console.warn(`Role sync: couldn't reach identity for ${discordId}'s preferred name; using VATUSA's name: ${String(error)}`);
    return null;
  }
}

/**
 * Who a Discord member is, from the cheapest source up. A CID given, or the CID whose identity link is
 * this Discord account, is looked for on the lists; otherwise their CID is the one whose VATUSA Discord ID
 * is theirs, and two CIDs claiming it is no answer. A VATUSA-only match whose CID is linked to a different
 * Discord account is a stale account and gets nothing. Off the lists, VATUSA's per-user lookup; for a CID
 * VATUSA doesn't know, only their rating from VATSIM. Null when nothing identifies them. `identity` is the
 * identity user the lookup found for them (undefined when it didn't ask identity).
 */
async function resolvePerson(
  env: Pick<RoleSyncEnv, 'KV'> & IdentityEnv,
  run: RunLists,
  member: { discordId: string; cid?: number },
): Promise<{ person: VatusaPerson | null; ambiguous?: number; linkedElsewhere?: boolean; identity?: IdentityUser | null }> {
  const linkedUser = member.cid === undefined ? await findByDiscordId(env, member.discordId) : undefined;
  const cid = member.cid ?? linkedUser?.cid;
  const identity = linkedUser ?? undefined;
  const matches = run.people.filter((person) => (cid !== undefined ? person.cid === cid : person.discordId === member.discordId));
  if (matches.length > 1) return { person: null, ambiguous: matches.length };

  const person = matches[0] ?? (await lookupVatusa(env.KV, cid !== undefined ? { cid } : { discordId: member.discordId }));
  if (person) {
    if (cid !== undefined) return { person, identity };
    // Found by Discord ID alone: if their CID has linked a different account, this one is stale.
    const user = await getUser(env, person.cid);
    if (user?.discordId && user.discordId !== member.discordId) return { person: null, linkedElsewhere: true };
    return { person, identity: user };
  }
  if (cid === undefined) return { person: null };

  const vatsim = await lookupVatsimRating(env.KV, cid);
  if (!vatsim) return { person: null };
  return {
    person: { cid, discordId: member.discordId, rating: vatsim.rating, ratingShort: vatsim.ratingShort, facility: '', rosters: [], roles: [], credentials: [], name: null },
    identity,
  };
}

/**
 * The lists a single member's job reads, which has no run of its own: the newest run's if it is still
 * kept, otherwise only the training roster and no VATUSA lists (the per-user lookups cover the member).
 */
export async function runListsForMember(env: RoleSyncEnv): Promise<RunLists> {
  const latestId = await env.KV.get(LATEST_RUN_KEY);
  const latest = latestId ? await env.KV.get<RunLists>(runKey(latestId), 'json') : null;
  if (latest) return latest;
  const credentials = await fetchCredentials(env.TRAINING);
  if (!credentials) throw new Error("Can't sync a member: couldn't fetch the training roster");
  return { people: [], credentials, server: await readServer(env) };
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
  return syncDiscordMember(env, run, { discordId: member.discordId, roleIds: inServer.roles, nick: inServer.nick ?? null, cid: member.cid });
}

const NO_ACCOUNT = 'No Discord account or TeamSpeak identity is known for this member.';

/** The Discord account to sync for a CID: their identity link, else the VATUSA Discord ID (from the lists, else VATUSA's per-user lookup). */
async function discordIdFor(env: RoleSyncEnv, cid: number): Promise<{ id: string; source: 'linked' | 'vatusa' } | null> {
  const linked = (await getUser(env, cid))?.discordId;
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
