import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { DiscordMessage } from '../src/platforms/discord';
import type { RoleSyncMessage } from '../src/role-sync';
import type { VatusaRecord } from '../src/vatusa';
import { batchOf, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, LARRY, type Server, type Write } from './fake-discord';
import { identityEnv, idUser, type FakeUser } from './fake-identity';
import { fakeSource } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record, role } from './vatusa-records';

const JO = '800000000000000001';
const SAM = '800000000000000002';
const STRANGER = '800000000000000003';
const OWNER = '800000000000000004';
/** An account a member has linked in identity, which isn't their VATUSA Discord ID. */
const LINKED = '800000000000000005';

const ROLE = {
  observer: '896858108054368298',
  student3: '896858107051909159',
  member: '1125403438545641564',
  atc: '477495351838900254',
  mentor: '1178168909115969707',
  trainingStaff: '477496066590375947',
  seniorStaff: '1300575634296410164',
  handGiven: '600000000000000042',
  larry: '600000000000000001',
};
const MANAGE_ROLES = String(1n << 28n);

const member = (id: string, nick: string | null, ...roles: string[]) => ({ user: { id }, roles, nick });

function makeEnv(mode: string, users: FakeUser[] = []) {
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

/** A ZID S3 on the roster whose VATUSA Discord ID is `discordId`. */
const s3 = (cid: number, discordId: string, overrides: Partial<VatusaRecord> = {}) => record({ cid, rating: 4, rating_short: 'S3', discord_id: discordId, ...overrides });

/** Larry's role sits at position 10; the mapped roles given here sit where each says. */
const serverWith = (members: Server['members'], roles: Server['roles'] = [], extra: Partial<Server> = {}): Server => ({
  roles: [{ id: ROLE.larry, name: 'Larry', position: 10 }, ...(roles ?? [])],
  larryRoles: [ROLE.larry],
  members,
  ...extra,
});

let env: ReturnType<typeof makeEnv>;
let larry: Larry;
let logs: string[];
let warnings: string[];

function start(mode: string, users: FakeUser[] = []) {
  env = makeEnv(mode, users);
  larry = new Larry({} as ExecutionContext, env as never);
}

beforeEach(() => {
  start('live');
  logs = [];
  warnings = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void warnings.push(line));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cron = () => larry.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController);

/** Deliver what has been queued to the consumer. Returns its log lines and the messages. */
async function consume(bodies: RoleSyncMessage[] = env.ROLE_SYNC_QUEUE.sent.splice(0)) {
  const { batch, messages } = batchOf('role-sync', bodies);
  logs = [];
  await larry.queue(batch as never);
  return { lines: logs.filter((line) => line.startsWith('Role sync')), messages };
}

async function cronAndConsume() {
  await cron();
  return consume();
}

const roleWrites = (writes: Write[]) => writes.filter((write) => write.path.includes('/roles/')).map((write) => `${write.method} ${write.path}`);
const nicknameWrites = (writes: Write[]) => writes.filter((write) => write.method === 'PATCH').map((write) => [write.path.split('/').at(-1), write.body?.nick]);

describe('roles', () => {
  // An S3 still holding Observer, with their nickname already right so only roles change.
  const joServer = () => serverWith([member(JO, 'Test Person1000001', ROLE.observer, ROLE.member, ROLE.atc, ROLE.handGiven)]);

  it('live adds the one mapped role they lack and removes the one they shouldn\'t hold, and nothing else', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), joServer());
    const { lines, messages } = await cronAndConsume();

    expect(roleWrites(writes)).toEqual([`PUT /guilds/${GUILD}/members/${JO}/roles/${ROLE.student3}`, `DELETE /guilds/${GUILD}/members/${JO}/roles/${ROLE.observer}`]);
    expect(writes).toHaveLength(2);
    expect(lines).toContain(`Role sync (live): ${JO} CID 1000001: add Student 3; remove Observer`);
    expect(messages.every((message) => message.acked)).toBe(true);
  });

  it('dry-run works out the same changes and calls Discord for none of them', async () => {
    start('dry-run');
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), joServer());
    const { lines } = await cronAndConsume();

    expect(writes).toEqual([]);
    expect(lines).toContain(`Role sync (dry run): ${JO} CID 1000001: add Student 3; remove Observer`);
  });

  it('leaves a hand-given role the mapping does not name', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), joServer());
    await cronAndConsume();
    expect(writes.some((write) => write.path.includes(ROLE.handGiven))).toBe(false);
  });

  it("reads the member's roles again before changing them, not the ones the cron listed", async () => {
    const server = joServer();
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), server);
    await cron();
    // Someone takes Observer away and gives Student 3 by hand between the cron and the job.
    server.members![0]!.roles = [ROLE.student3, ROLE.member, ROLE.atc];
    await consume();

    expect(roleWrites(writes)).toEqual([]);
  });

  it('acks a member who has left the server by the time their job runs', async () => {
    const server = joServer();
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), server);
    await cron();
    server.members = [];
    const { messages } = await consume();

    expect(writes).toEqual([]);
    expect(messages[0]!.acked).toBe(true);
  });
});

describe('a run record written before platforms had their own parts', () => {
  const joServer = () => serverWith([member(JO, 'Test Person1000001', ROLE.observer, ROLE.member, ROLE.atc, ROLE.handGiven)]);

  /** Rewrite the newest run's record in KV in the older `{ people, server }` shape, with no `platforms`. */
  function toOldShape() {
    const runId = env.KV.store.get('role-sync:latest-run')!;
    const { people, platforms } = JSON.parse(env.KV.store.get(`role-sync:run:${runId}`)!) as { people: unknown; platforms: { discord: unknown } };
    env.KV.store.set(`role-sync:run:${runId}`, JSON.stringify({ people, server: platforms.discord }));
  }

  it("runs a run-member job against that run's people, reading the server now", async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), joServer());
    await cron();
    toOldShape();
    const { lines, messages } = await consume();

    expect(roleWrites(writes)).toEqual([`PUT /guilds/${GUILD}/members/${JO}/roles/${ROLE.student3}`, `DELETE /guilds/${GUILD}/members/${JO}/roles/${ROLE.observer}`]);
    expect(lines).toContain(`Role sync (live): ${JO} CID 1000001: add Student 3; remove Observer`);
    expect(messages.every((message) => message.acked)).toBe(true);
  });

  it("runs a sync-member job against the newest run's people", async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), joServer());
    await cron();
    env.ROLE_SYNC_QUEUE.sent.splice(0);
    toOldShape();
    const { lines, messages } = await consume([{ type: 'sync-member', discordId: JO }]);

    expect(roleWrites(writes)).toEqual([`PUT /guilds/${GUILD}/members/${JO}/roles/${ROLE.student3}`, `DELETE /guilds/${GUILD}/members/${JO}/roles/${ROLE.observer}`]);
    expect(lines).toContain(`Role sync (live): ${JO} CID 1000001: add Student 3; remove Observer`);
    expect(messages[0]!.acked).toBe(true);
  });
});

describe("a member the sync can't resolve", () => {
  // On no list, and VATUSA answers 404 for their Discord ID: two managed roles and a hand-given one.
  const strangerServer = (extra: Partial<Server> = {}) => serverWith([member(STRANGER, 'Someone', ROLE.observer, ROLE.handGiven, ROLE.member)], [], extra);
  const removals = (writes: Write[]) => roleWrites(writes).filter((write) => write.startsWith('DELETE'));

  it('live removes exactly their managed roles, leaving the hand-given role and the nickname', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(), strangerServer());
    const { lines, messages } = await cronAndConsume();

    expect(roleWrites(writes)).toEqual([`DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${ROLE.observer}`, `DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${ROLE.member}`]);
    expect(nicknameWrites(writes)).toEqual([]);
    expect(lines).toEqual([`Role sync (live): ${STRANGER} unresolved: remove Observer, Member`]);
    expect(messages[0]!.acked).toBe(true);
  });

  it('dry-run calls Discord for nothing and logs the roles it would remove', async () => {
    start('dry-run');
    const { writes } = fakeVatusaAndDiscord(listsWith(), strangerServer());
    const { lines } = await cronAndConsume();

    expect(writes).toEqual([]);
    expect(lines).toEqual([`Role sync (dry run): ${STRANGER} unresolved: remove Observer, Member`]);
  });

  it('still skips a mapped role at or above Larry\'s highest', async () => {
    const server = serverWith([member(STRANGER, null, ROLE.seniorStaff, ROLE.member)], [{ id: ROLE.seniorStaff, name: 'Senior Staff', position: 20 }]);
    const { writes } = fakeVatusaAndDiscord(listsWith(), server);
    await cronAndConsume();

    expect(roleWrites(writes)).toEqual([`DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${ROLE.member}`]);
    expect(warnings).toContain("Role sync: skipping mapped role Senior Staff this run: it is at or above Larry's highest role");
  });

  for (const [mode, label] of [['live', 'live'], ['dry-run', 'dry run']] as const) {
    it(`${mode}: leaves a bot account alone, mapped role and all, without looking it up`, async () => {
      start(mode);
      const { writes, vatusaCalls } = fakeVatusaAndDiscord(listsWith(), serverWith([{ user: { id: STRANGER, bot: true }, roles: [ROLE.member], nick: null }]));
      const { lines, messages } = await cronAndConsume();

      expect(writes).toEqual([]);
      expect(vatusaCalls).not.toContain(`/user/${STRANGER}?d`);
      expect(lines).toEqual([`Role sync (${label}): ${STRANGER} is a bot account: left alone`]);
      expect(messages[0]!.acked).toBe(true);
    });
  }

  it('leaves a bot account alone when it joins (sync-member)', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(), serverWith([{ user: { id: STRANGER, bot: true }, roles: [ROLE.member], nick: null }]));
    const { lines } = await consume([{ type: 'sync-member', discordId: STRANGER }]);

    expect(roleWrites(writes)).toEqual([]);
    expect(lines).toEqual([`Role sync (live): ${STRANGER} is a bot account: left alone`]);
  });

  it('fails the job, removing nothing, when the per-user lookup answers 500', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(), strangerServer());
    const fetched = globalThis.fetch;
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) =>
      url.endsWith(`/user/${STRANGER}?d`) ? Promise.resolve(new Response('Internal Server Error', { status: 500 })) : fetched(url, init),
    );
    const { messages } = await cronAndConsume();

    expect(removals(writes)).toEqual([]);
    expect(messages.map((message) => [message.acked, message.retried])).toEqual([[false, true]]);
  });

  it('fails the job, removing nothing, when identity is down', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(), strangerServer());
    await cron();
    env.IDENTITY.down = true;
    const { messages } = await consume();

    expect(removals(writes)).toEqual([]);
    expect(messages.map((message) => [message.acked, message.retried])).toEqual([[false, true]]);
  });

  it("removes the managed roles of an account unlinked in identity, at the next run, when it isn't anyone's VATUSA Discord ID", async () => {
    start('live', [idUser(1000001, LINKED)]);
    // Their VATUSA Discord ID is JO, not the account they had linked.
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), serverWith([member(LINKED, 'Test Person1000001', ROLE.student3, ROLE.member, ROLE.atc)]));
    await cronAndConsume();
    expect(roleWrites(writes)).toEqual([]);

    await larry.unlink(1000001, 'discord');
    env.ROLE_SYNC_QUEUE.sent.length = 0;
    const { lines } = await cronAndConsume();

    expect(removals(writes)).toEqual([ROLE.student3, ROLE.atc, ROLE.member].map((id) => `DELETE /guilds/${GUILD}/members/${LINKED}/roles/${id}`));
    expect(lines).toEqual([`Role sync (live): ${LINKED} unresolved: remove Student 3, Air Traffic Controller, Member`]);
  });
});

describe('an account whose CID is linked to another Discord account', () => {
  // VATUSA gives CID 1000001 the account JO, but identity has them linked to LINKED, so JO is a stale account.
  const staleServer = () => serverWith([member(JO, 'Test Person1000001', ROLE.observer, ROLE.handGiven, ROLE.member)]);

  it('live removes its managed roles, leaving the hand-given role', async () => {
    start('live', [idUser(1000001, LINKED)]);
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), staleServer());
    const { lines, messages } = await cronAndConsume();

    expect(roleWrites(writes)).toEqual([`DELETE /guilds/${GUILD}/members/${JO}/roles/${ROLE.observer}`, `DELETE /guilds/${GUILD}/members/${JO}/roles/${ROLE.member}`]);
    expect(nicknameWrites(writes)).toEqual([]);
    expect(lines).toEqual([`Role sync (live): ${JO} unresolved (their CID is linked to another Discord account): remove Observer, Member`]);
    expect(messages[0]!.acked).toBe(true);
  });

  it('dry-run logs the roles it would remove and calls Discord for nothing', async () => {
    start('dry-run', [idUser(1000001, LINKED)]);
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), staleServer());
    const { lines } = await cronAndConsume();

    expect(writes).toEqual([]);
    expect(lines).toEqual([`Role sync (dry run): ${JO} unresolved (their CID is linked to another Discord account): remove Observer, Member`]);
  });
});

describe("Larry's place in the role list", () => {
  // Jo is the ZID ATM (Senior Staff) and a mentor (Mentor, Training Staff).
  const atm = () => s3(1000001, JO, { roles: [role(1000001, 'ZID', 'ATM'), role(1000001, 'ZID', 'MTR')] });
  const ranked = (members: Server['members']) =>
    serverWith(members, [
      { id: ROLE.seniorStaff, name: 'Senior Staff', position: 20 },
      { id: ROLE.trainingStaff, name: 'Training Staff', position: 10 },
      { id: ROLE.mentor, name: 'Mentor', position: 5, permissions: MANAGE_ROLES },
    ]);

  it('skips a mapped role at or above its highest, with one log line per run, and still runs every job', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(atm(), s3(1000002, SAM)), ranked([member(JO, 'Test Person1000001'), member(SAM, 'Test Person1000002')]));
    const { messages } = await cronAndConsume();

    expect(warnings.filter((line) => line.startsWith('Role sync: skipping'))).toEqual([
      "Role sync: skipping mapped role Senior Staff this run: it is at or above Larry's highest role",
      "Role sync: skipping mapped role Training Staff this run: it is at or above Larry's highest role",
    ]);
    const changed = roleWrites(writes);
    expect(changed.some((write) => write.includes(ROLE.seniorStaff) || write.includes(ROLE.trainingStaff))).toBe(false);
    expect(changed).toContain(`PUT /guilds/${GUILD}/members/${SAM}/roles/${ROLE.student3}`);
    expect(messages.every((message) => message.acked)).toBe(true);
  });

  it('manages a mapped role with moderation permissions that sits below it', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(atm()), ranked([member(JO, 'Test Person1000001')]));
    await cronAndConsume();
    expect(roleWrites(writes)).toContain(`PUT /guilds/${GUILD}/members/${JO}/roles/${ROLE.mentor}`);
  });

  it("skips a mapped role that is a bot's role", async () => {
    const server = serverWith([member(JO, 'Test Person1000001')], [{ id: ROLE.member, name: 'Member', position: 1, managed: true }]);
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), server);
    await cronAndConsume();

    expect(warnings).toContain('Role sync: skipping mapped role Member this run: "Member" belongs to a bot or an integration');
    expect(roleWrites(writes).some((write) => write.includes(ROLE.member))).toBe(false);
  });

  it("leaves the nickname of someone whose role is above Larry's", async () => {
    const server = serverWith([member(JO, 'Boss', ROLE.seniorStaff)], [{ id: ROLE.seniorStaff, name: 'Senior Staff', position: 20 }]);
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO)), server);
    const { lines, messages } = await cronAndConsume();

    expect(nicknameWrites(writes)).toEqual([]);
    expect(lines[0]).toMatch(/; nickname left alone \(their highest role is at or above Larry's\)$/);
    expect(messages[0]!.acked).toBe(true);
  });
});

describe('a mapped role the server does not have', () => {
  const MISSING_LINE = `Role sync: mapped role Student 3 (${ROLE.student3}) isn't on the server; skipping it.`;
  const missingLines = () => warnings.filter((line) => line.includes("isn't on the server"));
  // Two S3s who are each due Student 3, Air Traffic Controller and Member.
  const two = () => serverWith([member(JO, 'Test Person1000001'), member(SAM, 'Test Person1000002')], [], { missingMapped: [ROLE.student3] });
  const both = () => listsWith(s3(1000001, JO), s3(1000002, SAM));

  it('live gives everyone their other roles, never asks for it, writes one log line, and acks every job', async () => {
    const { writes } = fakeVatusaAndDiscord(both(), two());
    const { messages } = await cronAndConsume();

    expect(roleWrites(writes).filter((write) => write.includes(ROLE.student3))).toEqual([]);
    expect(roleWrites(writes)).toEqual(
      [JO, SAM].flatMap((id) => [`PUT /guilds/${GUILD}/members/${id}/roles/${ROLE.atc}`, `PUT /guilds/${GUILD}/members/${id}/roles/${ROLE.member}`]),
    );
    expect(missingLines()).toEqual([MISSING_LINE]);
    expect(messages.every((message) => message.acked)).toBe(true);
  });

  it('dry-run skips it the same way and changes nothing', async () => {
    start('dry-run');
    const { writes } = fakeVatusaAndDiscord(both(), two());
    const { lines } = await cronAndConsume();

    expect(writes).toEqual([]);
    expect(missingLines()).toEqual([MISSING_LINE]);
    expect(lines).toContain(`Role sync (dry run): ${JO} CID 1000001: add Air Traffic Controller, Member; remove nothing`);
  });

  it('skips it for a join (sync-member) as well, where no run has kept its lists', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(), two(), [], { users: [s3(1000001, JO)] });
    const { messages } = await consume([{ type: 'sync-member', discordId: JO }]);

    expect(roleWrites(writes).some((write) => write.includes(ROLE.student3))).toBe(false);
    expect(roleWrites(writes)).toContain(`PUT /guilds/${GUILD}/members/${JO}/roles/${ROLE.atc}`);
    expect(missingLines()).toEqual([MISSING_LINE]);
    expect(messages[0]!.acked).toBe(true);
  });

  it("never removes or adds it for a member the sync can't resolve", async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(), serverWith([member(STRANGER, null, ROLE.observer)], [], { missingMapped: [ROLE.student3] }));
    const { messages } = await cronAndConsume();

    expect(roleWrites(writes)).toEqual([`DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${ROLE.observer}`]);
    expect(missingLines()).toEqual([MISSING_LINE]);
    expect(messages[0]!.acked).toBe(true);
  });
});

describe('a Discord failure', () => {
  it("fails that member's job, so the queue retries it, and the others go through", async () => {
    const server = serverWith([member(JO, null), member(SAM, null)], [], { forbidden: [JO] });
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO), s3(1000002, SAM)), server);
    const { messages } = await cronAndConsume();

    expect(messages.map((message) => [(message.body as DiscordMessage).discordId, message.acked, message.retried])).toEqual([
      [JO, false, true],
      [SAM, true, false],
    ]);
    expect(roleWrites(writes)).toContain(`PUT /guilds/${GUILD}/members/${SAM}/roles/${ROLE.student3}`);
  });
});

describe('nicknames', () => {
  /** Sync one ZID S3 (CID 1000001, Discord JO) in live, and return the nickname Larry set, if any. */
  async function nicknameOf(vatusa: Partial<VatusaRecord> | null, users: FakeUser[] = [], extras: Parameters<typeof fakeVatusaAndDiscord>[3] = {}) {
    start('live', users);
    const zid = vatusa ? [s3(1000001, JO, vatusa)] : [];
    const { writes } = fakeVatusaAndDiscord(listsWith(...zid), serverWith([member(JO, 'Old Name'), member(OWNER, null)], [], { owner: OWNER }), [], extras);
    const { messages } = await cronAndConsume();
    expect(messages.every((message) => message.acked)).toBe(true);
    return nicknameWrites(writes).find(([id]) => id === JO)?.[1];
  }
  const named = (name: string, discordId: string | null = null): FakeUser => ({ ...idUser(1000001, discordId), name });

  it("uses identity's name as it is, with nothing added", async () => {
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera' }, [named('jo r. (she/her)', JO)])).toBe('jo r. (she/her)');
  });

  it("uses a preferred name that looks like a name or a CID exactly", async () => {
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera' }, [named('Jordan S.', JO)])).toBe('Jordan S.');
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera' }, [named('1000001', JO)])).toBe('1000001');
  });

  it("reads identity's name for a member found through VATUSA, not only a linked one", async () => {
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera' }, [named('Jo')])).toBe('Jo');
  });

  describe("with VATUSA's name-privacy flag on", () => {
    const flagged = { fname: 'Joanna', lname: 'Rivera', flag_nameprivacy: true };

    it('uses First CID when they have no preferred name in identity, not the VATSIM name identity falls back to', async () => {
      expect(await nicknameOf(flagged, [named('Joanna Rivera', JO)])).toBe('Joanna 1000001');
    });

    it("uses identity's name when they have set a preferred name", async () => {
      expect(await nicknameOf(flagged, [{ ...named('Jordan S.', JO), preferred_name: 'Jordan S.' }])).toBe('Jordan S.');
    });

    it('shortens a long First CID as before', async () => {
      expect(await nicknameOf({ fname: 'Wolfeschlegelsteinhausenbergerdorff', lname: 'Smith', flag_nameprivacy: true }, [named('Wolfeschlegelsteinhausenbergerdorff Smith', JO)])).toBe(
        'Wolfeschlegelsteinhausenbergerdo',
      );
    });
  });

  it("uses identity's name when the flag is off and they have no preferred name", async () => {
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera' }, [named('Joanna Rivera', JO)])).toBe('Joanna Rivera');
  });

  it("shortens identity's name over 32 characters like a VATUSA name", async () => {
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera' }, [named('Joanna Maria Rivera-Delacroix of Indianapolis', JO)])).toBe('Joanna Indianapolis');
  });

  it("uses VATUSA's First Last", async () => {
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera' })).toBe('Joanna Rivera');
  });

  it("uses First CID when VATUSA's name-privacy flag is on", async () => {
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera', flag_nameprivacy: true })).toBe('Joanna 1000001');
  });

  describe("shortens a VATUSA name over 32 characters as VATUSA's bot does", () => {
    it('to first and last', async () => {
      expect(await nicknameOf({ fname: 'Maximilian', lname: 'Johann Sebastian von Hohenberg' })).toBe('Maximilian Hohenberg');
    });

    it('then to first and last initial', async () => {
      expect(await nicknameOf({ fname: 'Maximilian', lname: 'Featherstonehaugh-Wolfeschlegel' })).toBe('Maximilian F');
    });

    it('then to the first name', async () => {
      expect(await nicknameOf({ fname: 'Wolfeschlegelsteinhausenbergerd', lname: 'Smith' })).toBe('Wolfeschlegelsteinhausenbergerd');
    });

    it('then cuts the first name to 32', async () => {
      expect(await nicknameOf({ fname: 'Wolfeschlegelsteinhausenbergerdorff', lname: 'Smith' })).toBe('Wolfeschlegelsteinhausenbergerdo');
    });
  });

  it("uses identity's name for a linked member VATUSA doesn't know", async () => {
    expect(await nicknameOf(null, [named('Joanna Rivera', JO)], { vatsimRatings: { 1000001: 4 } })).toBe('Joanna Rivera');
  });

  it("falls back to VATUSA's name when identity has no name for the member", async () => {
    expect(await nicknameOf({ fname: 'Joanna', lname: 'Rivera' }, [idUser(1000001, JO)])).toBe('Joanna Rivera');
  });

  it('leaves the nickname of a member with no known CID', async () => {
    expect(await nicknameOf(null)).toBeUndefined();
  });

  it('leaves the nickname of a member rated below 1', async () => {
    expect(await nicknameOf(null, [named('Jo', JO)], { vatsimRatings: { 1000001: 0 } })).toBeUndefined();
  });

  it("skips the server's owner without an error", async () => {
    start('live');
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, OWNER)), serverWith([member(OWNER, null)], [], { owner: OWNER }));
    const { lines, messages } = await cronAndConsume();

    expect(nicknameWrites(writes)).toEqual([]);
    expect(roleWrites(writes)).toContain(`PUT /guilds/${GUILD}/members/${OWNER}/roles/${ROLE.student3}`);
    expect(lines[0]).toMatch(/nickname left alone \(the server's owner can't be renamed by a bot\)$/);
    expect(messages[0]!.acked).toBe(true);
  });

  describe('administrators', () => {
    const ADMIN_ROLE = '600000000000000050';
    const adminServer = () =>
      serverWith([member(JO, 'Old Name', ROLE.member, ROLE.atc, ROLE.student3, ADMIN_ROLE), member(OWNER, 'Old Owner', ADMIN_ROLE), member(SAM, 'Old Boss', ROLE.seniorStaff, ADMIN_ROLE)], [
        { id: ADMIN_ROLE, name: 'Admin', position: 5, permissions: String(1n << 3n) },
        { id: ROLE.seniorStaff, name: 'Senior Staff', position: 20 },
      ], { owner: OWNER });
    const people = () => listsWith(s3(1000001, JO, { fname: 'Joanna', lname: 'Rivera' }), s3(1000002, OWNER), s3(1000003, SAM));

    it('live renames one below Larry, and still leaves the owner and one above Larry', async () => {
      const { writes } = fakeVatusaAndDiscord(people(), adminServer());
      const { messages } = await cronAndConsume();

      expect(nicknameWrites(writes)).toEqual([[JO, 'Joanna Rivera']]);
      expect(messages.every((message) => message.acked)).toBe(true);
    });

    it('dry-run logs the nickname it would set, and why it leaves the others', async () => {
      start('dry-run');
      const { writes } = fakeVatusaAndDiscord(people(), adminServer());
      const { lines } = await cronAndConsume();

      expect(writes).toEqual([]);
      expect(lines.find((line) => line.includes(JO))).toBe(`Role sync (dry run): ${JO} CID 1000001: add nothing; remove nothing; nickname "Joanna Rivera"`);
      expect(lines.find((line) => line.includes(OWNER))).toMatch(/nickname left alone \(the server's owner/);
      expect(lines.find((line) => line.includes(SAM))).toMatch(/nickname left alone \(their highest role is at or above Larry's\)/);
    });
  });

  it('dry-run logs the nickname it would set and sets nothing', async () => {
    start('dry-run');
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO, { fname: 'Joanna', lname: 'Rivera' })), serverWith([member(JO, 'Old Name')]));
    const { lines } = await cronAndConsume();

    expect(writes).toEqual([]);
    expect(lines[0]).toBe(`Role sync (dry run): ${JO} CID 1000001: add Student 3, Air Traffic Controller, Member; remove nothing; nickname "Joanna Rivera"`);
  });

  it('writes nothing when the nickname is already right', async () => {
    const { writes } = fakeVatusaAndDiscord(listsWith(s3(1000001, JO, { fname: 'Joanna', lname: 'Rivera' })), serverWith([member(JO, 'Joanna Rivera')]));
    await cronAndConsume();
    expect(nicknameWrites(writes)).toEqual([]);
  });

  describe('when identity can only be asked for the names', () => {
    // A job by CID needs identity only for the nickname: its link was settled when it was queued.
    const byCid: RoleSyncMessage = { type: 'sync-cid', cid: 1000001, discordId: JO };

    it("uses identity's name when identity answers", async () => {
      start('live', [named('Jo', JO)]);
      const { writes } = fakeVatusaAndDiscord(listsWith(), serverWith([member(JO, null)]), [], { users: [s3(1000001, JO, { fname: 'Joanna', lname: 'Rivera' })] });
      await consume([byCid]);
      expect(nicknameWrites(writes)).toEqual([[JO, 'Jo']]);
    });

    it("falls back to VATUSA's name when identity can't be reached, logs it, and doesn't fail the job", async () => {
      start('live', [named('Jo', JO)]);
      env.IDENTITY.down = true;
      const { writes } = fakeVatusaAndDiscord(listsWith(), serverWith([member(JO, null)]), [], { users: [s3(1000001, JO, { fname: 'Joanna', lname: 'Rivera' })] });
      const { messages } = await consume([byCid]);

      expect(nicknameWrites(writes)).toEqual([[JO, 'Joanna Rivera']]);
      expect(warnings.some((line) => line.startsWith(`Role sync: couldn't reach identity for ${JO}'s name; using VATUSA's name`))).toBe(true);
      expect(messages[0]!.acked).toBe(true);
    });
  });
});
