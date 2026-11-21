import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import type { VatusaLists } from '../src/vatusa';
import { batchOf, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, LARRY, type Server } from './fake-discord';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record, role } from './vatusa-records';

// Past Number.MAX_SAFE_INTEGER, so a parse that rounds it would lose the member.
const STUDENT = '1146457348798431314';
const MENTOR = '500000000000000002';
const STRANGER = '500000000000000003';
const ALERTS = '300000000000000001';

const ROLE = {
  observer: '896858108054368298',
  student3: '896858107051909159',
  controller1: '896858105789440041',
  member: '1125403438545641564',
  atc: '477495351838900254',
  handGiven: '600000000000000042',
};

const member = (id: string, ...roles: string[]) => ({ user: { id }, roles });

function makeEnv() {
  return {
    DISCORD_TOKEN: 'token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: `tech-team-alerts:${ALERTS},events:111`,
    ROLE_SYNC_MODE: 'dry-run',
    KV: fakeKv(),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<never>(),
  };
}

const goodLists = (): VatusaLists =>
  lists(
    {
      ZID: [
        record({ cid: 1000001, rating: 4, rating_short: 'S3', discord_id: STUDENT }),
        record({ cid: 1000002, facility: 'ZNY', rating: 5, rating_short: 'C1', discord_id: MENTOR, roles: [role(1000002, 'ZID', 'MTR')] }),
      ],
      ZME: [record({ cid: 1000003, facility: 'ZME' })],
      ZDC: [record({ cid: 1000004, facility: 'ZDC' })],
      ZAU: [record({ cid: 1000005, facility: 'ZAU' })],
      ZOB: [record({ cid: 1000006, facility: 'ZOB' })],
      ZTL: [record({ cid: 1000007, facility: 'ZTL' })],
      ZKC: [record({ cid: 1000008, facility: 'ZKC' })],
    },
    [record({ cid: 1000009, facility: 'ZHQ', roles: [role(1000009, 'ZHQ', 'US2')] })],
  );

const server = (): Server => ({
  roles: [],
  members: [
    // An S3 who still holds Observer, and a role the mapping doesn't name.
    member(STUDENT, ROLE.observer, ROLE.member, ROLE.handGiven),
    member(MENTOR, ROLE.controller1),
    member(STRANGER, ROLE.handGiven, ROLE.atc),
    member(LARRY),
  ],
});

let env: ReturnType<typeof makeEnv>;
let larry: Larry;
let logs: string[];

beforeEach(() => {
  env = makeEnv();
  larry = new Larry({} as ExecutionContext, env as never);
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cron = () => larry.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController);

/** Run the cron, then deliver what it queued to the consumer. Returns the consumer's log lines. */
async function cronAndConsume() {
  await cron();
  const { batch, messages } = batchOf('role-sync', env.ROLE_SYNC_QUEUE.sent);
  logs = [];
  await larry.queue(batch as never);
  return { lines: logs.filter((line) => line.startsWith('Role sync')), messages };
}

describe('a good run', () => {
  it('fetches the nine lists and queues one job per Discord member', async () => {
    const { vatusaCalls } = fakeVatusaAndDiscord(goodLists(), server());
    await cron();

    expect(vatusaCalls.sort()).toEqual(
      ['ZID', 'ZME', 'ZDC', 'ZAU', 'ZOB', 'ZTL', 'ZKC'].map((id) => `/facility/${id}/roster/both`).concat('/integration/staff', '/user/roles/ZHQ/ACE').sort(),
    );
    expect(env.ROLE_SYNC_QUEUE.sent.map((job) => job.discordId)).toEqual([STUDENT, MENTOR, STRANGER, LARRY]);
  });

  it("logs one line per member: their CID, or unresolved, and the mapped roles to add and remove", async () => {
    fakeVatusaAndDiscord(goodLists(), server());
    const { lines, messages } = await cronAndConsume();

    expect(lines).toEqual([
      `Role sync (dry run): ${STUDENT} CID 1000001: add Student 3, Air Traffic Controller; remove Observer`,
      `Role sync (dry run): ${MENTOR} CID 1000002: add Mentor, Training Staff, Air Traffic Controller, Member; remove nothing`,
      `Role sync (dry run): ${STRANGER} unresolved: no changes`,
      `Role sync (dry run): ${LARRY} unresolved: no changes`,
    ]);
    expect(messages.every((message) => message.acked)).toBe(true);
  });

  it('never lists a role the mapping does not name', async () => {
    fakeVatusaAndDiscord(goodLists(), server());
    const { lines } = await cronAndConsume();
    // The S3 holds Observer and a hand-given role the mapping doesn't name: only Observer goes.
    expect(lines[0]).toMatch(/; remove Observer$/);
    expect(lines.join('\n')).not.toMatch(/undefined|600000000000000042/);
  });

  it('changes nothing in Discord', async () => {
    const { writes } = fakeVatusaAndDiscord(goodLists(), server());
    await cronAndConsume();
    expect(writes).toEqual([]);
  });

  it('refuses any mode but dry-run, queueing nothing', async () => {
    fakeVatusaAndDiscord(goodLists(), server());
    env.ROLE_SYNC_MODE = 'live';
    await expect(cron()).rejects.toThrow('ROLE_SYNC_MODE "live"');
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });
});

describe('a bad fetch', () => {
  const alertsPosted = (writes: { path: string; body?: Record<string, unknown> }[]) => writes.filter((write) => write.path === `/channels/${ALERTS}/messages`).map((write) => write.body?.content);

  it('queues nothing when a list fetch fails, and alerts once per outage', async () => {
    const { writes } = fakeVatusaAndDiscord(goodLists(), server(), ['/facility/ZME/roster/both']);
    await cron();
    await cron();

    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
    expect(alertsPosted(writes)).toEqual(["Role sync skipped: couldn't fetch ZME's roster from VATUSA."]);
  });

  it('queues nothing when a roster comes back empty', async () => {
    const empty = goodLists();
    empty.rosters.ZKC = [];
    const { writes } = fakeVatusaAndDiscord(empty, server());
    await cron();
    await cron();

    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
    expect(alertsPosted(writes)).toEqual(["Role sync skipped: couldn't fetch ZKC's roster from VATUSA."]);
  });

  it('queues nothing when the staff list comes back empty', async () => {
    const empty = goodLists();
    empty.staff = [];
    const { writes } = fakeVatusaAndDiscord(empty, server());
    await cron();

    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
    expect(alertsPosted(writes)).toEqual(["Role sync skipped: couldn't fetch the staff list from VATUSA."]);
  });

  it('alerts again for a new outage once a good run has cleared the last', async () => {
    let { writes } = fakeVatusaAndDiscord(goodLists(), server(), ['/integration/staff']);
    await cron();
    expect(alertsPosted(writes)).toHaveLength(1);

    fakeVatusaAndDiscord(goodLists(), server());
    await cron();
    expect(env.ROLE_SYNC_QUEUE.sent).toHaveLength(4);

    ({ writes } = fakeVatusaAndDiscord(goodLists(), server(), ['/user/roles/ZHQ/ACE']));
    await cron();
    expect(alertsPosted(writes)).toEqual(["Role sync skipped: couldn't fetch the ACE list from VATUSA."]);
  });
});
