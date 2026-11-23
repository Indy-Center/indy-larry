import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { batches, readRows, report, seed, type SeedRow } from '../scripts/seed-ts-links';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { fakeDurableObjects, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD } from './fake-discord';
import { identityEnv, idUser, type FakeUser } from './fake-identity';
import { fakeSource } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { TeamSpeakJobs } from '../src/teamspeak-jobs';
import type { TeamSpeakResult } from '../src/teamspeak-shape';
import { lists, record } from './vatusa-records';

/**
 * The cutover's seed: POST /teamspeak/seed, and the script that sends it the legacy bot's rows. Made-up
 * CIDs, Discord IDs and UIDs; identity and VATUSA are the hand-written fakes.
 */

const SEED_SECRET = 'made-up-seed-secret';
const URL = 'https://indy-larry.example.workers.dev';
const D = (n: number) => `83000000000000${String(n).padStart(4, '0')}`;
const UID = (name: string) => `${name}MadeUpUid0000000000000000=`;

const tsUser = (cid: number, uid: string | null, discordId: string | null = null): FakeUser => ({ ...idUser(cid, discordId), teamspeak_uid: uid });

let env: ReturnType<typeof makeEnv>;
let larry: Larry;
let vatusaCalls: string[];

function makeEnv(users: FakeUser[]) {
  return {
    DISCORD_TOKEN: 'token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: 'tech-team-alerts:300000000000000001',
    ROLE_SYNC_MODE: 'live',
    KV: fakeKv({ expire: true }),
    TRAINING: fakeSource(),
    ...identityEnv(users),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<never>(),
    BOT_EVENTS_SECRET: 'made-up-bot-events-secret',
    TEAMSPEAK_BOT_SECRET: 'made-up-teamspeak-bot-secret',
    TEAMSPEAK_SEED_SECRET: SEED_SECRET,
    TEAMSPEAK_RESULTS: fakeQueue<TeamSpeakResult>(),
    TEAMSPEAK_JOBS: fakeDurableObjects((ctx) => new TeamSpeakJobs(ctx, {})),
  };
}

/** VATUSA knows 1002 (Discord D(2)) and 1003 (D(3)) and 1005 (D(5)); identity has the CIDs given. */
function start(users: FakeUser[]) {
  env = makeEnv(users);
  larry = new Larry({} as ExecutionContext, env as never);
  ({ vatusaCalls } = fakeVatusaAndDiscord(vatusaLists(), { roles: [], members: [] }));
}

/** Lists with someone on each (VATUSA's fetch treats an empty roster or staff list as a failure). */
function vatusaLists() {
  const zid = [record({ cid: 1002, discord_id: D(2) }), record({ cid: 1003, discord_id: D(3) }), record({ cid: 1005, discord_id: D(5) })];
  const filler = (cid: number, facility: string) => [record({ cid, facility })];
  return lists({ ZID: zid, ZME: filler(2001, 'ZME'), ZDC: filler(2002, 'ZDC'), ZAU: filler(2003, 'ZAU'), ZOB: filler(2004, 'ZOB'), ZTL: filler(2005, 'ZTL'), ZKC: filler(2006, 'ZKC') }, filler(2007, 'ZID'));
}

const post = (body: unknown, authorization: string | null = `Bearer ${SEED_SECRET}`, path = '/teamspeak/seed') =>
  larry.fetch(new Request(`${URL}${path}`, { method: 'POST', headers: authorization === null ? {} : { Authorization: authorization }, body: JSON.stringify(body) }));
const seedRows = async (rows: SeedRow[], dryRun = false) => (await (await post({ rows, dryRun })).json()) as { results: { outcome: string; cid?: number }[] };
const outcomes = async (rows: SeedRow[], dryRun = false) => (await seedRows(rows, dryRun)).results.map((result) => result.outcome);

beforeEach(() => {
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('each row, through the route', () => {
  it('writes a member found by identity\'s discord_id, and queues their sync', async () => {
    start([tsUser(1001, null, D(1))]);
    expect(await outcomes([{ discordId: D(1), uid: UID('a') }])).toEqual(['written']);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1001', body: { teamspeak_uid: UID('a') } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toHaveLength(1);
    expect(env.ROLE_SYNC_QUEUE.sent[0]).toMatchObject({ cid: 1001 });
  });

  it('finds a member through VATUSA\'s Discord ID when identity has none', async () => {
    start([tsUser(1002, null)]);
    const { results } = await seedRows([{ discordId: D(2), uid: UID('b') }]);
    expect(results).toEqual([{ discordId: D(2), uid: UID('b'), outcome: 'written', cid: 1002 }]);
    expect(env.IDENTITY.users[0]!.teamspeak_uid).toBe(UID('b'));
  });

  it('leaves a member who already has a UID alone', async () => {
    start([tsUser(1001, UID('old'), D(1))]);
    expect(await outcomes([{ discordId: D(1), uid: UID('a') }])).toEqual(['already-linked']);
    expect(env.IDENTITY.writes).toEqual([]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('skips a UID that is on another member', async () => {
    start([tsUser(1001, null, D(1)), tsUser(1009, UID('a'))]);
    expect(await outcomes([{ discordId: D(1), uid: UID('a') }])).toEqual(['uid-on-another-member']);
    expect(env.IDENTITY.writes).toEqual([]);
  });

  it('writes the first of several rows for one member and lists the rest as extra', async () => {
    start([tsUser(1001, null, D(1))]);
    expect(await outcomes([{ discordId: D(1), uid: UID('a') }, { discordId: D(1), uid: UID('b') }, { discordId: D(1), uid: UID('c') }])).toEqual(['written', 'extra-uid', 'extra-uid']);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1001', body: { teamspeak_uid: UID('a') } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toHaveLength(1);
  });

  it('drops a Discord ID that has no CID', async () => {
    start([]);
    expect(await outcomes([{ discordId: D(99), uid: UID('a') }])).toEqual(['no-cid']);
  });

  it('drops a CID identity has never seen', async () => {
    start([]);
    expect(await outcomes([{ discordId: D(3), uid: UID('a') }])).toEqual(['never-signed-in']);
    expect(env.IDENTITY.writes).toEqual([]);
  });

  it('reads VATUSA\'s lists once for the request', async () => {
    start([]);
    await outcomes([{ discordId: D(2), uid: UID('a') }, { discordId: D(3), uid: UID('b') }, { discordId: D(5), uid: UID('c') }, { discordId: D(99), uid: UID('d') }]);
    expect(vatusaCalls).toHaveLength(9);
  });

  it('answers 503 and writes nothing when VATUSA\'s lists are down', async () => {
    start([tsUser(1002, null)]);
    fakeVatusaAndDiscord(vatusaLists(), { roles: [], members: [] }, ['/integration/staff']);
    const res = await post({ rows: [{ discordId: D(2), uid: UID('a') }], dryRun: false });
    expect(res.status).toBe(503);
    expect(env.IDENTITY.writes).toEqual([]);
  });

  it('answers 400 to a malformed body', async () => {
    start([]);
    for (const body of [{ rows: [] }, { dryRun: true }, { rows: [{ discordId: 'x', uid: 'a' }], dryRun: false }, { rows: [{ discordId: D(1), uid: '' }], dryRun: false }, { rows: Array.from({ length: 51 }, () => ({ discordId: D(1), uid: 'a' })), dryRun: false }]) {
      expect((await post(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
  });
});

describe('dryRun', () => {
  it('works out the same outcomes, and writes and queues nothing', async () => {
    const users = () => [tsUser(1001, null, D(1)), tsUser(1002, UID('old')), tsUser(1009, UID('taken'))];
    const rows = [
      { discordId: D(1), uid: UID('a') },
      { discordId: D(1), uid: UID('b') },
      { discordId: D(2), uid: UID('c') },
      { discordId: D(3), uid: UID('d') },
      { discordId: D(99), uid: UID('e') },
      { discordId: D(5), uid: UID('taken') },
    ];
    start(users());
    const dry = await outcomes(rows, true);
    expect(env.IDENTITY.writes).toEqual([]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);

    start(users());
    expect(await outcomes(rows, false)).toEqual(dry);
    expect(dry).toEqual(['written', 'extra-uid', 'already-linked', 'never-signed-in', 'no-cid', 'never-signed-in']);
  });
});

describe('its secret', () => {
  it('is the only one the route takes: none, a wrong one, or another bot\'s gets 401, and nothing is written', async () => {
    start([tsUser(1001, null, D(1))]);
    const body = { rows: [{ discordId: D(1), uid: UID('a') }], dryRun: false };
    for (const authorization of [null, 'Bearer wrong', 'Bearer ', `Bearer ${env.BOT_EVENTS_SECRET}`, `Bearer ${env.TEAMSPEAK_BOT_SECRET}`]) {
      expect((await post(body, authorization)).status, String(authorization)).toBe(401);
    }
    expect(env.IDENTITY.writes).toEqual([]);
  });

  it('is refused on the other routes', async () => {
    start([]);
    for (const path of ['/bot/events', '/teamspeak/jobs/pull', '/teamspeak/jobs/ack', '/teamspeak/results']) {
      expect((await post({}, `Bearer ${SEED_SECRET}`, path)).status, path).toBe(401);
    }
  });

  it('refuses everyone while it is unset', async () => {
    start([]);
    env.TEAMSPEAK_SEED_SECRET = undefined as never;
    expect((await post({ rows: [], dryRun: true })).status).toBe(401);
    expect((await post({ rows: [], dryRun: true }, 'Bearer ')).status).toBe(401);
  });
});

describe('the script', () => {
  let dir: string;
  beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'seed-ts-links-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function legacyDb(rows: [string | bigint | null, string | null][]) {
    const path = join(dir, 'database.sqlite');
    const db = new DatabaseSync(path);
    db.exec('CREATE TABLE members (id INTEGER PRIMARY KEY, discordID INTEGER, teamspeakID TEXT); CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT)');
    for (const [discord, uid] of rows) db.exec(`INSERT INTO members (discordID, teamspeakID) VALUES (${discord ?? 'NULL'}, ${uid === null ? 'NULL' : `'${uid}'`})`);
    db.close();
    return path;
  }

  it('reads the members table, Discord IDs exact, skipping rows missing either', () => {
    const path = legacyDb([['830000000000000001', UID('a')], ['830000000000000002', null], [null, UID('c')], ['830000000000000004', UID('d')]]);
    expect(readRows(path)).toEqual([{ discordId: '830000000000000004', uid: UID('d') }, { discordId: '830000000000000001', uid: UID('a') }]);
  });

  it("puts a member's newest identity first, so that's the one written", () => {
    const path = legacyDb([['830000000000000001', UID('old')], ['830000000000000002', UID('b')], ['830000000000000001', UID('new')]]);
    const mine = readRows(path).filter((row) => row.discordId === '830000000000000001');
    expect(mine.map((row) => row.uid)).toEqual([UID('new'), UID('old')]);
  });

  it('batches by 50 without splitting one member\'s rows', () => {
    const rows: SeedRow[] = Array.from({ length: 120 }, (_, i) => ({ discordId: D(Math.floor(i / 2)), uid: `u${i}` }));
    const sent = batches(rows);
    expect(sent.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(sent.flat()).toHaveLength(120);
    for (const [i, batch] of sent.entries()) for (const other of sent.slice(i + 1)) expect(batch.some((a) => other.some((b) => a.discordId === b.discordId))).toBe(false);
  });

  it('posts each batch with the bearer and prints the combined report', async () => {
    start([tsUser(1001, null, D(1)), tsUser(1002, UID('old'))]);
    const rows = [{ discordId: D(1), uid: UID('a') }, { discordId: D(2), uid: UID('b') }, { discordId: D(99), uid: UID('c') }];
    const calls: { url: string; auth: string | null; dryRun: boolean }[] = [];
    const through = (async (url: URL, init: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init.headers).get('Authorization'), dryRun: JSON.parse(String(init.body)).dryRun });
      return larry.fetch(new Request(String(url), init));
    }) as unknown as typeof fetch;

    const results = await seed(rows, { url: URL, secret: SEED_SECRET, dryRun: true, fetch: through });
    expect(calls).toEqual([{ url: `${URL}/teamspeak/seed`, auth: `Bearer ${SEED_SECRET}`, dryRun: true }]);
    const text = report(results, true);
    expect(text).toContain('Dry run, nothing written: 3 rows');
    expect(text).toContain('Would be written: 1');
    expect(text).toContain(`Discord ${D(2)}, TeamSpeak ${UID('b')}, CID 1002`);
    expect(text).toContain(`Discord ${D(99)}, TeamSpeak ${UID('c')}`);
    expect(env.IDENTITY.writes).toEqual([]);
  });

  it('stops with larry\'s answer when a batch is refused', async () => {
    start([]);
    const through = ((url: URL, init: RequestInit) => larry.fetch(new Request(String(url), init))) as unknown as typeof fetch;
    await expect(seed([{ discordId: D(1), uid: UID('a') }], { url: URL, secret: 'wrong', dryRun: false, fetch: through })).rejects.toThrow('larry answered 401');
  });
});
