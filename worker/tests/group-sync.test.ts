import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Group } from '../src/client/api';
import { checkGroupSources, GROUP_SOURCES } from '../src/group-sources';
import Larry from '../src/index';
import { MAPPING } from '../src/mapping';
import type { RoleSyncMessage } from '../src/role-sync';
import type { VatusaRecord } from '../src/vatusa';
import { batchOf, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, type Server, type Write } from './fake-discord';
import { identityEnv, type FakeUser } from './fake-identity';
import { fakeSource, group } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record } from './vatusa-records';

const ALERTS = '300000000000000001';
const CATEGORY = '310000000000000001';
const OTHER_CATEGORY = '310000000000000002';
const ADMINS = GROUP_SOURCES[0]!.roomViewers[0]!;
const LARRY_ROLE = '600000000000000001';
const MEMBER_ROLE = '1125403438545641564';

const JO = '800000000000000001';
const SAM = '800000000000000002';
const KIM = '800000000000000003';

function makeEnv(groups: Group[], mode = 'live', roleSyncMode = 'live') {
  return {
    DISCORD_TOKEN: 'token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: `tech-team-alerts:${ALERTS}`,
    CHANNEL_CATEGORIES: `training:${CATEGORY}, events:${OTHER_CATEGORY}`,
    ROLE_SYNC_MODE: roleSyncMode,
    GROUP_SYNC_TRAINING: mode,
    KV: fakeKv(),
    TRAINING: fakeSource(groups),
    ...identityEnv([] as FakeUser[]),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<unknown>(),
  };
}

/** ZID S3s with these CIDs and Discord IDs, and someone on every list so the run isn't skipped. */
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
const s3 = (cid: number, discordId: string) => record({ cid, rating: 4, rating_short: 'S3', discord_id: discordId });
const people = () => listsWith(s3(1000001, JO), s3(1000002, SAM), s3(1000003, KIM));

const member = (id: string, ...roles: string[]) => ({ user: { id }, roles, nick: `Test Person${id === JO ? 1000001 : id === SAM ? 1000002 : 1000003}` });

/** Larry's role at position 10, above everything a test adds. */
const serverWith = (extra: Partial<Server> = {}): Server => ({
  roles: [{ id: LARRY_ROLE, name: 'Larry', position: 10 }, ...(extra.roles ?? [])],
  larryRoles: [LARRY_ROLE],
  channels: extra.channels ?? [],
  members: extra.members ?? [member(JO, MEMBER_ROLE), member(SAM, MEMBER_ROLE), member(KIM, MEMBER_ROLE)],
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => !['roles', 'channels', 'members'].includes(key))),
});

let env: ReturnType<typeof makeEnv>;
let larry: Larry;
let logs: string[];
let server: Server;
let writes: Write[];

function start(groups: Group[], mode = 'live', roleSyncMode = 'live') {
  env = makeEnv(groups, mode, roleSyncMode);
  larry = new Larry({} as ExecutionContext, env as never);
}

function discordWith(extra: Partial<Server> = {}, vatusa = people()) {
  server = serverWith(extra);
  writes = fakeVatusaAndDiscord(vatusa, server).writes;
}

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, 'warn').mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const cron = () => larry.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController);

async function consume(bodies: RoleSyncMessage[] = env.ROLE_SYNC_QUEUE.sent.splice(0)) {
  const { batch, messages } = batchOf('role-sync', bodies);
  logs = [];
  await larry.queue(batch as never);
  return { lines: logs.filter((line) => line.startsWith('Role sync')), messages };
}

const record_ = (key: string) => JSON.parse(env.KV.store.get(`group:training:${key}`) ?? 'null');
const roleWrites = () => writes.filter((write) => write.path.startsWith(`/guilds/${GUILD}/roles`)).map((write) => `${write.method} ${write.path}${write.body?.name ? ` ${write.body.name}` : ''}`);
const MAPPED = new Set(MAPPING.map((entry) => entry.discordRoleId));
/** Changes to members' group roles: mapped roles, which the VATUSA side of the sync settles, are left out. */
const memberRoleWrites = () =>
  writes.filter((write) => write.path.includes('/members/') && !MAPPED.has(write.path.split('/').at(-1))).map((write) => `${write.method} ${write.path.replace(`/guilds/${GUILD}/members/`, '')}`);
const alerts = () => writes.filter((write) => write.path === `/channels/${ALERTS}/messages`).map((write) => String(write.body?.content));

describe('the config', () => {
  it('is one larry can honour', () => {
    expect(() => checkGroupSources(GROUP_SOURCES)).not.toThrow();
  });
});

describe('making roles', () => {
  it('uses a role already named for the group, and stores its ID even in dry-run', async () => {
    start([group('S1', 'S1 Certified', [1000001])], 'dry-run');
    discordWith({ roles: [{ id: '600000000000000050', name: 'S1 Certified', position: 1 }] });
    await cron();

    expect(roleWrites()).toEqual([]);
    expect(record_('S1')).toEqual({ roleId: '600000000000000050', channelId: null, missingSince: null });
    expect((await larry.getGroupStatus('training')).groups).toEqual([{ key: 'S1', name: 'S1 Certified', role: 'found' }]);
  });

  it('creates a role with no permissions when none is named for the group', async () => {
    start([group('S1', 'S1 Certified', [1000001])]);
    discordWith();
    await cron();

    expect(writes.find((write) => write.method === 'POST' && write.path === `/guilds/${GUILD}/roles`)?.body).toEqual({ name: 'S1 Certified', permissions: '0' });
    expect(record_('S1').roleId).toBe('600000000000000099');
    expect((await larry.getGroupStatus('training')).groups[0]!.role).toBe('created');
  });

  it('renames a stored role whose name has drifted', async () => {
    start([group('S1', 'S1 Certified', [1000001])]);
    discordWith({ roles: [{ id: '600000000000000050', name: 'S1', position: 1 }] });
    env.KV.store.set('group:training:S1', JSON.stringify({ roleId: '600000000000000050', channelId: null, missingSince: null }));
    await cron();

    expect(roleWrites()).toEqual([`PATCH /guilds/${GUILD}/roles/600000000000000050 S1 Certified`]);
    expect((await larry.getGroupStatus('training')).groups[0]!.role).toBe('renamed');
  });
});

describe("members' group roles", () => {
  const S1 = '600000000000000050';
  const S2 = '600000000000000051';
  const HAND_GIVEN = '600000000000000052';
  const certRoles = () => [
    { id: S1, name: 'S1 Certified', position: 1 },
    { id: S2, name: 'S2 Certified', position: 1 },
    { id: HAND_GIVEN, name: 'Helper', position: 1 },
  ];

  it('gives a member the roles of the groups listing their CID and takes the others', async () => {
    start([group('S1', 'S1 Certified', [1000001, 1000002]), group('S2', 'S2 Certified', [1000002])]);
    discordWith({ roles: certRoles(), members: [member(JO, MEMBER_ROLE, S2, HAND_GIVEN), member(SAM, MEMBER_ROLE, S2), member(KIM, MEMBER_ROLE, S1)] });
    await cron();
    const { lines } = await consume();

    expect(memberRoleWrites().sort()).toEqual([`DELETE ${JO}/roles/${S2}`, `DELETE ${KIM}/roles/${S1}`, `PUT ${JO}/roles/${S1}`, `PUT ${SAM}/roles/${S1}`].sort());
    expect(lines.find((line) => line.startsWith(`Role sync (live): ${JO} CID 1000001:`))).toMatch(/; training groups \(live\): add S1 Certified; remove S2 Certified$/);
  });

  it('takes every group role from an unresolved account', async () => {
    const STRANGER = '800000000000000009';
    start([group('S1', 'S1 Certified', [1000001])]);
    discordWith({ roles: certRoles(), members: [member(STRANGER, S1, HAND_GIVEN)] });
    await cron();
    await consume();

    expect(memberRoleWrites()).toEqual([`DELETE ${STRANGER}/roles/${S1}`]);
  });

  it('ignores a group role the mapping manages, with one log line a run', async () => {
    start([group('MEMBERS', 'Member', [1000001]), group('ALSO', 'Member copy', [1000002])]);
    discordWith({ roles: [{ id: MEMBER_ROLE, name: 'Member', position: 1 }] });
    env.KV.store.set('group:training:ALSO', JSON.stringify({ roleId: MEMBER_ROLE, channelId: null, missingSince: null }));
    await cron();
    expect(logs.filter((line) => line.includes('the mapping manages this run'))).toHaveLength(1);
    await consume();

    expect(roleWrites()).toEqual([]);
    expect(memberRoleWrites()).toEqual([]);
    expect(record_('MEMBERS')).toBeNull();
    expect(alerts()).toEqual([]);
  });

  it('refuses a role found by name that carries moderation permissions: failed, alerted, nobody changed, nothing created', async () => {
    const MODS = '600000000000000060';
    start([group('MODS', 'Moderators', [1000001])]);
    discordWith({ roles: [{ id: MODS, name: 'Moderators', position: 1, permissions: String(1n << 1n) }], members: [member(JO, MEMBER_ROLE), member(SAM, MEMBER_ROLE, MODS)] });
    await cron();
    await consume();

    expect((await larry.getGroupStatus('training')).groups).toEqual([{ key: 'MODS', name: 'Moderators', role: 'failed', error: expect.stringContaining('moderation permissions') }]);
    expect(roleWrites()).toEqual([]);
    expect(memberRoleWrites()).toEqual([]);
    expect(record_('MODS')).toBeNull();
    expect(alerts()).toEqual([expect.stringContaining('moderation permissions')]);
  });

  it('only logs a dry-run source\'s group-role changes under a live role sync', async () => {
    start([group('S1', 'S1 Certified', [1000001])], 'dry-run', 'live');
    discordWith({ roles: certRoles(), members: [member(JO, MEMBER_ROLE)] });
    await cron();
    const { lines } = await consume();

    expect(memberRoleWrites()).toEqual([]);
    expect(lines.find((line) => line.startsWith(`Role sync (live): ${JO} CID 1000001:`))).toMatch(/; training groups \(dry run\): add S1 Certified; remove nothing$/);
  });

  it('changes nothing in Discord under a dry-run role sync, and its status says what would happen', async () => {
    start([group('S1', 'S1 Certified', [1000001]), group('NEW', 'New Group', [1000001])], 'live', 'dry-run');
    discordWith({ roles: certRoles(), members: [member(JO, MEMBER_ROLE)] });
    await cron();
    await consume();

    expect(writes.filter((write) => !write.path.includes('/messages'))).toEqual([]);
    expect(await larry.getGroupStatus('training')).toMatchObject({ mode: 'dry-run', groups: [{ key: 'S1', role: 'found' }, { key: 'NEW', role: 'created' }] });
  });

  it('reads nothing when the source is off', async () => {
    start([group('S1', 'S1 Certified', [1000001])], 'off');
    discordWith({ roles: certRoles(), members: [member(JO, MEMBER_ROLE)] });
    await cron();
    await consume();

    expect(env.TRAINING.calls).toBe(0);
    expect(memberRoleWrites()).toEqual([]);
    expect(await larry.getGroupStatus('training')).toMatchObject({ mode: 'off', groups: [] });
  });

  it('leaves a hold group exactly as it is, and makes none with no record', async () => {
    start([group('S1', 'S1 Renamed', [1000002], { hold: true }), group('NEW', 'New Group', [1000001], { hold: true })]);
    discordWith({ roles: certRoles(), members: [member(JO, MEMBER_ROLE, S1), member(SAM, MEMBER_ROLE)] });
    env.KV.store.set('group:training:S1', JSON.stringify({ roleId: S1, channelId: null, missingSince: null }));
    await cron();
    await consume();

    expect(roleWrites()).toEqual([]);
    expect(memberRoleWrites()).toEqual([]);
    expect(record_('NEW')).toBeNull();
    expect((await larry.getGroupStatus('training')).groups.map((line) => line.role)).toEqual(['held', 'held']);
  });

  it("leaves a source's roles alone in a job with no copy of its groups", async () => {
    start([group('S1', 'S1 Certified', [1000001])]);
    discordWith({ roles: certRoles(), members: [member(JO, MEMBER_ROLE), member(KIM, MEMBER_ROLE, S1)] });
    await cron();
    env.KV.store.delete('group-sync:training:copy');
    await consume();

    expect(memberRoleWrites()).toEqual([]);
  });
});

describe('a group no longer served', () => {
  const ROLE = '600000000000000050';
  const ROOM = '700000000000000002';
  const HOUR = 60 * 60 * 1000;
  const served = () => group('JR', 'Teacher JR', [1000001], { room: { name: 'Jo Rivera', fallbackName: 'Jo 1000001' } });

  /** A served group with its role and room made, and JO holding the role; then the source stops serving it. */
  async function goneAfterARun() {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-21T12:00:00Z'));
    start([served()]);
    discordWith({ roles: [{ id: ROLE, name: 'Teacher JR', position: 1 }], channels: [{ id: ROOM, name: 'jo-rivera', type: 0, parent_id: CATEGORY }], members: [member(JO, MEMBER_ROLE, ROLE), member(SAM, MEMBER_ROLE, ROLE)] });
    await cron();
    await consume();
    writes.length = 0;
    env.TRAINING.answer = { groups: [] };
  }

  const deletions = () => writes.filter((write) => write.method === 'DELETE').map((write) => write.path);

  it('is left alone at once, its role on nobody changed, and alerts once', async () => {
    await goneAfterARun();
    await cron();
    await consume();
    await cron();

    expect(memberRoleWrites()).toEqual([]);
    expect(deletions()).toEqual([]);
    expect(alerts()).toEqual([expect.stringContaining('no longer serves group "JR" (Teacher JR)')]);
    expect(record_('JR').missingSince).toBe('2026-11-21T12:00:00.000Z');
    expect((await larry.getGroupStatus('training')).groups).toEqual([{ key: 'JR', name: 'Teacher JR', role: 'missing', room: 'missing' }]);
  });

  it('is deleted after 48 hours, the channel before the role, and its record goes', async () => {
    await goneAfterARun();
    await cron();
    vi.setSystemTime(new Date(Date.now() + 47 * HOUR));
    await cron();
    expect(deletions()).toEqual([]);

    vi.setSystemTime(new Date(Date.now() + 2 * HOUR));
    await cron();
    expect(deletions()).toEqual([`/channels/${ROOM}`, `/guilds/${GUILD}/roles/${ROLE}`]);
    expect(record_('JR')).toBeNull();
    expect((await larry.getGroupStatus('training')).groups).toEqual([{ key: 'JR', name: 'Teacher JR', role: 'deleted', room: 'deleted' }]);
  });

  it('keeps its record until Discord confirms each deletion', async () => {
    await goneAfterARun();
    await cron();
    vi.setSystemTime(new Date(Date.now() + 49 * HOUR));
    server.forbidden = [ROLE];
    await cron();

    expect(record_('JR')).toEqual({ roleId: ROLE, channelId: null, missingSince: '2026-11-21T12:00:00.000Z' });
    expect((await larry.getGroupStatus('training')).groups[0]).toMatchObject({ role: 'failed', room: 'deleted' });
    expect(alerts().at(-1)).toContain('couldn\'t delete training group "JR"');

    server.forbidden = [];
    await cron();
    expect(record_('JR')).toBeNull();
  });

  it('is managed again, and keeps everything, when served again within the grace period', async () => {
    await goneAfterARun();
    await cron();
    vi.setSystemTime(new Date(Date.now() + 47 * HOUR));
    env.TRAINING.answer = { groups: [served()] };
    await cron();
    vi.setSystemTime(new Date(Date.now() + 2 * HOUR));
    await cron();
    await consume();

    expect(deletions()).toEqual([]);
    expect(record_('JR')).toEqual({ roleId: ROLE, channelId: ROOM, missingSince: null });
    expect((await larry.getGroupStatus('training')).groups).toEqual([{ key: 'JR', name: 'Teacher JR', role: 'found', room: 'found' }]);
  });
});

describe('a refused answer', () => {
  const S1 = '600000000000000050';
  const many = (n: number) => Array.from({ length: n }, (_, i) => 1000100 + i);

  it('is refused when its members fall by more than half: it changes nothing of its own, and alerts', async () => {
    start([group('S1', 'S1 Certified', [1000001, ...many(30)])]);
    discordWith({ roles: [{ id: S1, name: 'S1 Certified', position: 1 }], members: [member(JO, MEMBER_ROLE, S1), member(KIM, MEMBER_ROLE)] });
    await cron();
    await consume();
    writes.length = 0;

    env.TRAINING.answer = { groups: [group('S1', 'S1 Renamed', many(10)), group('NEW', 'New Group', [1000003])] };
    await cron();
    await consume();

    expect(memberRoleWrites()).toEqual([]);
    expect(roleWrites()).toEqual([]);
    expect(alerts()).toEqual([expect.stringContaining('its members fell from 31 to 11, by more than half')]);
    expect(await larry.getGroupStatus('training')).toMatchObject({ refused: expect.stringContaining('fell from 31 to 11'), groups: [] });
  });

  it('goes through once a maintainer resets the last answer', async () => {
    start([group('S1', 'S1 Certified', [1000001, ...many(30)])]);
    discordWith({ roles: [{ id: S1, name: 'S1 Certified', position: 1 }], members: [member(JO, MEMBER_ROLE, S1)] });
    await cron();
    env.TRAINING.answer = { groups: [group('S1', 'S1 Certified', many(10))] };
    await cron();
    env.KV.store.delete('group-sync:training:last');
    await cron();
    await consume();

    expect(memberRoleWrites()).toEqual([`DELETE ${JO}/roles/${S1}`]);
  });

  it('allows a small source to fall by more than half, by 10 or fewer', async () => {
    start([group('S1', 'S1 Certified', many(12))]);
    discordWith({ roles: [{ id: S1, name: 'S1 Certified', position: 1 }] });
    await cron();
    env.TRAINING.answer = { groups: [group('S1', 'S1 Certified', many(2))] };
    await cron();

    expect((await larry.getGroupStatus('training')).refused).toBeUndefined();
  });

  for (const [what, breakIt] of [
    ['a failing source', () => void (env.TRAINING.down = true)],
    ['a malformed answer', () => void (env.TRAINING.answer = { groups: [group('S1', 'S1 Certified', [1000001]), group('S1', 'Again', [])] })],
    ['a group with a bad member', () => void (env.TRAINING.answer = { groups: [{ key: 'S1', name: 'S1 Certified', members: ['jo'] }] })],
  ] as const) {
    it(`${what} changes nothing of its own and alerts once, while VATUSA's mapped roles still sync`, async () => {
      start([group('S1', 'S1 Certified', [1000001])]);
      discordWith({ roles: [{ id: S1, name: 'S1 Certified', position: 1 }], members: [member(JO, MEMBER_ROLE), member(KIM, MEMBER_ROLE, S1)] });
      breakIt();
      await cron();
      await consume();
      await cron();

      expect(memberRoleWrites()).toEqual([]);
      expect(writes.filter((write) => write.path.includes('/members/')).length).toBeGreaterThan(0);
      expect(alerts()).toEqual([expect.stringContaining("Group sync: refused training's groups")]);
    });
  }

  it("still syncs VATUSA's roles through syncMembers while the source fails", async () => {
    start([group('S1', 'S1 Certified', [1000001])]);
    discordWith({ members: [member(JO)] });
    env.TRAINING.down = true;
    await cron();
    env.ROLE_SYNC_QUEUE.sent.length = 0;
    expect(await larry.syncMembers([1000001])).toEqual([{ cid: 1000001, queued: true }]);
    const { lines } = await consume();

    expect(lines[0]).toMatch(new RegExp(`^Role sync \\(live\\): ${JO} CID 1000001: add Student 3`));
  });
});

describe('syncMembers', () => {
  const S1 = '600000000000000050';

  it('reads the source again and gives a newly listed member their role within the job', async () => {
    start([group('S1', 'S1 Certified', [1000001])]);
    discordWith({ roles: [{ id: S1, name: 'S1 Certified', position: 1 }], members: [member(JO, MEMBER_ROLE, S1), member(SAM, MEMBER_ROLE)] });
    await cron();
    await consume();
    writes.length = 0;

    env.TRAINING.answer = { groups: [group('S1', 'S1 Certified', [1000001, 1000002])] };
    expect(await larry.syncMembers([1000002])).toEqual([{ cid: 1000002, queued: true }]);
    await consume();

    expect(env.TRAINING.calls).toBe(2);
    expect(memberRoleWrites()).toEqual([`PUT ${SAM}/roles/${S1}`]);
  });

  it("doesn't let a cron job queued before it, running after, take the role back", async () => {
    start([group('S1', 'S1 Certified', [1000001])]);
    discordWith({ roles: [{ id: S1, name: 'S1 Certified', position: 1 }], members: [member(JO, MEMBER_ROLE, S1), member(SAM, MEMBER_ROLE)] });
    await cron();
    const runJobs = env.ROLE_SYNC_QUEUE.sent.splice(0);

    env.TRAINING.answer = { groups: [group('S1', 'S1 Certified', [1000001, 1000002])] };
    await larry.syncMembers([1000002]);
    await consume();
    server.members!.find((held) => held.user.id === SAM)!.roles.push(S1);
    await consume(runJobs);

    expect(memberRoleWrites()).toEqual([`PUT ${SAM}/roles/${S1}`]);
  });

  it('syncs against the last accepted copy when its read is refused', async () => {
    start([group('S1', 'S1 Certified', [1000001, 1000002])]);
    discordWith({ roles: [{ id: S1, name: 'S1 Certified', position: 1 }], members: [member(JO, MEMBER_ROLE), member(SAM, MEMBER_ROLE)] });
    await cron();
    env.ROLE_SYNC_QUEUE.sent.length = 0;
    env.TRAINING.down = true;
    await larry.syncMembers([1000002]);
    await consume();

    expect(memberRoleWrites()).toEqual([`PUT ${SAM}/roles/${S1}`]);
  });

  it('makes no roles or channels: a new group waits for the next cron run', async () => {
    start([]);
    discordWith();
    await cron();
    env.ROLE_SYNC_QUEUE.sent.length = 0;
    env.TRAINING.answer = { groups: [group('NEW', 'New Group', [1000001], { room: { name: 'New', fallbackName: 'New 1' } })] };
    await larry.syncMembers([1000001]);
    await consume();

    expect(writes.filter((write) => write.method === 'POST' && !write.path.includes('/messages'))).toEqual([]);
    expect(memberRoleWrites()).toEqual([]);
  });
});

describe('postToGroup', () => {
  const ROLE = '600000000000000050';
  const ROOM = '700000000000000002';
  const teacher = (members: number[]) => group('JR', 'Teacher JR', members, { room: { name: 'Jo Rivera', fallbackName: 'Jo 1000001' } });
  const notice = { title: 'New student', body: 'Say hello to **Sam** @everyone', fields: [{ name: 'Course', value: 'S1_[basics]' }] };

  async function made(vatusa = people()) {
    start([teacher([1000001])]);
    discordWith({ roles: [{ id: ROLE, name: 'Teacher JR', position: 1 }], channels: [{ id: ROOM, name: 'jo-rivera', type: 0, parent_id: CATEGORY, guild_id: GUILD }], members: [member(JO, MEMBER_ROLE, ROLE), member(SAM, MEMBER_ROLE), member(KIM, MEMBER_ROLE)] }, vatusa);
    await cron();
    await consume();
    writes.length = 0;
  }

  it("gives a just-listed student the room's role, then queues the post mentioning them", async () => {
    await made();
    env.TRAINING.answer = { groups: [teacher([1000001, 1000002])] };
    let rolesWhenQueued: string[] = [];
    const send = env.LARRY_QUEUE.send.bind(env.LARRY_QUEUE);
    env.LARRY_QUEUE.send = (async (body: unknown) => {
      rolesWhenQueued = memberRoleWrites();
      return send(body);
    }) as typeof env.LARRY_QUEUE.send;

    expect(await larry.postToGroup({ source: 'training', key: 'JR', notice, mention: ['1000002', '1999999'] })).toBe('posted');
    expect(rolesWhenQueued).toEqual([`PUT ${SAM}/roles/${ROLE}`]);
    expect(env.LARRY_QUEUE.sent).toEqual([
      {
        target: { channelId: ROOM },
        message: {
          content: `<@${SAM}>`,
          embeds: [{ title: 'New student', description: 'Say hello to \\*\\*Sam\\*\\* \\@everyone', fields: [{ name: 'Course', value: 'S1\\_\\[basics\\]' }] }],
          allowed_mentions: { users: [SAM] },
        },
      },
    ]);
  });

  it('mentions nobody for a CID whose VATUSA Discord ID is shared with another CID', async () => {
    await made(listsWith(s3(1000001, JO), s3(1000003, KIM), s3(1000004, KIM)));
    expect(await larry.postToGroup({ source: 'training', key: 'JR', notice, mention: ['1000003'] })).toBe('posted');

    expect(memberRoleWrites()).toEqual([]);
    expect(env.LARRY_QUEUE.sent).toEqual([expect.objectContaining({ message: expect.objectContaining({ content: undefined, allowed_mentions: { users: [] } }) })]);
  });

  it("answers no-room for a group that has none, and not-live when the source isn't live", async () => {
    await made();
    expect(await larry.postToGroup({ source: 'training', key: 'S9', notice })).toBe('no-room');
    env.TRAINING.answer = { groups: [group('JR', 'Teacher JR', [1000001])] };
    expect(await larry.postToGroup({ source: 'training', key: 'JR', notice })).toBe('no-room');

    env.GROUP_SYNC_TRAINING = 'dry-run';
    expect(await larry.postToGroup({ source: 'training', key: 'JR', notice })).toBe('not-live');
    expect(env.LARRY_QUEUE.sent).toEqual([]);
  });

  it('refuses an unknown source, and a notice with no title', async () => {
    await made();
    await expect(larry.postToGroup({ source: 'pilots', key: 'JR', notice })).rejects.toThrow('Unknown group source "pilots"');
    await expect(larry.postToGroup({ source: 'training', key: 'JR', notice: { title: ' ', body: 'x' } })).rejects.toThrow('The title must be some text');
  });
});

describe('making rooms', () => {
  const teacher = (key: string, name: string, fallbackName: string) => group(key, `Teacher ${key}`, [1000001], { room: { name, fallbackName } });
  const created = () => writes.filter((write) => write.method === 'POST' && write.path === `/guilds/${GUILD}/channels`).map((write) => write.body!);

  it("makes a channel under the source's category, seen only by the group's role, the room viewers and Larry", async () => {
    start([teacher('JR', 'Jo Rivera', 'Jo 1000001')]);
    discordWith();
    await cron();

    const roleId = record_('JR').roleId;
    expect(created()).toEqual([
      {
        name: 'jo-rivera',
        type: 0,
        parent_id: CATEGORY,
        permission_overwrites: [
          { id: GUILD, type: 0, deny: String(1n << 10n) },
          expect.objectContaining({ id: roleId, type: 0 }),
          expect.objectContaining({ id: ADMINS, type: 0 }),
          expect.objectContaining({ id: '400000000000000000', type: 1 }),
        ],
      },
    ]);
    expect(record_('JR')).toEqual({ roleId, channelId: '700000000000000099', missingSince: null });
    expect((await larry.getGroupStatus('training')).groups).toEqual([{ key: 'JR', name: 'Teacher JR', role: 'created', room: 'created' }]);
  });

  it('uses a channel of that name already in the category, leaving its permissions, and not one elsewhere', async () => {
    start([teacher('JR', 'Jo Rivera', 'Jo 1000001')]);
    discordWith({ channels: [{ id: '700000000000000001', name: 'jo-rivera', type: 0, parent_id: OTHER_CATEGORY }, { id: '700000000000000002', name: 'jo-rivera', type: 0, parent_id: CATEGORY }] });
    await cron();

    expect(created()).toEqual([]);
    expect(writes.filter((write) => write.path.startsWith('/channels/700'))).toEqual([]);
    expect(record_('JR').channelId).toBe('700000000000000002');
  });

  it('gives two rooms whose names collide in Discord their fallback names', async () => {
    start([teacher('JR', 'Jo Rivera', 'Jo 1000001'), teacher('JR2', 'Jo  Rivera', 'Jo 1000002'), teacher('SK', 'Sam Kim', 'Sam 1000003')]);
    discordWith();
    await cron();

    expect(created().map((body) => body.name)).toEqual(['jo-1000001', 'jo-1000002', 'sam-kim']);
  });

  it('renames a stored room to its fallback name once its name collides', async () => {
    start([teacher('JR', 'Jo Rivera', 'Jo 1000001'), teacher('JR2', 'Jo Rivera', 'Jo 1000002')]);
    discordWith({ roles: [{ id: '600000000000000050', name: 'Teacher JR', position: 1 }], channels: [{ id: '700000000000000002', name: 'jo-rivera', type: 0, parent_id: CATEGORY }] });
    env.KV.store.set('group:training:JR', JSON.stringify({ roleId: '600000000000000050', channelId: '700000000000000002', missingSince: null }));
    await cron();

    expect(writes.filter((write) => write.method === 'PATCH').map((write) => [write.path, write.body?.name])).toEqual([['/channels/700000000000000002', 'jo-1000001']]);
    expect((await larry.getGroupStatus('training')).groups.map((line) => line.room)).toEqual(['renamed', 'created']);
  });

  it('creates at most 25 roles and channels a run; the rest wait for the next', async () => {
    start(Array.from({ length: 15 }, (_, i) => teacher(`T${i}`, `Teacher ${i}`, `Teacher ${i} fallback`)));
    discordWith();
    await cron();

    const posts = writes.filter((write) => write.method === 'POST' && !write.path.includes('/messages'));
    expect(posts).toHaveLength(25);
    const status = await larry.getGroupStatus('training');
    expect(status.groups.filter((line) => line.role === 'failed' || line.room === 'failed')).toHaveLength(3);
    expect(alerts()).toEqual([]);

    writes.length = 0;
    await cron();
    expect(writes.filter((write) => write.method === 'POST' && !write.path.includes('/messages'))).toHaveLength(5);
  });
});
