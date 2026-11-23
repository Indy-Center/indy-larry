import type { Links } from '../client/api';
import type { IdentityUser } from '../identity';
import type { MappingEntry } from '../mapping';
import type { RoleSyncEnv, RoleSyncMessage } from '../role-sync';
import type { VatusaPerson } from '../vatusa';

/**
 * The platform seam. Each platform syncs on its own: its run, its jobs and its writes never wait on another
 * platform's. The role sync (role-sync.ts) gives a job the run's lists, works out which mapping entries the
 * account's member matches, and hands the change to the account's adapter; a platform adapter finds, reads
 * and writes accounts on its platform. Each adapter is registered in role-sync.ts's PLATFORMS: Discord's is
 * platforms/discord.ts, TeamSpeak's platforms/teamspeak.ts.
 */

/** `dry-run` (the default): log what would change, change nothing. `live`: change it. */
export type Mode = 'dry-run' | 'live';

export function checkMode(env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE'>): Mode {
  const mode = env.ROLE_SYNC_MODE ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'live') throw new Error(`ROLE_SYNC_MODE "${mode}" isn't supported; use dry-run or live`);
  return mode;
}

/** The types one adapter works in. */
export type PlatformTypes = {
  /** How a CID's account is named, for queueing its job and for getLinks(). */
  ref: unknown;
  /** An account as it stands now: what it holds. */
  account: unknown;
  /** The adapter's own note of how it resolved an account, for its log line and its extras. */
  found: unknown;
  /** Its messages on the `role-sync` queue. */
  message: RoleSyncMessage;
  /** What it reads once for a run and its jobs share (Discord: the server's roles). */
  run: unknown;
  /** A role or group ID on the platform. */
  id: string | number;
};

/** What a job reads besides its account: VATUSA's lists, and its own platform's part of the run. */
export type JobRun<Run> = { people: VatusaPerson[]; platform: Run };

/** Who an account belongs to, as its adapter found out. */
export type Resolution<Found> =
  /**
   * A member: their account gets the mapping's entries they match. `identity` is their identity record when
   * the adapter read it (null: they have none), so it isn't read again.
   */
  | { kind: 'person'; person: VatusaPerson; identity?: IdentityUser | null; found?: Found }
  /** A confirmed "no one": the account loses every managed role or group it holds on this platform. */
  | { kind: 'unresolved'; found?: Found }
  /** Left as it is: nothing added or removed. */
  | { kind: 'left-alone'; found?: Found };

/** What a job looks up about one CID, each read once, on first use. */
export type MemberLookups = {
  /** VATUSA's lists from the newest run, while they are kept. */
  latestPeople(): Promise<VatusaPerson[] | null>;
  /** Their identity record, or null when they have none. Throws when identity can't be reached. */
  identity(): Promise<IdentityUser | null>;
};

/** What the job asks an adapter to make true of one account. */
export type Change<T extends PlatformTypes> = {
  mode: Mode;
  run: JobRun<T['run']>;
  account: T['account'];
  resolution: Resolution<T['found']>;
  /** Mapping entries to give and take, in the mapping's order: never one the run marks untouchable. */
  add: MappingEntry[];
  remove: MappingEntry[];
  /** The member's identity record, read once (null for an account that resolved to no one). */
  identity: MemberLookups['identity'];
};

/** One platform. */
export interface Platform<T extends PlatformTypes> {
  /** Its key in getLinks() and unlink(). */
  name: keyof Links;

  /**
   * This platform's part of a cron run: read what the run needs once, and list the jobs to queue. Throws to
   * fail this platform's part only. An adapter whose accounts arrive later (TeamSpeak's) asks for them here
   * and queues their jobs when they come.
   */
  startRun(env: RoleSyncEnv, runId: string, people: VatusaPerson[]): Promise<{ run: T['run']; jobs: T['message'][] }>;
  /** What a job reads when no run holds this platform's part: it has no run, or its platform wasn't in the newest. */
  readRun(env: RoleSyncEnv): Promise<T['run']>;

  /** Whether a queue message is one of this adapter's. */
  isOwnMessage(message: RoleSyncMessage): message is T['message'];
  /** For a message of its own: the account it names (for log lines), the CID it already knows, and its run. */
  describeJob(message: T['message']): { accountId: string; cid?: number; runId?: string };
  /** The account a message names, as it stands now; null (logged) when it has gone. */
  readAccount(env: RoleSyncEnv, mode: Mode, message: T['message']): Promise<T['account'] | null>;

  /** The account a CID syncs on, by this platform's rule; null when none. */
  findAccount(env: RoleSyncEnv, cid: number, member: MemberLookups): Promise<T['ref'] | null>;
  /** The queue message that syncs a CID on that account. */
  messageFor(cid: number, ref: T['ref']): T['message'];
  /** What getLinks() reports for that account. */
  linkOf(ref: T['ref']): Links[keyof Links];
  /** Clear the member's link on this platform (unlink()). */
  unlink(env: RoleSyncEnv, cid: number): Promise<void>;

  /** Who an account belongs to. `cid` is given when the job already knows it. Throws when a lookup fails. */
  resolve(env: RoleSyncEnv, run: JobRun<T['run']>, account: T['account'], cid?: number): Promise<Resolution<T['found']>>;
  /** The IDs of the roles or groups the account holds. */
  heldIds(account: T['account']): T['id'][];
  /** The role or group a mapping entry gives on this platform, if any. */
  idFor(entry: MappingEntry): T['id'] | undefined;
  /** IDs this run won't add or remove on this platform. */
  untouchable(run: T['run']): T['id'][];
  /** Make the change (`live`) or log it (`dry-run`), with this platform's extras. Throws when the platform refuses. */
  apply(env: RoleSyncEnv, change: Change<T>): Promise<void>;
}

/** An adapter of any platform, as the registry holds them: each adapter's own types stay inside it. */
export type AnyPlatform = Platform<any>;
