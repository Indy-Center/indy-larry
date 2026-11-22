import type { Links } from '../client/api';
import type { MappingEntry } from '../mapping';
import type { RoleSyncEnv, RoleSyncMessage, RunLists } from '../role-sync';
import type { VatusaPerson } from '../vatusa';

/**
 * The platform seam. The role sync (role-sync.ts) works out once who a member is and which mapping entries
 * they match; a platform adapter finds, reads and writes that member's account on one platform. Each
 * adapter is registered in role-sync.ts's PLATFORMS. Discord's is platforms/discord.ts.
 */

/** `dry-run` (the default): log what would change, change nothing. `live`: change it. */
export type Mode = 'dry-run' | 'live';

export function checkMode(env: Pick<RoleSyncEnv, 'ROLE_SYNC_MODE'>): Mode {
  const mode = env.ROLE_SYNC_MODE ?? 'dry-run';
  if (mode !== 'dry-run' && mode !== 'live') throw new Error(`ROLE_SYNC_MODE "${mode}" isn't supported; use dry-run or live`);
  return mode;
}

/**
 * Who an account belongs to, as its adapter found out. `found` is the adapter's own note of how (for its
 * log line and its extras); it is absent when the account was reached from a member another adapter found.
 */
export type Resolution<Found> =
  /** A member: their account gets the mapping's entries they match. */
  | { kind: 'person'; person: VatusaPerson; found?: Found }
  /** A confirmed "no one": the account loses every managed role or group it holds on this platform. */
  | { kind: 'unresolved'; found?: Found }
  /** Left as it is: nothing added or removed. */
  | { kind: 'left-alone'; found?: Found };

/** What the job asks an adapter to make true of one account. */
export type Change<Account, Found> = {
  mode: Mode;
  run: RunLists;
  account: Account;
  resolution: Resolution<Found>;
  /** Mapping entries to give and take, in the mapping's order: never one the adapter's guard skips. */
  add: MappingEntry[];
  remove: MappingEntry[];
};

/** The parts of a run's KV record an adapter keeps, beside the shared `people`. */
export type PlatformRun = Partial<Omit<RunLists, 'people'>>;

/**
 * One platform. `Ref` is how a CID's account is named (for queueing and getLinks); `Account` is that account
 * as it stands now (what it holds); `Found` is the adapter's note on how it resolved one.
 */
export interface Platform<Ref, Account, Found> {
  /** Its key in getLinks() and unlink(). */
  name: keyof Links;

  /** The cron: list the accounts to sync, and read what this run needs once. Throws to fail the run. */
  listAccounts(env: RoleSyncEnv, people: VatusaPerson[]): Promise<{ run: PlatformRun; jobs(runId: string): RoleSyncMessage[] }>;
  /** What a job with no run of its own reads in place of a run's record. */
  freshRun(env: RoleSyncEnv): Promise<PlatformRun>;

  /** Whether a queue message is one of this adapter's. */
  owns(message: RoleSyncMessage): boolean;
  /** A message's account ID (for log lines), the CID it already names, and the run it belongs to. */
  jobOf(message: RoleSyncMessage): { accountId: string; cid?: number; runId?: string };
  /** The account a message names, as it stands now; null (logged) when it has gone. */
  accountOf(env: RoleSyncEnv, mode: Mode, message: RoleSyncMessage): Promise<Account | null>;

  /** The account a CID syncs on, by this platform's rule; null when none. `latest` reads the newest run's record. */
  accountFor(env: RoleSyncEnv, cid: number, latest: () => Promise<RunLists | null>): Promise<Ref | null>;
  /** That account as it stands now; null (logged) when it has gone. */
  current(env: RoleSyncEnv, ref: Ref): Promise<Account | null>;
  /** The queue message that syncs a CID on that account. */
  messageFor(cid: number, ref: Ref): RoleSyncMessage;
  /** What getLinks() reports for that account. */
  linkOf(ref: Ref): Links[keyof Links];
  /** Clear the member's link on this platform (unlink()). */
  unlink(env: RoleSyncEnv, cid: number): Promise<void>;

  /** Who an account belongs to. `cid` is given when the job already knows it. Throws when a lookup fails. */
  resolve(env: RoleSyncEnv, run: RunLists, account: Account, cid?: number): Promise<Resolution<Found>>;
  /** The IDs of the roles or groups the account holds. */
  held(account: Account): string[];
  /** The role or group a mapping entry gives on this platform, if any. */
  idOf(entry: MappingEntry): string | undefined;
  /** The guard: IDs this run won't touch on this platform. */
  skipped(run: RunLists): string[];
  /** Make the change (`live`) or log it (`dry-run`), with this platform's extras. Throws when the platform refuses. */
  apply(env: RoleSyncEnv, change: Change<Account, Found>): Promise<void>;
}

/** An adapter of any platform, as the registry holds them: each adapter's own types stay inside it. */
export type AnyPlatform = Platform<any, any, any>;
