import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { TeamSpeakJobs } from '../src/teamspeak-jobs';
import type { TeamSpeakJob, TeamSpeakResult } from '../src/teamspeak-shape';
import type { VatusaRecord } from '../src/vatusa';
import { batchOf, fakeDurableObjects, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, type Server, type Write } from './fake-discord';
import { identityEnv, idUser, type FakeUser } from './fake-identity';
import { fakeSource } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record } from './vatusa-records';

/**
 * TeamSpeak as the role sync's second platform: the cron asks teamspeak-bot for its accounts, the
 * `accounts` result queues their jobs, and each member's one job sets their groups with a `set-groups`
 * job (live only) beside their Discord roles. Made-up CIDs, UIDs and Discord IDs throughout.
 */

const JO_UID = 'joMadeUpUid00000000000000000=';
const SAM_UID = 'samMadeUpUid0000000000000000=';
const NOBODY_UID = 'nobodyMadeUpUid0000000000000=';
const JO_DISCORD = '830000000000000001';

const GROUP = { member: 7, atc: 10, s3: 15, s1: 17, mentor: 19, handGiven: 99 };
const ROLE = { member: '1125403438545641564', atc: '477495351838900254', student3: '896858107051909159' };
const MANAGED = [17, 16, 15, 14, 13, 12, 11, 20, 21, 19, 18, 24, 25, 23, 26, 10, 7];

/** A user in identity with their TeamSpeak link (and Discord link, if any). */
const tsUser = (cid: number, uid: string, discordId: string | null = null): FakeUser => ({ ...idUser(cid, discordId), teamspeak_uid: uid });

function makeEnv(mode: string, users: FakeUser[]) {
  return {
    DISCORD_TOKEN: 'token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: 'tech-team-alerts:300000000000000001',
    ROLE_SYNC_MODE: mode,
    KV: fakeKv(),
    TRAINING: fakeSource(),
    ...identityEnv(users),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<never>(),
    TEAMSPEAK_BOT_SECRET: 'made-up-teamspeak-bot-secret',
    TEAMSPEAK_RESULTS: fakeQueue<TeamSpeakResult>(),
    TEAMSPEAK_JOBS: fakeDurableObjects((ctx) => new TeamSpeakJobs(ctx, {})),
  };
}

/** VATUSA's lists with `zid` on ZID's roster, and someone on every list so the run isn't skipped. */
const listsWith = (...zid: VatusaRecord[]) =>
  lists(
    {
      ZID: [...zid, record({ cid: 1000092 })],
      ZME: [record({ cid: 1000093, facility: 'ZME' })],
      ZDC: [record({ cid: 1000094, facility: 'ZDC' })],
      ZAU: [record({ cid: 1000095, facility: 'ZAU' })],
      ZOB: [record({ cid: 1000096, facility: 'ZOB' })],
      ZTL: [record({ cid: 1000097, facility: 'ZTL' })],
      ZKC: [record({ cid: 1000098, facility: 'ZKC' })],
    },
    [record({ cid: 1000099, facility: 'ZHQ' })],
  );

/** A ZID S3 on the roster. */
const s3 = (cid: number, overrides: Partial<VatusaRecord> = {}) => record({ cid, rating: 4, rating_short: 'S3', ...overrides });

const emptyServer = (): Server => ({ roles: [], members: [] });

let env: ReturnType<typeof makeEnv>;
let larry: Larry;
let logs: string[];

function start(mode: string, users: FakeUser[]) {
  env = makeEnv(mode, users);
  larry = new Larry({} as ExecutionContext, env as never);
}

beforeEach(() => {
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((line: string) => void logs.push(line));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cron = () => larry.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController);

/** What teamspeak-bot answers `report-accounts` with, through the results consumer. */
async function report(holders: { uid: string; groups: number[] }[], connected: string[] = []) {
  const { batch, messages } = batchOf<TeamSpeakResult>('teamspeak-results', [{ type: 'accounts', holders, connected }]);
  await larry.queue(batch as never);
  return messages;
}

/** Deliver what has been queued on `role-sync` to the consumer. */
async function consume(bodies: RoleSyncMessage[] = env.ROLE_SYNC_QUEUE.sent.splice(0)) {
  const { batch, messages } = batchOf('role-sync', bodies);
  await larry.queue(batch as never);
  return messages;
}

/** Every job waiting in the TeamSpeak jobs store, oldest first. */
const tsJobs = async (): Promise<TeamSpeakJob[]> => {
  const store = env.TEAMSPEAK_JOBS.get(env.TEAMSPEAK_JOBS.idFromName('teamspeak-jobs'));
  return store.pull(10);
};
const setGroups = async () => (await tsJobs()).filter((job) => job.type === 'set-groups').map(({ uid, add, remove }) => ({ uid, add, remove }));

const roleWrites = (writes: Write[]) => writes.filter((write) => write.path.includes('/roles/')).map((write) => `${write.method} ${write.path}`);

describe('the cron asks teamspeak-bot for its accounts', () => {
  it('queues one report-accounts job carrying every group the mapping names', async () => {
    start('dry-run', []);
    fakeVatusaAndDiscord(listsWith(), emptyServer());
    await cron();

    const jobs = await tsJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'report-accounts' });
    expect([...(jobs[0] as { groups: number[] }).groups].sort((a, b) => a - b)).toEqual([...MANAGED].sort((a, b) => a - b));
    // Nothing for TeamSpeak is queued on role-sync until the bot answers.
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it("skips and logs a run's TeamSpeak part when the bot hasn't answered by the next run", async () => {
    start('live', [tsUser(1000001, JO_UID)]);
    fakeVatusaAndDiscord(listsWith(s3(1000001)), emptyServer());
    await cron();
    const first = env.KV.store.get('role-sync:latest-run');
    await cron();

    expect(logs).toContain(`Role sync: TeamSpeak's part of run ${first} skipped: teamspeak-bot didn't answer report-accounts before the next run`);
  });

  it('holds one report-accounts job when two runs go unanswered', async () => {
    start('live', [tsUser(1000001, JO_UID)]);
    fakeVatusaAndDiscord(listsWith(s3(1000001)), emptyServer());
    await cron();
    await cron();

    expect((await tsJobs()).filter((job) => job.type === 'report-accounts')).toHaveLength(1);
  });

  it("takes the bot's accounts on its results route, and refuses a malformed one", async () => {
    start('live', []);
    const post = (body: unknown) =>
      larry.fetch(new Request('https://indy-larry.example.workers.dev/teamspeak/results', { method: 'POST', headers: { Authorization: `Bearer ${env.TEAMSPEAK_BOT_SECRET}` }, body: JSON.stringify(body) }));
    const good = { type: 'accounts', holders: [{ uid: JO_UID, groups: [7, 99] }], connected: [SAM_UID] };
    expect((await post(good)).status).toBe(202);
    for (const bad of [
      { type: 'accounts', holders: [{ uid: JO_UID, groups: ['7'] }], connected: [] },
      { type: 'accounts', holders: [{ uid: '', groups: [] }], connected: [] },
      { type: 'accounts', holders: [], connected: [7] },
      { type: 'accounts', holders: [] },
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(env.TEAMSPEAK_RESULTS.sent).toEqual([good]);
  });

  it("ignores accounts no run asked for", async () => {
    start('live', [tsUser(1000001, JO_UID)]);
    fakeVatusaAndDiscord(listsWith(s3(1000001)), emptyServer());
    const messages = await report([{ uid: JO_UID, groups: [] }]);

    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
    expect(messages[0]!.acked).toBe(true);
    expect(logs).toContain('Role sync: teamspeak-bot sent its accounts, but no run is waiting for them; ignored');
  });
});

describe("a linked member's groups", () => {
  it('queues exactly the set-groups that adds the groups they lack and takes the one they should not hold, leaving unmapped groups alone', async () => {
    start('live', [tsUser(1000001, JO_UID)]);
    fakeVatusaAndDiscord(listsWith(s3(1000001)), emptyServer());
    await cron();
    await report([{ uid: JO_UID, groups: [GROUP.member, GROUP.s1, GROUP.handGiven] }]);
    const messages = await consume();

    expect(await setGroups()).toEqual([{ uid: JO_UID, add: [GROUP.s3, GROUP.atc], remove: [GROUP.s1] }]);
    expect(messages.every((message) => message.acked)).toBe(true);
    expect(logs).toContain(`Role sync (live): TeamSpeak ${JO_UID} CID 1000001: add Student 3, Air Traffic Controller; remove Student 1`);
  });

  it('queues nothing when their groups already match', async () => {
    start('live', [tsUser(1000001, JO_UID)]);
    fakeVatusaAndDiscord(listsWith(s3(1000001)), emptyServer());
    await cron();
    await report([{ uid: JO_UID, groups: [GROUP.s3, GROUP.atc, GROUP.member, GROUP.handGiven] }]);
    await consume();

    expect(await setGroups()).toEqual([]);
    expect(logs).toContain(`Role sync (live): TeamSpeak ${JO_UID} CID 1000001: add nothing; remove nothing`);
  });

  it('gives every group to a member connected with none, and queues nothing in dry-run', async () => {
    for (const mode of ['live', 'dry-run']) {
      start(mode, [tsUser(1000001, JO_UID)]);
      fakeVatusaAndDiscord(listsWith(s3(1000001)), emptyServer());
      await cron();
      await report([], [JO_UID]);
      await consume();

      expect(await setGroups()).toEqual(mode === 'live' ? [{ uid: JO_UID, add: [GROUP.s3, GROUP.atc, GROUP.member], remove: [] }] : []);
    }
    expect(logs).toContain(`Role sync (dry run): TeamSpeak ${JO_UID} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing`);
  });
});

describe('unresolved TeamSpeak identities', () => {
  it('takes every managed group from a UID no member has linked, and nothing else', async () => {
    start('live', []);
    fakeVatusaAndDiscord(listsWith(), emptyServer());
    await cron();
    await report([{ uid: NOBODY_UID, groups: [GROUP.member, GROUP.mentor, GROUP.handGiven] }]);
    await consume();

    expect(await setGroups()).toEqual([{ uid: NOBODY_UID, add: [], remove: [GROUP.mentor, GROUP.member] }]);
    expect(logs).toContain(`Role sync (live): TeamSpeak ${NOBODY_UID} unresolved: remove Mentor, Member`);
  });

  it('takes every managed group from a member rated 0', async () => {
    start('live', [tsUser(1000004, JO_UID)]);
    fakeVatusaAndDiscord(listsWith(record({ cid: 1000004, rating: 0, rating_short: 'SUS' })), emptyServer());
    await cron();
    await report([{ uid: JO_UID, groups: [GROUP.member, GROUP.s3, GROUP.handGiven] }]);
    await consume();

    expect(await setGroups()).toEqual([{ uid: JO_UID, add: [], remove: [GROUP.s3, GROUP.member] }]);
  });

  it('takes the groups of a linked member VATUSA and VATSIM no longer know', async () => {
    start('live', [tsUser(1000050, JO_UID)]);
    fakeVatusaAndDiscord(listsWith(), emptyServer());
    await cron();
    await report([{ uid: JO_UID, groups: [GROUP.member] }]);
    await consume();

    expect(await setGroups()).toEqual([{ uid: JO_UID, add: [], remove: [GROUP.member] }]);
  });

  it('retries, and removes nothing, when identity is down', async () => {
    start('live', []);
    fakeVatusaAndDiscord(listsWith(), emptyServer());
    await cron();
    await report([{ uid: NOBODY_UID, groups: [GROUP.member] }]);
    env.IDENTITY.down = true;
    const messages = await consume();

    expect(await setGroups()).toEqual([]);
    expect(messages.map((message) => [message.acked, message.retried])).toEqual([[false, true]]);
  });
});

describe('a member on Discord and TeamSpeak', () => {
  const both = () => {
    start('live', [tsUser(1000001, JO_UID, JO_DISCORD)]);
    return fakeVatusaAndDiscord(listsWith(s3(1000001)), { roles: [], members: [{ user: { id: JO_DISCORD }, roles: [ROLE.member], nick: 'Test Person1000001' }] });
  };

  it("gets one job in a run, which applies both: the TeamSpeak account's own job leaves them to Discord's", async () => {
    const { writes } = both();
    await cron();
    await report([{ uid: JO_UID, groups: [GROUP.member] }]);
    expect(env.ROLE_SYNC_QUEUE.sent.map((job) => job.type)).toEqual(['run-member', 'ts-run-account']);
    await consume();

    expect(roleWrites(writes)).toEqual([`PUT /guilds/${GUILD}/members/${JO_DISCORD}/roles/${ROLE.student3}`, `PUT /guilds/${GUILD}/members/${JO_DISCORD}/roles/${ROLE.atc}`]);
    expect(await setGroups()).toEqual([{ uid: JO_UID, add: [GROUP.s3, GROUP.atc], remove: [] }]);
    expect(logs).toContain("Role sync: CID 1000001 is synced by this run's discord job, not again from teamspeak");
  });

  it('gets one job from syncMembers, which applies both', async () => {
    const { writes } = both();
    await cron();
    await report([{ uid: JO_UID, groups: [GROUP.member] }]);
    await consume();
    writes.length = 0;
    await tsJobs();

    env.KV.store.set('role-sync:teamspeak:accounts', JSON.stringify({ runId: 'r', groups: { [JO_UID]: [GROUP.member, GROUP.s1] } }));
    expect(await larry.syncMembers([1000001])).toEqual([{ cid: 1000001, queued: true }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: JO_DISCORD }]);
    await consume();
    expect(await setGroups()).toEqual([{ uid: JO_UID, add: [GROUP.s3, GROUP.atc], remove: [GROUP.s1] }]);
  });
});

describe('a member only on TeamSpeak', () => {
  it('gets one TeamSpeak job from syncMembers, and shows their link', async () => {
    start('live', [tsUser(1000002, SAM_UID)]);
    fakeVatusaAndDiscord(listsWith(s3(1000002)), emptyServer());
    await cron();
    await report([{ uid: SAM_UID, groups: [GROUP.member] }]);
    await consume();
    await tsJobs();

    expect(await larry.getLinks(1000002)).toEqual({ discord: null, teamspeak: { uid: SAM_UID } });
    expect(await larry.syncMembers([1000002])).toEqual([{ cid: 1000002, queued: true }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'ts-sync-cid', cid: 1000002, uid: SAM_UID }]);
    await consume();
    // The kept accounts say they hold Member only; the job before this one's set-groups isn't seen yet.
    expect(await setGroups()).toEqual([{ uid: SAM_UID, add: [GROUP.s3, GROUP.atc], remove: [] }]);
  });
});
