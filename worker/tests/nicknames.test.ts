import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkNicknames, setNickname, syncNicknames } from '../src/nicknames';
import { fakeDiscord, GUILD, LARRY } from './fake-discord';

const JO = '500000000000000001';
const SAM = '500000000000000002';
const OWNER = '500000000000000003';
const ADMIN = '500000000000000004';
const STRANGER = '500000000000000005';
const ADMIN_ROLE = '600000000000000001';

const env = { DISCORD_TOKEN: 'token', GUILD_ID: GUILD };
const member = (id: string, nick: string | null = null, ...roles: string[]) => ({ user: { id }, roles, nick });
const roles = [{ id: ADMIN_ROLE, name: 'Admin', permissions: String(1n << 3n) }];

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('checkNicknames', () => {
  it('refuses a bad ID, an empty or long nickname, and a person listed twice', () => {
    expect(() => checkNicknames({ nicknames: [{ userId: 'jo', nickname: 'Jo' }] })).toThrow("isn't a Discord user ID");
    expect(() => checkNicknames({ nicknames: [{ userId: JO, nickname: '  ' }] })).toThrow('1 to 32 characters');
    expect(() => checkNicknames({ nicknames: [{ userId: JO, nickname: 'x'.repeat(33) }] })).toThrow('1 to 32 characters');
    expect(() => checkNicknames({ nicknames: [{ userId: JO, nickname: 'A' }, { userId: JO, nickname: 'B' }] })).toThrow('listed twice');
  });

  it('accepts null, which removes a nickname', () => {
    expect(checkNicknames({ nicknames: [{ userId: JO, nickname: null }] })).toHaveLength(1);
  });
});

describe('syncNicknames', () => {
  it('says so when the server is not set', async () => {
    await expect(syncNicknames({ DISCORD_TOKEN: 'token' }, { nicknames: [] })).rejects.toThrow('GUILD_ID is missing');
  });

  it('sets a nickname, and removes one with null', async () => {
    const writes = fakeDiscord({ members: [member(JO), member(SAM, 'Old')] });
    const result = await syncNicknames(env, {
      nicknames: [
        { userId: JO, nickname: ' Jo R | OI ' },
        { userId: SAM, nickname: null },
      ],
    });

    expect(result.nicknames).toEqual([
      { userId: JO, outcome: 'set', from: null, to: 'Jo R | OI' },
      { userId: SAM, outcome: 'set', from: 'Old', to: null },
    ]);
    expect(writes).toEqual([
      { method: 'PATCH', path: `/guilds/${GUILD}/members/${JO}`, body: { nick: 'Jo R | OI' } },
      { method: 'PATCH', path: `/guilds/${GUILD}/members/${SAM}`, body: { nick: null } },
    ]);
  });

  it('writes nothing when the nickname is already right', async () => {
    const writes = fakeDiscord({ members: [member(JO, 'Jo'), member(SAM)] });
    const result = await syncNicknames(env, { nicknames: [{ userId: JO, nickname: 'Jo' }, { userId: SAM, nickname: null }] });

    expect(result.nicknames.map((n) => n.outcome)).toEqual(['unchanged', 'unchanged']);
    expect(writes).toEqual([]);
  });

  it('changes nothing in a dry run, and says what it would do', async () => {
    const writes = fakeDiscord({ members: [member(JO)] });
    const result = await syncNicknames(env, { nicknames: [{ userId: JO, nickname: 'Jo' }], dryRun: true });

    expect(result).toEqual({ dryRun: true, nicknames: [{ userId: JO, outcome: 'would-set', from: null, to: 'Jo' }] });
    expect(writes).toEqual([]);
  });

  it('reports someone who is not in the server', async () => {
    const writes = fakeDiscord({ members: [] });
    const result = await syncNicknames(env, { nicknames: [{ userId: STRANGER, nickname: 'Hi' }] });

    expect(result.nicknames[0]).toMatchObject({ outcome: 'not-in-server' });
    expect(writes).toEqual([]);
  });

  it('skips the owner, administrators and Larry itself, without touching them', async () => {
    const writes = fakeDiscord({ owner: OWNER, roles, members: [member(OWNER), member(ADMIN, null, ADMIN_ROLE), member(LARRY)] });
    const result = await syncNicknames(env, {
      nicknames: [OWNER, ADMIN, LARRY].map((userId) => ({ userId, nickname: 'New' })),
    });

    expect(result.nicknames.map((n) => n.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(result.nicknames.every((n) => n.reason && !n.error)).toBe(true);
    expect(writes).toEqual([]);
  });

  // Their top role is above Larry's: reported, and the others still go through.
  it('reports someone Discord will not let Larry rename, and carries on', async () => {
    const writes = fakeDiscord({ members: [member(JO), member(SAM)], forbidden: [JO] });
    const result = await syncNicknames(env, { nicknames: [{ userId: JO, nickname: 'Jo' }, { userId: SAM, nickname: 'Sam' }] });

    expect(result.nicknames[0]).toMatchObject({ userId: JO, outcome: 'failed' });
    expect(result.nicknames[0]!.error).toMatch('Missing Permissions');
    expect(result.nicknames[1]).toMatchObject({ userId: SAM, outcome: 'set' });
    expect(writes).toHaveLength(2);
  });
});

describe('setNickname', () => {
  it('sets the nickname now', async () => {
    const writes = fakeDiscord({ members: [member(JO)] });
    await setNickname(env, { userId: JO, nickname: 'Jo' });

    expect(writes).toEqual([{ method: 'PATCH', path: `/guilds/${GUILD}/members/${JO}`, body: { nick: 'Jo' } }]);
  });

  it('throws when the person is not in the server, is skipped, or Discord refuses', async () => {
    fakeDiscord({ owner: OWNER, members: [member(OWNER), member(JO)], forbidden: [JO] });
    await expect(setNickname(env, { userId: STRANGER, nickname: 'Hi' })).rejects.toThrow("isn't in the server");
    await expect(setNickname(env, { userId: OWNER, nickname: 'Hi' })).rejects.toThrow('owner');
    await expect(setNickname(env, { userId: JO, nickname: 'Hi' })).rejects.toThrow('Missing Permissions');
  });
});
