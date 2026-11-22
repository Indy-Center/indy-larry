import { postOnce, type AlertEnv } from '../alerts';
import { discord, guildId, SNOWFLAKE, type GuildEnv } from '../discord';
import { groupChanges, syncGroups, type GroupChanges } from '../groups';
import { findByDiscordId, getUser, IdentityConflict, writeDiscordId, type IdentityEnv, type IdentityUser } from '../identity';
import { lookupVatsimRating, lookupVatusa } from '../lookups';
import { MAPPING } from '../mapping';
import { nicknameFor } from '../nickname-rule';
import { applyNickname, nicknameGuard, type NicknameGuard, type NicknameOutcome } from '../nicknames';
import { getMember, listMembers, syncRefusal, type DiscordMember, type DiscordRole } from '../roles';
import type { RoleSyncEnv, RunLists } from '../role-sync';
import type { VatusaPerson } from '../vatusa';
import { checkMode, type Change, type Mode, type Platform, type Resolution } from './platform';

/**
 * The role sync's Discord adapter: the server's members are its accounts, and their mapped roles and
 * nickname (nickname-rule.ts) what it sets. Only roles the mapping names are ever added or removed, and
 * only those below larry's highest role (decision 0005); the groups' roles (groups.ts) go with them.
 *
 * A Discord account's CID is its identity link, else the CID whose VATUSA Discord ID it is. An account the
 * sources confirm is no one (unresolved: see resolvePerson) loses every mapped role it holds, as with
 * VATUSA's bot; a lookup that fails throws instead, so the job retries and removes nothing. Bot accounts
 * are left alone.
 */

/** The role-sync queue's Discord messages. */
export type DiscordMessage =
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

const MESSAGE_TYPES: string[] = ['run-member', 'sync-member', 'sync-cid'] satisfies DiscordMessage['type'][];

export type DiscordPlatformEnv = {
  /**
   * The "Indy Center" app's bot token, for adding a member who links Discord to the server. Discord takes
   * that call only from the app that issued the member's access token, so larry's own token can't make it.
   * Unset, linkDiscord() links without adding anyone.
   */
  DISCORD_JOIN_BOT_TOKEN?: string;
};

/** What a run read from the server once: the mapped roles it skips, and who it won't rename. Kept in the run's record as `server`. */
export type RunServer = { skippedRoles: string[]; guard: NicknameGuard };

/** A Discord member as the sync takes them: what they hold now. */
export type DiscordAccount = { discordId: string; roleIds: string[]; nick: string | null; bot?: boolean };

/** How a CID's Discord account was found: their identity link, or VATUSA's Discord ID. */
export type DiscordRef = { id: string; source: 'linked' | 'vatusa' };

/** Set while a shared Discord ID's alert stands, so it is posted once per ID until a run no longer finds it shared. */
const SHARED_PREFIX = 'role-sync:shared:';

function memberFrom(discordId: string, held: DiscordMember): DiscordAccount {
  return { discordId, roleIds: held.roles, nick: held.nick ?? null, bot: held.user?.bot === true };
}

/** The member, read from the server now; null (logged) when they aren't in it. */
async function memberNow(env: GuildEnv, discordId: string): Promise<DiscordAccount | null> {
  const held = await getMember(env.DISCORD_TOKEN, guildId(env), discordId);
  if (!held) {
    console.log(`Role sync: ${discordId} isn't in the server`);
    return null;
  }
  return memberFrom(discordId, held);
}

export const discordPlatform: Platform<DiscordRef, DiscordAccount, DiscordFound> = {
  name: 'discord',

  async listAccounts(env, people) {
    await clearSharedAlerts(env, people);
    const members = await listMembers(env.DISCORD_TOKEN, guildId(env));
    if (!members) throw new Error("Role sync can't list the server's members: switch on the Server Members intent");
    await syncGroups(env);
    const server = await readServer(env);
    return {
      run: { server },
      jobs: (runId) =>
        members.flatMap((member) =>
          member.user ? [{ type: 'run-member' as const, runId, discordId: member.user.id, roleIds: member.roles, nick: member.nick ?? null, ...(member.user.bot ? { bot: true } : {}) }] : [],
        ),
    };
  },

  async freshRun(env) {
    return { server: await readServer(env) };
  },

  owns: (message) => MESSAGE_TYPES.includes(message.type),

  jobOf: (message) => ({
    accountId: message.discordId,
    ...(message.type === 'sync-cid' ? { cid: message.cid } : {}),
    ...(message.type === 'run-member' ? { runId: message.runId } : {}),
  }),

  async accountOf(env, mode, message) {
    if (message.type !== 'run-member') return memberNow(env, message.discordId);
    // The run listed the server minutes ago: before changing anything, read what they hold now.
    if (mode === 'live') return memberNow(env, message.discordId);
    return memberFrom(message.discordId, { roles: message.roleIds, nick: message.nick, user: { id: message.discordId, bot: message.bot } });
  },

  accountFor: discordIdFor,
  current: (env, ref) => memberNow(env, ref.id),
  messageFor: (cid, ref) => ({ type: 'sync-cid', cid, discordId: ref.id }),
  linkOf: (ref) => ({ id: ref.id, source: ref.source }),

  async unlink(env, cid) {
    await writeDiscordId(env, cid, null);
  },

  async resolve(env, run, account, cid) {
    // As VATUSA's bot does: a bot account is never looked up, and keeps its roles.
    if (account.bot) return { kind: 'left-alone', found: { kind: 'bot' } };
    const found = await resolvePerson(env, run, { discordId: account.discordId, cid });
    if (found.kind === 'shared-id') await reportSharedId(env, account.discordId, found.sharedCids);
    if (found.kind === 'person') return { kind: 'person', person: found.person, found };
    // An account another member has linked isn't no one: its own job syncs it.
    if (found.kind === 'account-taken') return { kind: 'left-alone', found };
    return { kind: 'unresolved', found };
  },

  held: (account) => account.roleIds,
  idOf: (entry) => entry.discordRoleId,
  skipped: (run) => run.server.skippedRoles,
  apply: applyDiscord,
};

/**
 * Change one member's mapped roles, their groups' roles and their nickname (`live`), or log what would
 * change (`dry-run`), then log one line for them. Throws when Discord refuses a change.
 */
async function applyDiscord(env: RoleSyncEnv, change: Change<DiscordAccount, DiscordFound>): Promise<void> {
  const { mode, run, account, resolution, add, remove } = change;
  const label = mode === 'live' ? 'live' : 'dry run';
  if (resolution.found?.kind === 'bot') {
    console.log(`Role sync (${label}): ${account.discordId} is a bot account: left alone`);
    return;
  }
  const person = resolution.kind === 'person' ? resolution.person : null;
  const result: MemberSync = { cid: person?.cid ?? null, add: add.map((entry) => entry.name), remove: remove.map((entry) => entry.name), nickname: null };

  // The groups' roles, the same way: an account another member has linked is left to its own job.
  const groups = resolution.kind === 'left-alone' ? [] : await groupChanges(env, person?.cid ?? null, account.roleIds);

  if (mode === 'live') {
    const guild = guildId(env);
    const route = (id: string) => `/guilds/${guild}/members/${account.discordId}/roles/${id}`;
    for (const entry of add) await discord(env.DISCORD_TOKEN, 'PUT', route(entry.discordRoleId!), undefined, 'Role sync');
    for (const entry of remove) await discord(env.DISCORD_TOKEN, 'DELETE', route(entry.discordRoleId!), undefined, 'Role sync');
    for (const group of groups) {
      if (!group.apply) continue;
      for (const role of group.add) await discord(env.DISCORD_TOKEN, 'PUT', route(role.id), undefined, `Group sync: ${group.source}`);
      for (const role of group.remove) await discord(env.DISCORD_TOKEN, 'DELETE', route(role.id), undefined, `Group sync: ${group.source}`);
    }
  }

  if (person) {
    const known = resolution.found?.kind === 'person' ? resolution.found.identity : undefined;
    const to = nicknameFor(person, person.rating < 1 ? null : await identityForNickname(env, person.cid, account.discordId, known));
    if (to) result.nickname = await applyNickname(env, run.server.guard, account, to, mode === 'dry-run');
  }

  console.log(`Role sync (${label}): ${account.discordId} ${summary(resolution, result)}${groupNote(groups, mode)}`);
}

/** What the sync made of one member: their CID (null when unresolved), the mapped roles changed, by name, and their nickname's outcome. */
type MemberSync = { cid: number | null; add: string[]; remove: string[]; nickname: NicknameOutcome | null };

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
function summary(resolution: Resolution<DiscordFound>, result: MemberSync): string {
  const removes = `remove ${result.remove.join(', ') || 'nothing'}`;
  if (resolution.kind === 'person') return `CID ${resolution.person.cid}: add ${result.add.join(', ') || 'nothing'}; ${removes}${nicknameNote(result.nickname)}`;
  switch (resolution.found?.kind) {
    case 'account-taken':
      return 'unresolved (this Discord account is linked to another member): no changes';
    case 'linked-elsewhere':
      return `unresolved (their CID is linked to another Discord account): ${removes}`;
    case 'shared-id':
      return `unresolved (${resolution.found.sharedCids.length} CIDs give this Discord ID): ${removes}`;
    default:
      return `unresolved: ${removes}`;
  }
}

function nicknameNote(nickname: NicknameOutcome | null): string {
  if (!nickname || nickname.outcome === 'unchanged') return '';
  if (nickname.outcome === 'skipped') return `; nickname left alone (${nickname.reason})`;
  return `; nickname "${nickname.to}"`;
}

/** One Discord ID on more than one CID: log it, and tell the tech team once until a run no longer finds it shared. */
async function reportSharedId(env: AlertEnv, discordId: string, cids: number[]): Promise<void> {
  const list = [...new Set(cids)].join(', ');
  console.log(`Role sync: Discord account ${discordId} is on VATUSA for more than one member (CIDs ${list})`);
  await postOnce(env, `${SHARED_PREFIX}${discordId}`, `Role sync: Discord account ${discordId} is on VATUSA for more than one member (CIDs ${list}). It gets no roles until one of them links it on their profile.`);
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
 * How resolvePerson found a Discord account's member, or why it found none. Every kind but `person` is
 * unresolved, which the job takes as a confirmed "no one" (but `account-taken`, left alone): every lookup
 * that fails (anything but a 404) throws instead.
 */
type DiscordFound =
  /** `identity` is the identity user the lookup found for them (undefined when it didn't ask identity). */
  | { kind: 'person'; person: VatusaPerson; identity?: IdentityUser | null }
  | { kind: 'no-one' }
  /** VATUSA gives this Discord ID to every one of `sharedCids`. */
  | { kind: 'shared-id'; sharedCids: number[] }
  /** Found by VATUSA's Discord ID, but their CID has linked a different account: this one is stale. */
  | { kind: 'linked-elsewhere' }
  /** Another member has linked this account in identity: its own job syncs it. */
  | { kind: 'account-taken' }
  /** A Discord bot account, never looked up. */
  | { kind: 'bot' };

/** identity's answer to "whose link is this account?", or the error when it couldn't answer. */
type LinkAnswer = { holder: IdentityUser | null } | { holder: null; unreachable: unknown };

/**
 * Who a Discord member is, from the cheapest source up. A CID given, or the CID whose identity link is
 * this Discord account, is looked for on the lists; otherwise their CID is the one whose VATUSA Discord ID
 * is theirs, and two CIDs claiming it is no answer. A VATUSA-only match whose CID is linked to a different
 * Discord account is a stale account and gets nothing. Off the lists, VATUSA's per-user lookup; for a CID
 * VATUSA doesn't know, only their rating from VATSIM.
 */
async function resolvePerson(env: Pick<RoleSyncEnv, 'KV'> & IdentityEnv, run: RunLists, member: { discordId: string; cid?: number }): Promise<Exclude<DiscordFound, { kind: 'bot' }>> {
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

/**
 * The Discord account to sync for a CID, by the role sync's rule: their identity link, else the VATUSA
 * Discord ID (from the newest run's lists, else VATUSA's per-user lookup), unless another member has
 * linked that account or the lists give it to more than one CID.
 */
export async function discordIdFor(env: RoleSyncEnv, cid: number, latestRun: () => Promise<RunLists | null>): Promise<DiscordRef | null> {
  const linked = (await getUser(env, cid))?.discordId;
  if (linked) return { id: linked, source: 'linked' };
  const latest = await latestRun();
  const person = latest?.people.find((candidate) => candidate.cid === cid) ?? (await lookupVatusa(env.KV, { cid }));
  if (!person?.discordId) return null;
  if (latest && sharedDiscordIds(latest.people).has(person.discordId)) return null;
  const holder = await findByDiscordId(env, person.discordId);
  return holder && holder.cid !== cid ? null : { id: person.discordId, source: 'vatusa' };
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

/**
 * RPC: link a Discord account to a member in identity, add them to the server when the caller passes
 * their one-time access token (`guilds.join`), and queue their sync. The token is sent to Discord once
 * and never kept or logged. A failed join keeps the link and the sync, then throws.
 */
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
    // Someone linked it between the check and the write.
    if (error instanceof IdentityConflict) throw new Error('That Discord account is linked to another member.');
    throw error;
  }
  const join = accessToken ? await joinServer(env, mode, discordId, accessToken) : { joined: false };
  await env.ROLE_SYNC_QUEUE.send(discordPlatform.messageFor(cid, { id: discordId, source: 'linked' }));
  if (join.failed) throw new Error("Your Discord account is linked, but we couldn't add you to the Indy Center Discord. Ask a staff member for an invite.");
  return { joined: join.joined };
}

/**
 * Add a member to the server with their access token, as the join bot. Only in `live`: it's a Discord write,
 * so `dry-run` logs it instead. Logs a failure, never the token.
 */
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
    // Discord answers 201 with the new member, or 204 (no body) for someone already in the server.
    const member = await discord<DiscordMember | undefined>(env.DISCORD_JOIN_BOT_TOKEN, 'PUT', `/guilds/${guildId(env)}/members/${discordId}`, { access_token: accessToken });
    return { joined: member !== undefined };
  } catch (error) {
    console.error(`Link Discord: couldn't add ${discordId} to the server: ${error instanceof Error ? error.message : String(error)}`);
    return { joined: false, failed: true };
  }
}
