import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MappingEntry } from '../src/mapping';
import { nicknameGuard } from '../src/nicknames';
import { discordPlatform, type DiscordAccount, type RunServer } from '../src/platforms/discord';
import type { Change, JobRun, Platform, Resolution } from '../src/platforms/platform';
import { syncAccount, type RoleSyncMessage } from '../src/role-sync';
import { peopleFrom } from '../src/vatusa';
import { fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, LARRY, type Write } from './fake-discord';
import { identityEnv, idUser } from './fake-identity';
import { fakeSource } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record } from './vatusa-records';

/**
 * The job is one account on one platform: its adapter resolves it, the mapping is matched, and the same
 * adapter applies the change. Shown with made-up platforms, and with Discord's.
 */

const JO = '820000000000000001';
const STRANGER = '820000000000000002';
const MEMBER_ROLE = '1125403438545641564';

type FakeAccount = { id: string; held: string[] };
type FakeRun = { untouchable: string[] };
type FakeTypes = { ref: string; account: FakeAccount; found: unknown; message: RoleSyncMessage; run: FakeRun; id: string };

/** A made-up platform whose groups are named after the mapping's entries. */
function fakePlatform(resolveTo: Resolution<unknown> = { kind: 'unresolved' }) {
  const calls = { resolve: [] as { account: FakeAccount; run: JobRun<FakeRun> }[], apply: [] as Change<FakeTypes>[] };
  const platform: Platform<FakeTypes> & { calls: typeof calls } = {
    calls,
    name: 'teamspeak',
    startRun: async () => ({ run: { untouchable: [] }, jobs: [] }),
    readRun: async () => ({ untouchable: [] }),
    isOwnMessage: (_message): _message is RoleSyncMessage => false,
    describeJob: () => ({ accountId: '' }),
    readAccount: async () => null,
    findAccount: async () => null,
    messageFor: (cid) => ({ type: 'ts-sync-cid', cid, uid: '' }),
    linkOf: () => null,
    unlink: async () => {},
    async resolve(_env, run, account) {
      calls.resolve.push({ account, run });
      return resolveTo;
    },
    heldIds: (account) => account.held,
    idFor: (entry: MappingEntry) => `group:${entry.name}`,
    untouchable: (run) => run.untouchable,
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
const people = () => peopleFrom(vatusa());
const jo = () => people().find((one) => one.cid === 1200001)!;
const fakeRun = (untouchable: string[] = []): JobRun<FakeRun> => ({ people: people(), platform: { untouchable } });
const discordRun = (): JobRun<RunServer> => ({ people: people(), platform: { skippedRoles: [], guard: nicknameGuard('999999999999999999', LARRY, []) } });
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

describe('one account on one platform', () => {
  it("gives a member's account the entries they match and takes the rest, on its own platform", async () => {
    const platform = fakePlatform({ kind: 'person', person: jo() });
    const account = { id: 'jo', held: ['group:Observer', 'hand-given'] };
    const run = fakeRun();

    await syncAccount(env as never, run, platform, account);

    expect(platform.calls.resolve).toEqual([{ account, run }]);
    expect(platform.calls.apply).toHaveLength(1);
    const change = platform.calls.apply[0]!;
    expect(change.account).toBe(account);
    expect(change.run).toBe(run);
    expect(names(change.add)).toEqual(['Student 3', 'Air Traffic Controller', 'Member']);
    expect(names(change.remove)).toEqual(['Observer']);
    expect(writes).toEqual([]);
  });

  it('leaves the IDs its run marks untouchable', async () => {
    const platform = fakePlatform({ kind: 'person', person: jo() });
    await syncAccount(env as never, fakeRun(['group:Member', 'group:Observer']), platform, { id: 'jo', held: ['group:Observer'] });
    const change = platform.calls.apply[0]!;
    expect(names(change.add)).toEqual(['Student 3', 'Air Traffic Controller']);
    expect(change.remove).toEqual([]);
  });

  it("takes an unresolved account's managed groups, without reading identity", async () => {
    const platform = fakePlatform();
    const account = { id: 'nobody', held: ['group:Member', 'group:Observer', 'hand-given'] };

    await syncAccount(env as never, fakeRun(), platform, account);

    const change = platform.calls.apply[0]!;
    expect(change.resolution.kind).toBe('unresolved');
    expect(change.add).toEqual([]);
    expect(names(change.remove)).toEqual(['Observer', 'Member']);
    expect(env.IDENTITY.apiCalls).toEqual([]);
  });

  it('leaves alone an account its adapter says to: nothing to add or take', async () => {
    const platform = fakePlatform({ kind: 'left-alone' });
    await syncAccount(env as never, fakeRun(), platform, { id: 'taken', held: ['group:Member'] }, 1200001);
    expect(platform.calls.apply).toHaveLength(1);
    expect(platform.calls.apply[0]!.add).toEqual([]);
    expect(platform.calls.apply[0]!.remove).toEqual([]);
  });

  it("syncs a Discord account through Discord's adapter: its roles, and only Discord's", async () => {
    await syncAccount(env as never, discordRun(), discordPlatform, discordAccount(JO));
    expect(writes.filter((write) => write.method === 'PUT').map((write) => write.path)).toContain(`/guilds/${GUILD}/members/${JO}/roles/${MEMBER_ROLE}`);
    // Roles and nickname: every write is to this member of the server.
    expect(writes.every((write) => write.path.startsWith(`/guilds/${GUILD}/members/${JO}`))).toBe(true);
  });

  it("takes an unresolved Discord account's roles", async () => {
    await syncAccount(env as never, discordRun(), discordPlatform, discordAccount(STRANGER, MEMBER_ROLE));
    expect(writes.map((write) => `${write.method} ${write.path}`)).toEqual([`DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${MEMBER_ROLE}`]);
  });
});
