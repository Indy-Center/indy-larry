import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { batchOf, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, LARRY, type Server } from './fake-discord';
import { identityEnv, idUser, TOKEN_LIFETIME_SECONDS } from './fake-identity';
import { fakeTraining, trainee } from './fake-training';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record } from './vatusa-records';

// Member 1000001 is an S3 whose VATUSA Discord ID is OLD; they link NEW in identity.
const OLD = '1146457348798431314';
const NEW = '800000000000000010';
const OTHER_MEMBER_ACCOUNT = '800000000000000011';
const ALERTS = '300000000000000001';

const member = (id: string, ...roles: string[]) => ({ user: { id }, roles });

function makeEnv() {
  return {
    DISCORD_TOKEN: 'token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: `tech-team-alerts:${ALERTS}`,
    ROLE_SYNC_MODE: 'dry-run',
    KV: fakeKv(),
    TRAINING: fakeTraining({ members: [trainee(1000001)] }),
    ...identityEnv([idUser(1000001), idUser(1000002, OTHER_MEMBER_ACCOUNT)]),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<never>(),
  };
}

const vatusaLists = () =>
  lists({
    ZID: [record({ cid: 1000001, rating_short: 'S3', discord_id: OLD }), record({ cid: 1000002, rating_short: 'S3' })],
    ZME: [record({ cid: 1000003, facility: 'ZME' })],
    ZDC: [record({ cid: 1000004, facility: 'ZDC' })],
    ZAU: [record({ cid: 1000005, facility: 'ZAU' })],
    ZOB: [record({ cid: 1000006, facility: 'ZOB' })],
    ZTL: [record({ cid: 1000007, facility: 'ZTL' })],
    ZKC: [record({ cid: 1000008, facility: 'ZKC' })],
  }, [record({ cid: 1000009, facility: 'ZHQ' })]);

const server = (): Server => ({ roles: [], members: [member(OLD), member(NEW), member(OTHER_MEMBER_ACCOUNT), member(LARRY)] });
// A member VATUSA knows by CID only, off the lists, for the per-user fallback.
const offList = record({ cid: 1000020, facility: 'ZNY', rating: 4, rating_short: 'S3', discord_id: '800000000000000020', visiting_facilities: [{ facility: 'ZID' }] });

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

/** Deliver everything queued so far to the consumer, and return its log lines and messages. */
async function consume() {
  const { batch, messages } = batchOf('role-sync', env.ROLE_SYNC_QUEUE.sent.splice(0));
  logs = [];
  await larry.queue(batch as never);
  return { lines: logs.filter((line) => line.startsWith('Role sync')), messages };
}

describe('linkDiscord', () => {
  it("writes the Discord ID to identity and queues that member's sync, which reads their roles", async () => {
    // No run's lists are kept, so VATUSA's per-user lookup by CID answers.
    fakeVatusaAndDiscord(vatusaLists(), server(), [], { users: [record({ cid: 1000001, rating_short: 'S3', discord_id: OLD })] });
    await larry.linkDiscord(1000001, NEW);

    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { discord_id: NEW } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: NEW }]);

    const { lines, messages } = await consume();
    expect(lines).toEqual([`Role sync (dry run): ${NEW} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing`]);
    expect(messages[0]!.acked).toBe(true);
  });

  it('refuses a Discord account another member has linked, writing and queueing nothing', async () => {
    await expect(larry.linkDiscord(1000001, OTHER_MEMBER_ACCOUNT)).rejects.toThrow('That Discord account is linked to another member.');
    expect(env.IDENTITY.writes).toEqual([]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('refuses a CID identity has no user for', async () => {
    await expect(larry.linkDiscord(1999999, NEW)).rejects.toThrow('Sign in to flyindycenter.com once before linking.');
    expect(env.IDENTITY.writes).toEqual([]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it("answers the same refusal when identity's own uniqueness check (409) catches it first", async () => {
    // Someone linked it after larry's lookup: the lookup sees nobody, the write is refused.
    const claimed = idUser(1000050, NEW);
    const find = env.IDENTITY.fetch;
    env.IDENTITY.fetch = async (input: string, init?: RequestInit) => {
      if (input.includes('discord_id=')) return new Response('[]', { status: 200 });
      return find(input, init);
    };
    env.IDENTITY.users.push(claimed);
    await expect(larry.linkDiscord(1000001, NEW)).rejects.toThrow('That Discord account is linked to another member.');
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('lets a member link the account they already linked', async () => {
    await larry.linkDiscord(1000002, OTHER_MEMBER_ACCOUNT);
    expect(env.IDENTITY.writes).toHaveLength(1);
  });

  it("refuses something that isn't a Discord user ID", async () => {
    await expect(larry.linkDiscord(1000001, 'not-an-id')).rejects.toThrow('discordId must be a Discord user ID.');
    expect(env.IDENTITY.writes).toEqual([]);
  });
});

describe('unlink', () => {
  it("clears the link and queues the sync of the account VATUSA holds", async () => {
    env.IDENTITY.users[0]!.discord_id = NEW;
    fakeVatusaAndDiscord(vatusaLists(), server());
    await cron();
    env.ROLE_SYNC_QUEUE.sent.length = 0;
    await larry.unlink(1000001, 'discord');

    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { discord_id: null } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: OLD }]);
  });

  it("falls back to VATUSA's per-user lookup when no run's lists are kept, and queues nothing when VATUSA has no Discord ID", async () => {
    env.IDENTITY.users.push(idUser(1000020, NEW), idUser(1000021, OLD + '1'));
    fakeVatusaAndDiscord(vatusaLists(), server(), [], { users: [offList, record({ cid: 1000021, discord_id: null })] });

    await larry.unlink(1000020, 'discord');
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000020, discordId: '800000000000000020' }]);

    env.ROLE_SYNC_QUEUE.sent.length = 0;
    await larry.unlink(1000021, 'discord');
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it("refuses 'teamspeak' until TeamSpeak links exist", async () => {
    await expect(larry.unlink(1000001, 'teamspeak')).rejects.toThrow("TeamSpeak links aren't available yet.");
    expect(env.IDENTITY.writes).toEqual([]);
  });
});

describe('getLinks', () => {
  it('reports a linked account, the VATUSA one, and none', async () => {
    env.IDENTITY.users.push(idUser(1000020), idUser(1000021));
    fakeVatusaAndDiscord(vatusaLists(), server(), [], { users: [offList, record({ cid: 1000021, discord_id: null })] });

    expect(await larry.getLinks(1000002)).toEqual({ discord: { id: OTHER_MEMBER_ACCOUNT, source: 'linked' }, teamspeak: null });
    expect(await larry.getLinks(1000020)).toEqual({ discord: { id: '800000000000000020', source: 'vatusa' }, teamspeak: null });
    expect(await larry.getLinks(1000021)).toEqual({ discord: null, teamspeak: null });
  });

  it('prefers the link over the VATUSA Discord ID', async () => {
    env.IDENTITY.users[0]!.discord_id = NEW;
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.getLinks(1000001)).toEqual({ discord: { id: NEW, source: 'linked' }, teamspeak: null });
  });
});

describe('the sync finds a member through their link first', () => {
  it('gives the linked account the roles and the stale VATUSA one none', async () => {
    env.IDENTITY.users[0]!.discord_id = NEW;
    fakeVatusaAndDiscord(vatusaLists(), server());
    await cron();
    const { lines } = await consume();

    expect(lines).toContain(`Role sync (dry run): ${NEW} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing`);
    expect(lines).toContain(`Role sync (dry run): ${OLD} unresolved (their CID is linked to another Discord account): no changes`);
  });

  it('still finds a member by their VATUSA Discord ID when nobody has linked that CID', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    await cron();
    const { lines } = await consume();
    expect(lines).toContain(`Role sync (dry run): ${OLD} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing`);
  });

  it("retries a member's job, and syncs nobody on a guess, when identity can't be reached", async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    await cron();
    env.IDENTITY.down = true;
    const { lines, messages } = await consume();

    expect(lines).toEqual([]);
    expect(messages.every((message) => message.retried && !message.acked)).toBe(true);
  });
});

describe("larry's client credentials at identity", () => {
  it('asks for a token once with its client ID and secret, and reuses it for every call', async () => {
    env.IDENTITY.users[0]!.discord_id = NEW;
    await larry.getLinks(1000001);
    await larry.getLinks(1000002);
    await larry.getLinks(1000001);

    expect(env.IDENTITY.tokenRequests).toEqual([{ authorization: `Basic ${btoa('larry:larry-secret')}`, body: 'grant_type=client_credentials&scope=users%3Aread+users%3Awrite' }]);
    expect(env.IDENTITY.apiCalls).toEqual(['GET /api/users/1000001', 'GET /api/users/1000002', 'GET /api/users/1000001']);
  });

  it('asks again once the token is about to expire', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await larry.getLinks(1000001);
      vi.advanceTimersByTime((TOKEN_LIFETIME_SECONDS - 30) * 1000);
      await larry.getLinks(1000001);
      expect(env.IDENTITY.tokenRequests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails the call, naming identity, when the client is refused', async () => {
    env.IDENTITY_CLIENT_SECRET = 'wrong';
    await expect(larry.getLinks(1000001)).rejects.toThrow("identity's /oauth/token answered 401");
  });
});

describe('syncMember', () => {
  it('queues a known member, by their link, and then declines for 2 minutes', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.syncMember(1000002)).toEqual({ queued: true });
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000002, discordId: OTHER_MEMBER_ACCOUNT }]);

    expect(await larry.syncMember(1000002)).toEqual({ queued: false, reason: 'Synced moments ago; try again in a minute.' });
    expect(env.ROLE_SYNC_QUEUE.sent).toHaveLength(1);
    expect(env.KV.ttls.get('role-sync:member:1000002')).toBe(120);
  });

  it("uses the newest run's lists when they are kept, without a VATUSA lookup", async () => {
    const { vatusaCalls } = fakeVatusaAndDiscord(vatusaLists(), server());
    await cron();
    await consume();
    const before = vatusaCalls.length;

    expect(await larry.syncMember(1000001)).toEqual({ queued: true });
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: OLD }]);
    const { lines } = await consume();
    expect(lines).toEqual([`Role sync (dry run): ${OLD} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing`]);
    expect(vatusaCalls.length).toBe(before);
  });

  it("looks the member up in VATUSA when no run's lists are kept", async () => {
    const { vatusaCalls } = fakeVatusaAndDiscord(vatusaLists(), server(), [], { users: [offList] });
    expect(await larry.syncMember(1000020)).toEqual({ queued: true });
    expect(vatusaCalls).toEqual(['/user/1000020']);
  });

  it('declines a CID nobody knows a Discord account for', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.syncMember(1999999)).toEqual({
      queued: false,
      reason: 'No Discord account or TeamSpeak identity is known for this member.',
    });
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('acks the job of someone who has left the server, changing nothing', async () => {
    const { writes } = fakeVatusaAndDiscord(vatusaLists(), { roles: [], members: [member(LARRY)] });
    await larry.linkDiscord(1000001, NEW);
    const { lines, messages } = await consume();

    expect(lines).toEqual([`Role sync: ${NEW} isn't in the server`]);
    expect(messages[0]!.acked).toBe(true);
    expect(writes).toEqual([]);
  });

  it('follows ROLE_SYNC_MODE like every other job', async () => {
    env.ROLE_SYNC_MODE = 'live';
    await expect(larry.syncMember(1000002)).rejects.toThrow('ROLE_SYNC_MODE "live"');
  });
});
