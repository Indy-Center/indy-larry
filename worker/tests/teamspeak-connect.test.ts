import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { TeamSpeakJobs } from '../src/teamspeak-jobs';
import type { TeamSpeakJob, TeamSpeakResult } from '../src/teamspeak-shape';
import { batchOf, fakeDurableObjects, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, type Server, type Write } from './fake-discord';
import { identityEnv, idUser, type FakeUser } from './fake-identity';
import { fakeSource } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record } from './vatusa-records';

/**
 * Sync on TeamSpeak connect, a full sync on `reconnected`, and the quiet alert: driven through the
 * results consumer and the cron. Made-up CIDs and UIDs throughout.
 */

const JO_UID = 'joMadeUpUid00000000000000000=';
const ALERTS = '300000000000000001';
const MINUTE = 60_000;
const START = new Date('2026-11-22T12:00:00Z');

const QUIET = "teamspeak-bot hasn't reported in 30 minutes. TeamSpeak groups aren't syncing.";
const BACK = 'teamspeak-bot is back.';

const tsUser = (cid: number, uid: string | null): FakeUser => ({ ...idUser(cid, null), teamspeak_uid: uid });

function makeEnv(users: FakeUser[]) {
  return {
    DISCORD_TOKEN: 'token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: `tech-team-alerts:${ALERTS}`,
    ROLE_SYNC_MODE: 'live',
    KV: fakeKv({ expire: true }),
    TRAINING: fakeSource(),
    ...identityEnv(users),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<never>(),
    TEAMSPEAK_BOT_SECRET: 'made-up-teamspeak-bot-secret',
    TEAMSPEAK_RESULTS: fakeQueue<TeamSpeakResult>(),
    TEAMSPEAK_JOBS: fakeDurableObjects((ctx) => new TeamSpeakJobs(ctx, {})),
  };
}

const goodLists = () =>
  lists(
    {
      ZID: [record({ cid: 1000092 })],
      ZME: [record({ cid: 1000093, facility: 'ZME' })],
      ZDC: [record({ cid: 1000094, facility: 'ZDC' })],
      ZAU: [record({ cid: 1000095, facility: 'ZAU' })],
      ZOB: [record({ cid: 1000096, facility: 'ZOB' })],
      ZTL: [record({ cid: 1000097, facility: 'ZTL' })],
      ZKC: [record({ cid: 1000098, facility: 'ZKC' })],
    },
    [record({ cid: 1000099, facility: 'ZHQ' })],
  );
const emptyServer = (): Server => ({ roles: [], members: [] });

let env: ReturnType<typeof makeEnv>;
let larry: Larry;
let writes: Write[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  env = makeEnv([tsUser(1000001, JO_UID)]);
  larry = new Larry({} as ExecutionContext, env as never);
  ({ writes } = fakeVatusaAndDiscord(goodLists(), emptyServer()));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const later = (minutes: number) => vi.setSystemTime(new Date(Date.now() + minutes * MINUTE));
const cron = () => larry.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController);
const alerts = () => writes.filter((write) => write.path === `/channels/${ALERTS}/messages`).map((write) => write.body?.content);

async function receive(...results: TeamSpeakResult[]) {
  const { batch, messages } = batchOf<TeamSpeakResult>('teamspeak-results', results);
  await larry.queue(batch as never);
  return messages;
}
const connect = () => receive({ type: 'client-connected', uid: JO_UID, clientId: 5, nickname: 'Jo' });
/** Jo is the only member and has only TeamSpeak, so every queued sync is theirs. */
const queuedFor = (_cid: number) => env.ROLE_SYNC_QUEUE.sent;

describe('a linked member connecting', () => {
  it('queues their sync, and a second connect within 5 minutes queues none', async () => {
    await connect();
    expect(queuedFor(1000001)).toHaveLength(1);

    later(4);
    await connect();
    expect(queuedFor(1000001)).toHaveLength(1);
  });

  it('queues another once 5 minutes have passed', async () => {
    await connect();
    later(5);
    await connect();
    expect(queuedFor(1000001)).toHaveLength(2);
  });
});

describe('reconnected', () => {
  it('starts a full sync, as the cron does', async () => {
    const messages = await receive({ type: 'reconnected', at: '2026-11-22T12:00:00Z' });

    expect(messages[0]!.acked).toBe(true);
    // The cron's TeamSpeak part: one report-accounts job asking teamspeak-bot for its accounts.
    const store = env.TEAMSPEAK_JOBS.get(env.TEAMSPEAK_JOBS.idFromName('teamspeak-jobs'));
    const jobs: TeamSpeakJob[] = store.pull(10);
    expect(jobs.map((job) => job.type)).toEqual(['report-accounts']);
  });
});

describe('the quiet alert', () => {
  it('posts once after 30 minutes without a result, and the all-clear once on the next', async () => {
    await receive({ type: 'heartbeat', at: '2026-11-22T12:00:00Z' });

    later(29);
    await cron();
    expect(alerts()).toEqual([]);

    later(2);
    await cron();
    later(15);
    await cron();
    expect(alerts()).toEqual([QUIET]);

    await receive({ type: 'heartbeat', at: '2026-11-22T12:46:00Z' });
    await receive({ type: 'heartbeat', at: '2026-11-22T12:47:00Z' });
    expect(alerts()).toEqual([QUIET, BACK]);
  });

  it('posts again for a later silence', async () => {
    await receive({ type: 'heartbeat', at: '2026-11-22T12:00:00Z' });
    later(31);
    await cron();
    await receive({ type: 'heartbeat', at: '2026-11-22T12:31:00Z' });
    later(31);
    await cron();
    expect(alerts()).toEqual([QUIET, BACK, QUIET]);
  });

  it('posts nothing while the bot has never reported', async () => {
    await cron();
    later(60);
    await cron();
    expect(alerts()).toEqual([]);
  });
});
