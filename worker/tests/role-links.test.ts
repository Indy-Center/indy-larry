import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetErrorMemory } from '../src/errors';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { batchOf, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, LARRY, type Server } from './fake-discord';
import { identityEnv, idUser, TOKEN_LIFETIME_SECONDS } from './fake-identity';
import { fakeSource } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record } from './vatusa-records';

// Member 1000001 is an S3 whose VATUSA Discord ID is OLD; they link NEW in identity.
const OLD = '9000000000000000001';
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
    TRAINING: fakeSource(),
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

/** syncMembers() for one CID, as the profile buttons call it: its one answer, without the CID. */
async function syncOne(cid: number) {
  const [first] = await larry.syncMembers([cid]);
  const { cid: _, ...answer } = first!;
  return answer;
}

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
    expect(await larry.linkDiscord(1000001, NEW)).toEqual({ joined: false });

    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { discord_id: NEW } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: NEW }]);

    const { lines, messages } = await consume();
    expect(lines).toEqual([`Role sync (dry run): ${NEW} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing; nickname "Test Person1000001"`]);
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

describe('linkDiscord with the member\'s access token adds them to the server', () => {
  // JOINER isn't in the server; NEW already is.
  const JOINER = '800000000000000012';
  const ACCESS = 'members-one-time-access-token';
  const JOIN_BOT = 'join-bot-token';
  const ERRORS = '300000000000000002';
  const couldNotJoin = "Your Discord account is linked, but we couldn't add you to the Indy Center Discord. Ask a staff member for an invite.";
  let pending: Promise<unknown>[];

  beforeEach(() => {
    // The join is a Discord write, so it happens only in live.
    Object.assign(env, { DISCORD_JOIN_BOT_TOKEN: JOIN_BOT, ERROR_CHANNEL_ID: ERRORS, ROLE_SYNC_MODE: 'live' });
    // Each failure test expects its own error report, which the isolate would otherwise send once.
    resetErrorMemory();
    pending = [];
    larry = new Larry({ waitUntil: (promise: Promise<unknown>) => void pending.push(promise) } as never, env as never);
  });

  const isJoin = (url: string, init?: RequestInit) => init?.method === 'PUT' && /\/guilds\/\d+\/members\/\d+$/.test(url);
  const fetchCalls = () => vi.mocked(globalThis.fetch).mock.calls as unknown as [string, RequestInit | undefined][];
  const joinCalls = () => fetchCalls().filter(([url, init]) => isJoin(url, init));

  /** Everything larry logged, sent anywhere but the join call, or kept, as one string to search. */
  async function everythingButTheJoin(): Promise<string> {
    await Promise.all(pending);
    const text = (value: unknown) => (value instanceof Error ? `${value.message} ${value.stack}` : typeof value === 'string' ? value : JSON.stringify(value));
    const logged = [console.log, console.warn, console.error].flatMap((fn) => vi.mocked(fn).mock.calls.flat().map(text));
    const sent = fetchCalls()
      .filter(([url, init]) => !isJoin(url, init))
      .map(([url, init]) => text([url, init?.headers, init?.body]));
    return [...logged, ...sent, text([...env.KV.store]), text(env.ROLE_SYNC_QUEUE.sent), text(env.LARRY_QUEUE.sent), text(env.IDENTITY.writes)].join('\n');
  }

  it("joins a member who isn't in the server with the join bot's token and theirs, links them and queues their sync", async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.linkDiscord(1000001, JOINER, ACCESS)).toEqual({ joined: true });

    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { discord_id: JOINER } }]);
    expect(joinCalls()).toHaveLength(1);
    const [url, init] = joinCalls()[0]!;
    expect(url).toBe(`https://discord.com/api/v10/guilds/${GUILD}/members/${JOINER}`);
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bot ${JOIN_BOT}`);
    expect(JSON.parse(init!.body as string)).toEqual({ access_token: ACCESS });
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: JOINER }]);
    expect(await everythingButTheJoin()).not.toContain(ACCESS);
  });

  it('answers joined: false for a member already in the server (Discord answers 204)', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.linkDiscord(1000001, NEW, ACCESS)).toEqual({ joined: false });
    expect(joinCalls()).toHaveLength(1);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: NEW }]);
  });

  it.each([
    ['refuses it (403)', { status: 403, message: 'Missing Permissions', code: 50013 }],
    ['is down (503)', { status: 503, message: 'Service Unavailable' }],
  ])('keeps the link and the sync when Discord %s, and says so without the token anywhere', async (_, joinRefused) => {
    fakeVatusaAndDiscord(vatusaLists(), { ...server(), joinRefused });
    const error = await larry.linkDiscord(1000001, JOINER, ACCESS).catch((thrown: Error) => thrown);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(couldNotJoin);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { discord_id: JOINER } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: JOINER }]);
    const kept = await everythingButTheJoin();
    // Discord's answer is logged, and the failure reported to the error channel.
    expect(kept).toContain(`Discord refused: ${joinRefused.status}`);
    expect(kept).toContain('linkDiscord() failed');
    expect(kept).not.toContain(ACCESS);
  });

  it('joins in dry-run too, and still links and queues the sync', async () => {
    env.ROLE_SYNC_MODE = 'dry-run';
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.linkDiscord(1000001, JOINER, ACCESS)).toEqual({ joined: true });

    expect(joinCalls()).toHaveLength(1);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { discord_id: JOINER } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: JOINER }]);
    expect(await everythingButTheJoin()).not.toContain(ACCESS);
  });

  it('makes no join call without a token', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.linkDiscord(1000001, JOINER)).toEqual({ joined: false });
    expect(joinCalls()).toEqual([]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: JOINER }]);
  });

  it('ignores the token, with a warning, while DISCORD_JOIN_BOT_TOKEN is unset, and still links', async () => {
    delete (env as { DISCORD_JOIN_BOT_TOKEN?: string }).DISCORD_JOIN_BOT_TOKEN;
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.linkDiscord(1000001, JOINER, ACCESS)).toEqual({ joined: false });

    expect(joinCalls()).toEqual([]);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { discord_id: JOINER } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: JOINER }]);
    expect(vi.mocked(console.warn).mock.calls.flat().join('\n')).toContain('DISCORD_JOIN_BOT_TOKEN');
    expect(await everythingButTheJoin()).not.toContain(ACCESS);
  });

  it('refuses another member\'s account, or a CID that never signed in, before any join call', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    await expect(larry.linkDiscord(1000001, OTHER_MEMBER_ACCOUNT, ACCESS)).rejects.toThrow('That Discord account is linked to another member.');
    await expect(larry.linkDiscord(1999999, JOINER, ACCESS)).rejects.toThrow('Sign in to flyindycenter.com once before linking.');
    expect(joinCalls()).toEqual([]);
    expect(env.IDENTITY.writes).toEqual([]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
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

  it('refuses a service that is no platform', async () => {
    await expect(larry.unlink(1000001, 'mumble' as never)).rejects.toThrow(`"mumble" isn't a platform larry links`);
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

    expect(lines).toContain(`Role sync (dry run): ${NEW} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing; nickname "Test Person1000001"`);
    expect(lines).toContain(`Role sync (dry run): ${OLD} unresolved (their CID is linked to another Discord account): remove nothing`);
  });

  it('still finds a member by their VATUSA Discord ID when nobody has linked that CID', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    await cron();
    const { lines } = await consume();
    expect(lines).toContain(`Role sync (dry run): ${OLD} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing; nickname "Test Person1000001"`);
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

describe('a VATUSA Discord ID another member has linked', () => {
  // CID 1000020's VATUSA Discord ID is VATUSA_ACCOUNT, but member 1000030 has linked that account.
  const VATUSA_ACCOUNT = '800000000000000020';
  beforeEach(() => {
    env.IDENTITY.users.push(idUser(1000020), idUser(1000030, VATUSA_ACCOUNT));
  });

  it("is not reported as the first member's account", async () => {
    fakeVatusaAndDiscord(vatusaLists(), server(), [], { users: [offList] });
    expect(await larry.getLinks(1000020)).toEqual({ discord: null, teamspeak: null });
    expect(await larry.getLinks(1000030)).toEqual({ discord: { id: VATUSA_ACCOUNT, source: 'linked' }, teamspeak: null });
  });

  it('is not queued for syncMembers or unlink of the first member', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server(), [], { users: [offList] });
    expect(await syncOne(1000020)).toEqual({ queued: false, reason: 'No Discord account or TeamSpeak identity is known for this member.' });
    await larry.unlink(1000020, 'discord');
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('gives the first member no roles when a job queued before the link arrives', async () => {
    const { writes } = fakeVatusaAndDiscord(vatusaLists(), { roles: [], members: [member(VATUSA_ACCOUNT), member(LARRY)] }, [], { users: [offList] });
    env.ROLE_SYNC_QUEUE.sent.push({ type: 'sync-cid', cid: 1000020, discordId: VATUSA_ACCOUNT });
    const { lines, messages } = await consume();

    expect(lines).toEqual([`Role sync (dry run): ${VATUSA_ACCOUNT} unresolved (this Discord account is linked to another member): no changes`]);
    expect(messages[0]!.acked).toBe(true);
    expect(writes).toEqual([]);
  });

  it("live leaves the account's managed role in someone else's job, with no Discord write for it", async () => {
    const MEMBER_ROLE = '1125403438545641564';
    env.ROLE_SYNC_MODE = 'live';
    const { writes } = fakeVatusaAndDiscord(vatusaLists(), { roles: [], members: [member(VATUSA_ACCOUNT, MEMBER_ROLE), member(LARRY)] }, [], { users: [offList] });
    env.ROLE_SYNC_QUEUE.sent.push({ type: 'sync-cid', cid: 1000020, discordId: VATUSA_ACCOUNT });
    const { lines, messages } = await consume();

    expect(lines).toEqual([`Role sync (live): ${VATUSA_ACCOUNT} unresolved (this Discord account is linked to another member): no changes`]);
    expect(messages[0]!.acked).toBe(true);
    expect(writes).toEqual([]);
  });

  it('gives the account to the member who linked it', async () => {
    fakeVatusaAndDiscord(vatusaLists(), { roles: [], members: [member(VATUSA_ACCOUNT), member(LARRY)] }, [], { users: [offList, record({ cid: 1000030, rating_short: 'S3', discord_id: null })] });
    env.ROLE_SYNC_QUEUE.sent.push({ type: 'sync-cid', cid: 1000030, discordId: VATUSA_ACCOUNT });
    const { lines } = await consume();
    expect(lines).toEqual([`Role sync (dry run): ${VATUSA_ACCOUNT} CID 1000030: add Student 3, Air Traffic Controller, Member; remove nothing; nickname "Test Person1000030"`]);
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

describe('syncMembers', () => {
  it('answers for each CID asked, once each, in order', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await larry.syncMembers([1000002, 1999999, 1000002])).toEqual([
      { cid: 1000002, queued: true },
      { cid: 1999999, queued: false, reason: 'No Discord account or TeamSpeak identity is known for this member.' },
    ]);
  });

  it('refuses a call that names no CIDs, or something that is not one', async () => {
    await expect(larry.syncMembers([])).rejects.toThrow('cids must be a list of 1 to 100 CIDs');
    await expect(larry.syncMembers([1.5])).rejects.toThrow('"1.5" isn\'t a CID');
  });

  it('queues a known member, by their link, and then declines for 2 minutes', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await syncOne(1000002)).toEqual({ queued: true });
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000002, discordId: OTHER_MEMBER_ACCOUNT }]);

    expect(await syncOne(1000002)).toEqual({ queued: false, reason: 'Synced moments ago; try again in a minute.' });
    expect(env.ROLE_SYNC_QUEUE.sent).toHaveLength(1);
    expect(env.KV.ttls.get('role-sync:member:1000002')).toBe(120);
  });

  it("reads the member from VATUSA fresh, even with the run's lists kept, and syncs against that", async () => {
    const { vatusaCalls } = fakeVatusaAndDiscord(vatusaLists(), server());
    await cron();
    await consume();
    const before = vatusaCalls.length;

    expect(await syncOne(1000001)).toEqual({ queued: true });
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-cid', cid: 1000001, discordId: OLD }]);
    const { lines } = await consume();
    expect(lines).toEqual([`Role sync (dry run): ${OLD} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing; nickname "Test Person1000001"`]);
    expect(vatusaCalls.slice(before)).toEqual(['/user/1000001']);
  });

  it('sees a change made on VATUSA since the run, rather than the run’s lists', async () => {
    // The run's lists say S3; VATUSA has since changed them to S2.
    fakeVatusaAndDiscord(vatusaLists(), server(), [], { users: [record({ cid: 1000001, rating: 3, rating_short: 'S2', discord_id: OLD })] });
    await cron();
    await consume();

    await syncOne(1000001);
    const { lines } = await consume();
    expect(lines[0]).toMatch(/CID 1000001: add Student 2[,;]/);
    expect(lines[0]).not.toContain('Student 3');
  });

  it("uses the run's lists, and says so, when the fresh read fails", async () => {
    fakeVatusaAndDiscord(vatusaLists(), server(), ['/user/1000001']);
    const warnings: string[] = [];
    vi.mocked(console.warn).mockImplementation((line: string) => void warnings.push(line));
    await cron();
    await consume();

    expect(await syncOne(1000001)).toEqual({ queued: true });
    const { lines } = await consume();
    expect(lines[0]).toContain('add Student 3');
    expect(warnings.some((line) => line.startsWith("Role sync: couldn't read VATUSA's record of CID 1000001 fresh"))).toBe(true);
  });

  it("looks the member up in VATUSA when no run's lists are kept", async () => {
    const { vatusaCalls } = fakeVatusaAndDiscord(vatusaLists(), server(), [], { users: [offList] });
    expect(await syncOne(1000020)).toEqual({ queued: true });
    expect(vatusaCalls).toEqual(['/user/1000020']);
  });

  it('declines a CID nobody knows a Discord account for', async () => {
    fakeVatusaAndDiscord(vatusaLists(), server());
    expect(await syncOne(1999999)).toEqual({
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
    env.ROLE_SYNC_MODE = 'on';
    await expect(syncOne(1000002)).rejects.toThrow('ROLE_SYNC_MODE "on"');
  });
});
