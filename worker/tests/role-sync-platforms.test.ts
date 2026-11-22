import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MappingEntry } from '../src/mapping';
import { nicknameGuard } from '../src/nicknames';
import { discordPlatform, type DiscordAccount } from '../src/platforms/discord';
import type { Change, Platform, Resolution } from '../src/platforms/platform';
import { syncAccount, type RoleSyncMessage, type RunLists } from '../src/role-sync';
import { peopleFrom } from '../src/vatusa';
import { fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, LARRY, type Write } from './fake-discord';
import { identityEnv, idUser } from './fake-identity';
import { fakeSource } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record } from './vatusa-records';

/**
 * The job is one per member: it resolves the member once, then calls every registered adapter for the
 * member's account on it. Shown with a made-up second platform beside Discord, and two made up alone.
 */

const JO = '820000000000000001';
const STRANGER = '820000000000000002';
const MEMBER_ROLE = '1125403438545641564';

type FakeAccount = { id: string; held: string[] };

/** A made-up platform whose groups are named after the mapping's entries; `accounts` by CID. */
function fakePlatform(accounts: Record<number, FakeAccount>, resolveTo: Resolution<unknown> = { kind: 'unresolved' }) {
  const calls = { resolve: [] as FakeAccount[], accountFor: [] as number[], current: [] as string[], apply: [] as Change<FakeAccount, unknown>[] };
  const platform: Platform<string, FakeAccount, unknown> & { calls: typeof calls } = {
    calls,
    name: 'teamspeak',
    listAccounts: async () => ({ run: {}, jobs: () => [] }),
    freshRun: async () => ({}),
    owns: () => false,
    jobOf: () => ({ accountId: '' }),
    accountOf: async () => null,
    async accountFor(_env, cid) {
      calls.accountFor.push(cid);
      return accounts[cid]?.id ?? null;
    },
    async current(_env, ref) {
      calls.current.push(ref);
      return Object.values(accounts).find((account) => account.id === ref) ?? null;
    },
    messageFor: (cid) => ({ type: 'sync-cid', cid, discordId: '' }) as RoleSyncMessage,
    linkOf: () => null,
    unlink: async () => {},
    async resolve(_env, _run, account) {
      calls.resolve.push(account);
      return resolveTo;
    },
    held: (account) => account.held,
    idOf: (entry: MappingEntry) => `group:${entry.name}`,
    skipped: () => [],
    async apply(_env, change) {
      calls.apply.push(change);
    },
  };
  return platform;
}

const names = (entries: MappingEntry[]) => entries.map((entry) => entry.name);

function makeEnv() {
  return {
    DISCORD_TOKEN: 'token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: 'tech-team-alerts:300000000000000001',
    ROLE_SYNC_MODE: 'live',
    KV: fakeKv(),
    TRAINING: fakeSource(),
    ...identityEnv([idUser(1200001, JO)]),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<never>(),
  };
}

const vatusa = () => lists({ ZID: [record({ cid: 1200001, rating: 4, rating_short: 'S3' })] });
const run = (): RunLists => ({ people: peopleFrom(vatusa()), server: { skippedRoles: [], guard: nicknameGuard('999999999999999999', LARRY, []) } });
const discordAccount = (discordId: string, ...roleIds: string[]): DiscordAccount => ({ discordId, roleIds, nick: null });

let env: ReturnType<typeof makeEnv>;
let writes: Write[];

beforeEach(() => {
  env = makeEnv();
  writes = fakeVatusaAndDiscord(vatusa(), { members: [{ user: { id: JO }, roles: [], nick: null }, { user: { id: STRANGER }, roles: [MEMBER_ROLE], nick: null }] }).writes;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('one job per member, every platform', () => {
  it("syncs a resolved Discord member's account on the second platform too, once, with the same mapping entries", async () => {
    const second = fakePlatform({ 1200001: { id: 'ts-jo', held: ['group:Observer'] } });

    await syncAccount(env as never, run(), discordPlatform, discordAccount(JO), undefined, [discordPlatform, second]);

    // Discord: the S3's roles, as ever.
    expect(writes.filter((write) => write.method === 'PUT').map((write) => write.path)).toContain(`/guilds/${GUILD}/members/${JO}/roles/${MEMBER_ROLE}`);
    // The second platform: found by CID, read, and given the same entries; never asked to resolve.
    expect(second.calls.accountFor).toEqual([1200001]);
    expect(second.calls.current).toEqual(['ts-jo']);
    expect(second.calls.resolve).toEqual([]);
    expect(second.calls.apply).toHaveLength(1);
    const change = second.calls.apply[0]!;
    expect(change.resolution).toMatchObject({ kind: 'person', person: { cid: 1200001 } });
    expect(names(change.add)).toEqual(['Student 3', 'Air Traffic Controller', 'Member']);
    expect(names(change.remove)).toEqual(['Observer']);
  });

  it('skips a platform the member has no account on', async () => {
    const second = fakePlatform({});
    await syncAccount(env as never, run(), discordPlatform, discordAccount(JO), undefined, [discordPlatform, second]);
    expect(second.calls.accountFor).toEqual([1200001]);
    expect(second.calls.current).toEqual([]);
    expect(second.calls.apply).toEqual([]);
  });

  it("takes an unresolved Discord account's roles on Discord only", async () => {
    const second = fakePlatform({ 1200001: { id: 'ts-jo', held: [] } });

    await syncAccount(env as never, run(), discordPlatform, discordAccount(STRANGER, MEMBER_ROLE), undefined, [discordPlatform, second]);

    expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([`DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${MEMBER_ROLE}`]);
    expect(second.calls).toEqual({ resolve: [], accountFor: [], current: [], apply: [] });
  });

  it("takes an unresolved account's groups on its own platform only", async () => {
    const origin = fakePlatform({});
    const other = fakePlatform({});
    const account = { id: 'ts-nobody', held: ['group:Member', 'group:Observer', 'hand-given'] };

    await syncAccount(env as never, run(), origin, account, undefined, [origin, discordPlatform, other]);

    expect(origin.calls.resolve).toEqual([account]);
    expect(origin.calls.apply).toHaveLength(1);
    expect(origin.calls.apply[0]!.resolution.kind).toBe('unresolved');
    expect(names(origin.calls.apply[0]!.remove)).toEqual(['Observer', 'Member']);
    expect(origin.calls.apply[0]!.add).toEqual([]);
    expect(other.calls).toEqual({ resolve: [], accountFor: [], current: [], apply: [] });
    expect(writes).toEqual([]);
    expect(env.IDENTITY.apiCalls).toEqual([]);
  });

  it('calls each of two platforms once for a member, the origin on its own account', async () => {
    const person = peopleFrom(vatusa()).find((one) => one.cid === 1200001)!;
    const origin = fakePlatform({}, { kind: 'person', person });
    const other = fakePlatform({ 1200001: { id: 'other-jo', held: [] } });
    const account = { id: 'origin-jo', held: [] };

    await syncAccount(env as never, run(), origin, account, undefined, [origin, other]);

    expect(origin.calls.resolve).toEqual([account]);
    expect(origin.calls.accountFor).toEqual([]);
    expect(origin.calls.apply.map((change) => change.account)).toEqual([account]);
    expect(other.calls.resolve).toEqual([]);
    expect(other.calls.apply.map((change) => change.account)).toEqual([{ id: 'other-jo', held: [] }]);
    // The mapping was matched once, for both: the same entries each way.
    expect(names(origin.calls.apply[0]!.add)).toEqual(names(other.calls.apply[0]!.add));
  });

  it('leaves alone an account its adapter says to: nothing to add or take, and no other platform', async () => {
    const origin = fakePlatform({}, { kind: 'left-alone' });
    const other = fakePlatform({ 1200001: { id: 'other-jo', held: [] } });
    await syncAccount(env as never, run(), origin, { id: 'taken', held: ['group:Member'] }, 1200001, [origin, other]);
    expect(origin.calls.apply).toHaveLength(1);
    expect(origin.calls.apply[0]!.add).toEqual([]);
    expect(origin.calls.apply[0]!.remove).toEqual([]);
    expect(other.calls.apply).toEqual([]);
  });
});
