import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import type { VatusaLists } from '../src/vatusa';
import { batchOf, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, LARRY, type Server } from './fake-discord';
import { identityEnv } from './fake-identity';
import { fakeTraining, trainee } from './fake-training';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record, role } from './vatusa-records';

// Past Number.MAX_SAFE_INTEGER, so a parse that rounds it would lose the member.
const STUDENT = '9000000000000000001';
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
    TRAINING: fakeTraining({ members: [trainee(1000001)] }),
    ...identityEnv(),
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
      `Role sync (dry run): ${STUDENT} CID 1000001: add Student 3, Air Traffic Controller; remove Observer; nickname "Test Person1000001"`,
      `Role sync (dry run): ${MENTOR} CID 1000002: add Mentor, Training Staff, Air Traffic Controller, Member; remove nothing; nickname "Test Person1000002"`,
      `Role sync (dry run): ${STRANGER} unresolved: no changes`,
      `Role sync (dry run): ${LARRY} unresolved: no changes`,
    ]);
    expect(messages.every((message) => message.acked)).toBe(true);
  });

  it('never lists a role the mapping does not name', async () => {
    fakeVatusaAndDiscord(goodLists(), server());
    const { lines } = await cronAndConsume();
    // The S3 holds Observer and a hand-given role the mapping doesn't name: only Observer goes.
    expect(lines[0]).toMatch(/; remove Observer;/);
    expect(lines.join('\n')).not.toMatch(/undefined|600000000000000042/);
  });

  it('changes nothing in Discord', async () => {
    const { writes } = fakeVatusaAndDiscord(goodLists(), server());
    await cronAndConsume();
    expect(writes).toEqual([]);
  });

  it('refuses any mode but dry-run and live, queueing nothing', async () => {
    fakeVatusaAndDiscord(goodLists(), server());
    env.ROLE_SYNC_MODE = 'on';
    await expect(cron()).rejects.toThrow('ROLE_SYNC_MODE "on"');
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });
});

describe('a join (sync-member)', () => {
  /** Deliver sync-member jobs to the consumer, as POST /bot/events queues them. Returns its log lines. */
  async function consumeJoins(...discordIds: string[]) {
    const { batch, messages } = batchOf<RoleSyncMessage>('role-sync', discordIds.map((discordId) => ({ type: 'sync-member', discordId })));
    logs = [];
    await larry.queue(batch as never);
    return { lines: logs.filter((line) => line.startsWith('Role sync')), messages };
  }

  it("syncs that member against the latest run's lists and the roles they hold now", async () => {
    fakeVatusaAndDiscord(goodLists(), server());
    await cron();
    // They joined after the run listed the server, and onboarding gave them Observer.
    const joined = server();
    joined.members!.push(member('500000000000000008', ROLE.observer));
    const lists = goodLists();
    lists.rosters.ZID.push(record({ cid: 1000010, rating: 2, rating_short: 'S1', discord_id: '500000000000000008' }));
    fakeVatusaAndDiscord(lists, joined);
    await cron();

    const { lines, messages } = await consumeJoins('500000000000000008', STUDENT);
    expect(lines).toEqual([
      'Role sync (dry run): 500000000000000008 CID 1000010: add Student 1, Air Traffic Controller, Member; remove Observer; nickname "Test Person1000010"',
      `Role sync (dry run): ${STUDENT} CID 1000001: add Student 3, Air Traffic Controller; remove Observer; nickname "Test Person1000001"`,
    ]);
    expect(messages.every((message) => message.acked)).toBe(true);
  });

  it('changes nothing in Discord', async () => {
    const { writes } = fakeVatusaAndDiscord(goodLists(), server());
    await cron();
    await consumeJoins(STUDENT);
    expect(writes).toEqual([]);
  });

  it('drops a member who has already left the server', async () => {
    fakeVatusaAndDiscord(goodLists(), server());
    await cron();
    const { lines, messages } = await consumeJoins('500000000000000009');
    expect(lines).toEqual(["Role sync: 500000000000000009 isn't in the server"]);
    expect(messages[0]!.acked).toBe(true);
  });

  it('syncs through the per-user lookups when no run has kept its lists', async () => {
    const { vatusaCalls } = fakeVatusaAndDiscord(goodLists(), server(), [], {
      users: [record({ cid: 1000001, rating: 4, rating_short: 'S3', discord_id: STUDENT })],
    });
    const { lines, messages } = await consumeJoins(STUDENT);
    expect(lines).toEqual([`Role sync (dry run): ${STUDENT} CID 1000001: add Student 3, Air Traffic Controller; remove Observer; nickname "Test Person1000001"`]);
    expect(vatusaCalls).toContain(`/user/${STUDENT}?d`);
    expect(messages[0]!.acked).toBe(true);
  });
});

describe('a message of an unknown type', () => {
  it('is retried, not acked, so the queue parks it in role-sync-dlq, and syncs no one', async () => {
    const { vatusaCalls, writes } = fakeVatusaAndDiscord(goodLists(), server());
    const { batch, messages } = batchOf('role-sync', [{ type: 'sync-everyone', discordId: STUDENT }]);
    logs = [];
    await larry.queue(batch as never);

    expect(messages[0]!.retried).toBe(true);
    expect(messages[0]!.acked).toBe(false);
    expect(logs.filter((line) => line.startsWith('Role sync'))).toEqual([]);
    expect(vatusaCalls).toEqual([]);
    expect(writes).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Unknown role-sync job type "sync-everyone"'));
  });
});

describe('members the lists do not cover', () => {
  const PILOT = '700000000000000001';
  const GHOST = '700000000000000002';
  // A visiting S3 whose home is elsewhere; VATUSA's per-user record lists ZID among the facilities they visit.
  const pilotRecord = record({ cid: 1000010, facility: 'ZNY', rating: 4, rating_short: 'S3', discord_id: PILOT, visiting_facilities: [{ facility: 'ZID' }] });
  const pilotsServer = (): Server => ({ roles: [], members: [member(PILOT), member(GHOST), member(LARRY)] });
  const userLookups = (calls: string[]) => calls.filter((path) => path.startsWith('/user/') && !path.startsWith('/user/roles/'));

  it('looks a member on no list up by Discord ID and evaluates them like a list member', async () => {
    fakeVatusaAndDiscord(goodLists(), pilotsServer(), [], { users: [pilotRecord] });
    const { lines } = await cronAndConsume();

    expect(lines).toEqual([
      `Role sync (dry run): ${PILOT} CID 1000010: add Student 3, Air Traffic Controller, Member; remove nothing; nickname "Test Person1000010"`,
      `Role sync (dry run): ${GHOST} unresolved: no changes`,
      `Role sync (dry run): ${LARRY} unresolved: no changes`,
    ]);
  });

  it('leaves a member VATUSA has no record for unresolved', async () => {
    const { vatusaCalls } = fakeVatusaAndDiscord(goodLists(), pilotsServer(), [], { users: [pilotRecord] });
    await cronAndConsume();
    expect(userLookups(vatusaCalls)).toEqual([`/user/${PILOT}?d`, `/user/${GHOST}?d`, `/user/${LARRY}?d`]);
  });

  it('makes no lookup for a member already looked up in the last 24 hours, found or not', async () => {
    const { vatusaCalls } = fakeVatusaAndDiscord(goodLists(), pilotsServer(), [], { users: [pilotRecord] });
    await cronAndConsume();
    expect(userLookups(vatusaCalls)).toHaveLength(3);
    const { lines } = await cronAndConsume();

    expect(userLookups(vatusaCalls)).toHaveLength(3);
    expect(lines[0]).toBe(`Role sync (dry run): ${PILOT} CID 1000010: add Student 3, Air Traffic Controller, Member; remove nothing; nickname "Test Person1000010"`);
    const day = 24 * 60 * 60;
    expect([...env.KV.ttls].filter(([key]) => key.startsWith('role-sync:vatusa-user:')).map(([, ttl]) => ttl)).toEqual([day, day, day]);
  });

  it('keeps to 20 lookups a second', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const crowd = Array.from({ length: 45 }, (_, i) => `7100000000000000${String(i).padStart(2, '0')}`);
      const { vatusaCallTimes } = fakeVatusaAndDiscord(goodLists(), { roles: [], members: crowd.map((id) => member(id)) });
      await cron();
      const { batch } = batchOf('role-sync', env.ROLE_SYNC_QUEUE.sent);
      const done = larry.queue(batch as never);
      await vi.advanceTimersByTimeAsync(5000);
      await done;

      const lookups = vatusaCallTimes.slice(-crowd.length);
      expect(lookups).toHaveLength(45);
      for (let i = 20; i < lookups.length; i++) expect(lookups[i]! - lookups[i - 20]!).toBeGreaterThanOrEqual(1000);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("a known CID VATUSA has no record of (a link's CID)", () => {
    /** Deliver a sync-cid job for PILOT, as a link write or syncMember() queues it. Returns the consumer's log lines. */
    async function consumeCid(cid: number) {
      const { batch, messages } = batchOf<RoleSyncMessage>('role-sync', [{ type: 'sync-cid', cid, discordId: PILOT }]);
      logs = [];
      await larry.queue(batch as never);
      return { lines: logs.filter((line) => line.startsWith('Role sync')), messages };
    }

    it('takes their rating from VATSIM, and caches it for 24 hours', async () => {
      const { vatsimCalls } = fakeVatusaAndDiscord(goodLists(), pilotsServer(), [], { vatsimRatings: { 1000020: 4 } });
      const first = await consumeCid(1000020);
      expect(first.lines).toEqual([`Role sync (dry run): ${PILOT} CID 1000020: add Student 3, Member; remove nothing`]);
      expect(first.messages[0]!.acked).toBe(true);
      await consumeCid(1000020);

      expect(vatsimCalls).toEqual(['/members/1000020']);
      expect(env.KV.ttls.get('role-sync:vatsim-rating:1000020')).toBe(24 * 60 * 60);
    });

    it('gives no Member role at rating 0 (suspended)', async () => {
      fakeVatusaAndDiscord(goodLists(), pilotsServer(), [], { vatsimRatings: { 1000021: 0 } });
      const { lines } = await consumeCid(1000021);
      expect(lines).toEqual([`Role sync (dry run): ${PILOT} CID 1000021: add nothing; remove nothing`]);
    });

    it('stays unresolved when VATSIM has no such member', async () => {
      fakeVatusaAndDiscord(goodLists(), pilotsServer());
      const { lines } = await consumeCid(1000022);
      expect(lines).toEqual([`Role sync (dry run): ${PILOT} unresolved: no changes`]);
    });
  });
});

describe('the training roster', () => {
  const alertsPosted = (writes: { path: string; body?: Record<string, unknown> }[]) => writes.filter((write) => write.path === `/channels/${ALERTS}/messages`).map((write) => write.body?.content);

  it('is read once per run', async () => {
    fakeVatusaAndDiscord(goodLists(), server());
    await cronAndConsume();
    expect((env.TRAINING as ReturnType<typeof fakeTraining>).calls).toBe(1);
  });

  it('skips the run and alerts once when getRoster() fails', async () => {
    env.TRAINING = fakeTraining(null);
    const { writes } = fakeVatusaAndDiscord(goodLists(), server());
    await cron();
    await cron();

    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
    expect(alertsPosted(writes)).toEqual(["Role sync skipped: couldn't fetch the training roster."]);
  });

  it('skips the run and alerts once when the roster has no members', async () => {
    env.TRAINING = fakeTraining({ members: [] });
    const { writes } = fakeVatusaAndDiscord(goodLists(), server());
    await cron();
    await cron();

    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
    expect(alertsPosted(writes)).toEqual(["Role sync skipped: couldn't fetch the training roster."]);
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
