import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { enqueueTsGroups, TeamSpeakJobs } from '../src/teamspeak-jobs';
import type { TsResult } from '../src/teamspeak-shape';
import { batchOf, fakeDurableObjects, fakeQueue } from './fake-cloudflare';

const TS_SECRET = 'made-up-teamspeak-bot-secret';
const URL = 'https://indy-larry.example.workers.dev';
const ALICE = 'aliceMadeUpUid0000000000000=';
const BOB = 'bobMadeUpUid000000000000000=';
const CAROL = 'carolMadeUpUid0000000000000=';
const START = new Date('2026-11-22T12:00:00Z');

function makeEnv() {
  return {
    TEAMSPEAK_BOT_SECRET: TS_SECRET,
    BOT_EVENTS_SECRET: 'made-up-bot-events-secret',
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    TEAMSPEAK_RESULTS: fakeQueue<TsResult>(),
    TEAMSPEAK_JOBS: fakeDurableObjects((ctx) => new TeamSpeakJobs(ctx, {})),
  };
}

let env: ReturnType<typeof makeEnv>;
let larry: Larry;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  env = makeEnv();
  larry = new Larry({} as ExecutionContext, env as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const later = (seconds: number) => vi.setSystemTime(new Date(START.getTime() + seconds * 1000));
const enqueue = (uid: string, add: number[], remove: number[]) => enqueueTsGroups(env as never, uid, add, remove);

function post(path: string, body: unknown, secret: string | null = TS_SECRET) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  return larry.fetch(new Request(`${URL}${path}`, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
}

async function pull(max = 10) {
  const res = await post('/teamspeak/jobs/pull', { max });
  expect(res.status).toBe(200);
  return ((await res.json()) as { jobs: { jobId: string; uid: string }[] }).jobs;
}

async function ack(acks: string[], retries: string[] = []) {
  const res = await post('/teamspeak/jobs/ack', { acks, retries });
  expect(res.status).toBe(204);
}

describe('enqueueTsGroups and the jobs store', () => {
  it('stores a set-groups job and hands it out on a pull, with the ID it returned', async () => {
    const jobId = await enqueue(ALICE, [12, 14], [9]);
    expect(jobId).toEqual(expect.any(String));
    expect(await pull()).toEqual([{ jobId, type: 'set-groups', uid: ALICE, add: [12, 14], remove: [9] }]);
  });

  it('refuses a job that is not a UID and lists of group IDs, and stores nothing', async () => {
    await expect(enqueueTsGroups(env as never, '', [1], [])).rejects.toThrow(TypeError);
    await expect(enqueueTsGroups(env as never, ALICE, [1.5], [])).rejects.toThrow(TypeError);
    await expect(enqueueTsGroups(env as never, ALICE, [], ['7' as never])).rejects.toThrow(TypeError);
    expect(await pull()).toEqual([]);
  });

  it('hands out the oldest jobs first, no more than asked for, and no more than 10', async () => {
    const ids = [];
    for (let i = 1; i <= 12; i++) ids.push(await enqueue(ALICE, [i], []));
    expect((await pull(2)).map((job) => job.jobId)).toEqual(ids.slice(0, 2));
    expect((await pull(50)).map((job) => job.jobId)).toEqual(ids.slice(2, 12));
  });

  it("doesn't hand a pulled job out again within its 60-second lease, and does after it", async () => {
    const jobId = await enqueue(ALICE, [12], []);
    expect(await pull()).toHaveLength(1);
    later(59);
    expect(await pull()).toEqual([]);
    later(60);
    expect((await pull()).map((job) => job.jobId)).toEqual([jobId]);
  });

  it('removes an acked job for good', async () => {
    const applied = await enqueue(ALICE, [12], []);
    const waiting = await enqueue(BOB, [12], []);
    await pull(1);
    await ack([applied]);
    later(120);
    expect((await pull()).map((job) => job.jobId)).toEqual([waiting]);
  });

  it('hands a job out again straight after a retry', async () => {
    const jobId = await enqueue(ALICE, [12], []);
    await pull();
    await ack([], [jobId]);
    expect((await pull()).map((job) => job.jobId)).toEqual([jobId]);
  });

  it('moves a job to the dead-letter table, logged, on its 5th retry', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobId = await enqueue(ALICE, [12], [9]);
    const other = await enqueue(BOB, [3], []);
    for (let tryNumber = 1; tryNumber <= 4; tryNumber++) {
      expect((await pull(1)).map((job) => job.jobId), `try ${tryNumber}`).toEqual([jobId]);
      await ack([], [jobId]);
    }
    expect(error).not.toHaveBeenCalled();
    await pull(1);
    await ack([], [jobId]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain(`TeamSpeak job ${jobId} moved to the dead-letter table after 5 tries`);
    expect(error.mock.calls[0]![0]).toContain(ALICE);
    expect((await pull()).map((job) => job.jobId)).toEqual([other]);
  });

  it('counts a lease running out as a try, so 5 of them move the job to the dead-letter table', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobId = await enqueue(CAROL, [12], []);
    for (let lease = 0; lease < 5; lease++) {
      later(lease * 61);
      expect((await pull()).map((job) => job.jobId), `lease ${lease + 1}`).toEqual([jobId]);
    }
    later(5 * 61);
    expect(await pull()).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![0]).toContain(`TeamSpeak job ${jobId} moved to the dead-letter table after 5 tries (last: its lease ran out)`);
  });

  it('ignores an ack or a retry for a job it no longer holds', async () => {
    const jobId = await enqueue(ALICE, [12], []);
    await pull();
    await ack(['no-such-job'], ['no-such-job-either']);
    later(61);
    expect((await pull()).map((job) => job.jobId)).toEqual([jobId]);
  });
});

describe("teamspeak-bot's routes", () => {
  const routes: [string, unknown][] = [
    ['/teamspeak/jobs/pull', { max: 10 }],
    ['/teamspeak/jobs/ack', { acks: [], retries: [] }],
    ['/teamspeak/results', { type: 'heartbeat', at: '2026-11-22T12:00:00Z' }],
  ];

  it("answers 401 on each route to no secret, a wrong one, and larry's bot's, and does nothing", async () => {
    const jobId = await enqueue(ALICE, [12], []);
    for (const [path, body] of routes) {
      for (const secret of [null, 'not-the-secret', `${TS_SECRET}x`, env.BOT_EVENTS_SECRET]) {
        expect((await post(path, body, secret)).status, `${path} ${secret}`).toBe(401);
      }
    }
    expect(env.TEAMSPEAK_RESULTS.sent).toEqual([]);
    expect((await pull()).map((job) => job.jobId)).toEqual([jobId]);
  });

  it('answers 401 on each route to everyone when the Worker has no TeamSpeak secret set', async () => {
    env.TEAMSPEAK_BOT_SECRET = undefined as never;
    for (const [path, body] of routes) expect((await post(path, body)).status, path).toBe(401);
    env.TEAMSPEAK_BOT_SECRET = '';
    for (const [path, body] of routes) expect((await post(path, body, '')).status, path).toBe(401);
  });

  it("refuses teamspeak-bot's secret on POST /bot/events", async () => {
    expect((await post('/bot/events', { type: 'sync-member', discordId: '500000000000000007' })).status).toBe(401);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('answers 400 to a pull without a whole-number max from 1', async () => {
    for (const body of [{}, { max: 0 }, { max: -1 }, { max: 2.5 }, { max: '10' }, 'not json', null]) {
      expect((await post('/teamspeak/jobs/pull', body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('answers 400 to an ack without both lists of job IDs, and changes nothing', async () => {
    const jobId = await enqueue(ALICE, [12], []);
    await pull();
    for (const body of [{}, { acks: [jobId] }, { retries: [jobId] }, { acks: jobId, retries: [] }, { acks: [1], retries: [] }, 'not json']) {
      expect((await post('/teamspeak/jobs/ack', body)).status, JSON.stringify(body)).toBe(400);
    }
    later(61);
    expect((await pull()).map((job) => job.jobId)).toEqual([jobId]);
  });

  it('puts one result, or each of several, on teamspeak-results and answers 202', async () => {
    const applied = { type: 'applied', jobId: 'job-1' };
    const failed = { type: 'failed', jobId: 'job-2', error: 'unknown uid' };
    const reconnected = { type: 'reconnected', at: '2026-11-22T12:01:00Z' };
    expect((await post('/teamspeak/results', applied)).status).toBe(202);
    expect((await post('/teamspeak/results', [failed, reconnected])).status).toBe(202);
    expect(env.TEAMSPEAK_RESULTS.sent).toEqual([applied, failed, reconnected]);
  });

  it('answers 400 to a body holding any result that is not a known one, and queues none of it', async () => {
    const good = { type: 'applied', jobId: 'job-1' };
    for (const body of [{ type: 'client-connected', uid: ALICE }, { type: 'applied' }, { type: 'failed', jobId: 'job-2', error: 7 }, { type: 'heartbeat' }, [good, { type: 'nope' }], [good, [good]], 'not json', null]) {
      expect((await post('/teamspeak/results', body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(env.TEAMSPEAK_RESULTS.sent).toEqual([]);
  });

  it('answers 404 to another method on a TeamSpeak route, or a path beside one', async () => {
    const get = await larry.fetch(new Request(`${URL}/teamspeak/jobs/pull`, { headers: { Authorization: `Bearer ${TS_SECRET}` } }));
    expect(get.status).toBe(404);
    for (const path of ['/teamspeak', '/teamspeak/jobs', '/teamspeak/jobs/pull/', '/teamspeak/results/']) {
      expect((await post(path, { max: 1 })).status, path).toBe(404);
    }
  });
});

describe('the teamspeak-results consumer', () => {
  it('logs each result type it is handed, and the batch succeeds', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const results: TsResult[] = [
      { type: 'applied', jobId: 'job-1' },
      { type: 'failed', jobId: 'job-2', error: 'unknown uid' },
      { type: 'failed', jobId: 'job-3' },
      { type: 'heartbeat', at: '2026-11-22T12:05:00Z' },
      { type: 'reconnected', at: '2026-11-22T12:06:00Z' },
    ];
    // Through the route, then as Queues delivers what the route put on the queue.
    expect((await post('/teamspeak/results', results)).status).toBe(202);
    const { batch, messages } = batchOf('teamspeak-results', env.TEAMSPEAK_RESULTS.sent);
    await larry.queue(batch);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      'TeamSpeak job job-1 applied',
      'teamspeak-bot heartbeat at 2026-11-22T12:05:00Z',
      'teamspeak-bot reconnected to ServerQuery at 2026-11-22T12:06:00Z',
    ]);
    expect(warn.mock.calls.map(([line]) => line)).toEqual(['TeamSpeak job job-2 failed: unknown uid', 'TeamSpeak job job-3 failed']);
    expect(messages.every((message) => !message.retried)).toBe(true);
  });
});
