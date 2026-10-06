import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkRoles, deleteRoles, prepareMemberRole, setMemberRole, syncRoles } from '../src/roles';
import { consume, type QueueJob } from '../src/send';
import { fakeDiscord, GUILD, LARRY } from './fake-discord';

const TEACHER = '500000000000000001';
const STUDENT = '500000000000000002';
const STRANGER = '500000000000000003';
const ROLE = '600000000000000001';

const env = { DISCORD_TOKEN: 'token', GUILD_ID: GUILD };
const role = { key: 'JR', name: 'JR', members: [TEACHER, STUDENT], exclusive: true };
const member = (id: string, ...roles: string[]) => ({ user: { id }, roles });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkRoles', () => {
  it('refuses two entries for one role, which would undo each other', () => {
    expect(() => checkRoles({ roles: [role, { ...role, key: 'again' }] })).toThrow('Two entries ask for the role "JR"');
  });

  it('refuses a bad ID, a missing name and @everyone', () => {
    expect(() => checkRoles({ roles: [{ ...role, members: ['nope'] }] })).toThrow("isn't a Discord user ID");
    expect(() => checkRoles({ roles: [{ ...role, name: ' ' }] })).toThrow('needs a name');
    expect(() => checkRoles({ roles: [{ ...role, name: '@everyone' }] })).toThrow('@everyone');
  });

  // Removing people is destructive, so it is never a default.
  it('makes the caller say whether the role is exclusive', () => {
    const { exclusive: _, ...unsaid } = role;
    expect(() => checkRoles({ roles: [unsaid as typeof role] })).toThrow('must say whether it is exclusive');
  });
});

describe('syncRoles', () => {
  it('says so when the server is not set', async () => {
    await expect(syncRoles({ DISCORD_TOKEN: 'token' }, { roles: [] })).rejects.toThrow('GUILD_ID is missing');
  });

  it('adopts a role that already exists and changes nothing when it is right', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'JR', permissions: '0' }], members: [member(TEACHER, ROLE), member(STUDENT, ROLE)] });
    const result = await syncRoles(env, { roles: [role] });

    expect(result.roles[0]).toMatchObject({ roleId: ROLE, role: 'found', added: [], removed: [] });
    expect(writes).toEqual([]);
  });

  it('creates a missing role with no permissions, then fills it', async () => {
    const writes = fakeDiscord({ members: [member(TEACHER), member(STUDENT)] });
    const result = await syncRoles(env, { roles: [role] });

    expect(result.roles[0]).toMatchObject({ role: 'created', roleId: '600000000000000099', added: [TEACHER, STUDENT] });
    expect(writes[0]).toMatchObject({ method: 'POST', path: `/guilds/${GUILD}/roles`, body: { name: 'JR', permissions: '0' } });
  });

  it('takes an exclusive role from anyone not listed, however they got it', async () => {
    const writes = fakeDiscord({
      roles: [{ id: ROLE, name: 'JR' }],
      members: [member(TEACHER, ROLE), member(STUDENT), member(STRANGER, ROLE), member(LARRY, ROLE)],
    });
    const result = await syncRoles(env, { roles: [role] });

    // Larry never removes a role from itself.
    expect(result.roles[0]).toMatchObject({ added: [STUDENT], removed: [STRANGER] });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `PUT /guilds/${GUILD}/members/${STUDENT}/roles/${ROLE}`,
      `DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${ROLE}`,
    ]);
  });

  it('only ever adds to a role that is not exclusive', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'JR' }], members: [member(TEACHER), member(STRANGER, ROLE)] });
    const result = await syncRoles(env, { roles: [{ ...role, members: [TEACHER], exclusive: false }] });

    expect(result.roles[0]).toMatchObject({ added: [TEACHER], removed: [] });
    expect(writes.every((w) => w.method === 'PUT')).toBe(true);
  });

  it('reports someone who is not in the server and leaves them for next time', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'JR' }], members: [member(TEACHER, ROLE)] });
    const result = await syncRoles(env, { roles: [role] });

    expect(result.roles[0]).toMatchObject({ added: [], notInServer: [STUDENT] });
    expect(writes).toEqual([]);
  });

  it('changes nothing in a dry run, and says what it would do', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'SW' }], members: [member(TEACHER), member(STUDENT), member(STRANGER, ROLE)] });
    const result = await syncRoles(env, {
      roles: [role, { key: 'SW', name: 'SW', members: [], exclusive: true }],
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.roles[0]).toMatchObject({ roleId: null, role: 'would-create', added: [TEACHER, STUDENT] });
    expect(result.roles[1]).toMatchObject({ roleId: ROLE, role: 'found', removed: [STRANGER] });
    expect(writes).toEqual([]);
  });

  // Without the Server Members intent Larry cannot see who holds a role.
  it('removes nobody when it cannot list members, and still adds', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'JR' }], members: null, unknown: [STRANGER] });
    const result = await syncRoles(env, { roles: [{ ...role, members: [TEACHER, STRANGER] }] });

    expect(result.canSeeMembers).toBe(false);
    expect(result.roles[0]).toMatchObject({ added: [TEACHER], removed: [], notInServer: [STRANGER] });
    expect(writes.every((w) => w.method === 'PUT')).toBe(true);
  });

  // The guard that stops a caller making anyone a moderator.
  it('refuses a role with moderation permissions, a bot role and @everyone', async () => {
    fakeDiscord({
      roles: [
        { id: '600000000000000010', name: 'Admin', permissions: String(1n << 3n) },
        { id: '600000000000000011', name: 'Mods', permissions: String((1n << 10n) | (1n << 28n)) },
        { id: '600000000000000012', name: 'SomeBot', permissions: '0', managed: true },
        { id: '600000000000000013', name: 'Chatty', permissions: String((1n << 10n) | (1n << 11n)) },
      ],
      members: [member(TEACHER)],
    });
    const entry = (name: string) => ({ key: name, name, members: [TEACHER], exclusive: false });
    const result = await syncRoles(env, { roles: ['Admin', 'Mods', 'SomeBot', 'Chatty'].map(entry) });

    expect(result.roles[0]!.error).toMatch('moderation permissions');
    expect(result.roles[1]!.error).toMatch('moderation permissions');
    expect(result.roles[2]!.error).toMatch('bot or an integration');
    // Viewing and sending are not power: an ordinary role is fine.
    expect(result.roles[3]).toMatchObject({ added: [TEACHER] });
    expect(result.roles[3]!.error).toBeUndefined();
  });

  it('will not guess between two roles of the same name, and carries on with the rest', async () => {
    fakeDiscord({
      roles: [
        { id: ROLE, name: 'JR' },
        { id: '600000000000000002', name: 'JR' },
        { id: '600000000000000003', name: 'SW' },
      ],
    });
    const result = await syncRoles(env, { roles: [role, { key: 'SW', name: 'SW', members: [], exclusive: true }] });

    expect(result.roles[0]!.error).toMatch('2 roles are named "JR"');
    expect(result.roles[1]).toMatchObject({ key: 'SW', role: 'found' });
  });

  it('renames a role it knows by ID when asked to keep the name in step', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'JX' }], members: [member(TEACHER, ROLE), member(STUDENT, ROLE)] });
    const result = await syncRoles(env, { roles: [{ ...role, id: ROLE, rename: true }] });

    expect(result.roles[0]).toMatchObject({ roleId: ROLE, role: 'found', renamedFrom: 'JX' });
    expect(writes).toEqual([{ method: 'PATCH', path: `/guilds/${GUILD}/roles/${ROLE}`, body: { name: 'JR' } }]);
  });

  it('uses the ID it is given over a name that has since changed', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'Renamed' }], members: [member(TEACHER, ROLE), member(STUDENT, ROLE)] });
    const result = await syncRoles(env, { roles: [{ ...role, id: ROLE }] });

    expect(result.roles[0]).toMatchObject({ roleId: ROLE, role: 'found' });
    expect(writes).toEqual([]);
  });
});

describe('deleteRoles', () => {
  it('deletes a role, and counts one that is already gone as done', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'JR', permissions: '0' }] });
    const result = await deleteRoles(env, { ids: [ROLE, '600000000000000077'] });

    expect(result.deleted).toEqual([
      { id: ROLE, outcome: 'deleted' },
      { id: '600000000000000077', outcome: 'gone' },
    ]);
    expect(writes).toEqual([{ method: 'DELETE', path: `/guilds/${GUILD}/roles/${ROLE}`, body: undefined }]);
  });

  it('deletes nothing in a dry run', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'JR' }] });
    const result = await deleteRoles(env, { ids: [ROLE], dryRun: true });

    expect(result.deleted).toEqual([{ id: ROLE, outcome: 'would-delete' }]);
    expect(writes).toEqual([]);
  });

  // The same guard as syncing: a caller cannot delete the server's real roles.
  it('refuses a role with moderation permissions, a bot role and @everyone', async () => {
    const writes = fakeDiscord({
      roles: [
        { id: '600000000000000010', name: 'Admin', permissions: String(1n << 3n) },
        { id: '600000000000000012', name: 'SomeBot', permissions: '0', managed: true },
        { id: GUILD, name: '@everyone', permissions: '0' },
      ],
    });
    const result = await deleteRoles(env, { ids: ['600000000000000010', '600000000000000012', GUILD] });

    expect(result.deleted.map((d) => d.error)).toEqual([
      expect.stringContaining('moderation permissions'),
      expect.stringContaining('bot or an integration'),
      expect.stringContaining('@everyone'),
    ]);
    expect(writes).toEqual([]);
  });

  it('refuses anything that is not a Discord ID', async () => {
    await expect(deleteRoles(env, { ids: ['JR'] })).rejects.toThrow("isn't a Discord ID");
  });
});

describe('prepareMemberRole', () => {
  it('turns a checked request into a queue job', async () => {
    fakeDiscord({ roles: [{ id: ROLE, name: 'JR', permissions: '0' }] });
    expect(await prepareMemberRole(env, { userId: STUDENT, roleId: ROLE, has: true })).toEqual({
      memberRole: { guildId: GUILD, userId: STUDENT, roleId: ROLE, has: true },
    });
  });

  // Checked before anything is queued, so a queued job is always one Larry may do.
  it('refuses a role with moderation permissions, one that does not exist, and a bad request', async () => {
    fakeDiscord({ roles: [{ id: ROLE, name: 'Admin', permissions: String(1n << 3n) }] });
    await expect(prepareMemberRole(env, { userId: STUDENT, roleId: ROLE, has: true })).rejects.toThrow('moderation permissions');
    await expect(prepareMemberRole(env, { userId: STUDENT, roleId: '600000000000000077', has: true })).rejects.toThrow('There is no role');
    await expect(prepareMemberRole(env, { userId: 'jo', roleId: ROLE, has: true })).rejects.toThrow("isn't a Discord user ID");
    await expect(prepareMemberRole(env, { userId: STUDENT, roleId: ROLE } as never)).rejects.toThrow('has must be true or false');
  });
});

describe('setMemberRole', () => {
  it('gives the role now, or takes it away', async () => {
    const writes = fakeDiscord({ roles: [{ id: ROLE, name: 'JR' }] });
    await setMemberRole(env, { userId: STUDENT, roleId: ROLE, has: true });
    await setMemberRole(env, { userId: STUDENT, roleId: ROLE, has: false });

    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `PUT /guilds/${GUILD}/members/${STUDENT}/roles/${ROLE}`,
      `DELETE /guilds/${GUILD}/members/${STUDENT}/roles/${ROLE}`,
    ]);
  });

  it('says so when the person is not in the server', async () => {
    fakeDiscord({ roles: [{ id: ROLE, name: 'JR' }], unknown: [STRANGER] });
    await expect(setMemberRole(env, { userId: STRANGER, roleId: ROLE, has: true })).rejects.toThrow("isn't in the server");
  });
});

describe('consume, for a queued role change', () => {
  const job = (userId: string): QueueJob => ({ memberRole: { guildId: GUILD, userId, roleId: ROLE, has: true } });
  const queued = (body: QueueJob, attempts = 1) => ({ id: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789', body, attempts, ack: vi.fn(), retry: vi.fn() });
  const batch = (...messages: ReturnType<typeof queued>[]) => ({ messages }) as unknown as MessageBatch<QueueJob>;

  it('makes the change, then acks', async () => {
    const writes = fakeDiscord({});
    const message = queued(job(STUDENT));
    await consume(batch(message), { DISCORD_TOKEN: 'token' });

    expect(writes).toEqual([{ method: 'PUT', path: `/guilds/${GUILD}/members/${STUDENT}/roles/${ROLE}`, body: undefined }]);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('drops a change for someone not in the server without failing the run', async () => {
    fakeDiscord({ unknown: [STRANGER] });
    const message = queued(job(STRANGER));
    await consume(batch(message), { DISCORD_TOKEN: 'token' });

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  // The role sits above Larry's, or Manage Roles is gone: someone has to fix Larry.
  it('fails the run when Larry is not allowed to, after handling the rest of the batch', async () => {
    fakeDiscord({ forbidden: [STRANGER] });
    const refused = queued(job(STRANGER));
    const fine = queued(job(STUDENT));

    await expect(consume(batch(refused, fine), { DISCORD_TOKEN: 'token' })).rejects.toThrow('Missing Permissions');
    expect(refused.ack).toHaveBeenCalledOnce();
    expect(fine.ack).toHaveBeenCalledOnce();
  });

  it('retries when Discord is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('oops', { status: 502 })));
    const message = queued(job(STUDENT), 2);
    await consume(batch(message), { DISCORD_TOKEN: 'token' });

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 20 });
    expect(message.ack).not.toHaveBeenCalled();
  });
});
