import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyNickname, nicknameGuard } from '../src/nicknames';
import { fakeDiscord, GUILD, LARRY } from './fake-discord';

const JO = '500000000000000001';
const OWNER = '500000000000000003';
const ADMIN = '500000000000000004';
const ADMIN_ROLE = '600000000000000001';

const env = { DISCORD_TOKEN: 'token', GUILD_ID: GUILD };
const guard = nicknameGuard(OWNER, LARRY, [{ id: ADMIN_ROLE, permissions: String(1n << 3n) }, { id: '600000000000000002', permissions: '0' }]);
const member = (discordId: string, nick: string | null = null, ...roleIds: string[]) => ({ discordId, roleIds, nick });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('applyNickname', () => {
  it('sets a nickname', async () => {
    const writes = fakeDiscord({});
    expect(await applyNickname(env, guard, member(JO, 'Old'), 'Jo R', false)).toEqual({ outcome: 'set', from: 'Old', to: 'Jo R' });
    expect(writes).toEqual([{ method: 'PATCH', path: `/guilds/${GUILD}/members/${JO}`, body: { nick: 'Jo R' } }]);
  });

  it('writes nothing when the nickname is already right', async () => {
    const writes = fakeDiscord({});
    expect(await applyNickname(env, guard, member(JO, 'Jo'), 'Jo', false)).toMatchObject({ outcome: 'unchanged' });
    expect(writes).toEqual([]);
  });

  it('changes nothing in a dry run, and says what it would do', async () => {
    const writes = fakeDiscord({});
    expect(await applyNickname(env, guard, member(JO), 'Jo', true)).toEqual({ outcome: 'would-set', from: null, to: 'Jo' });
    expect(writes).toEqual([]);
  });

  it('skips the owner, administrators and Larry itself, without touching them', async () => {
    const writes = fakeDiscord({});
    const outcomes = await Promise.all([member(OWNER), member(ADMIN, null, ADMIN_ROLE), member(LARRY)].map((m) => applyNickname(env, guard, m, 'New', false)));
    expect(outcomes.map((o) => o.outcome)).toEqual(['skipped', 'skipped', 'skipped']);
    expect(outcomes.every((o) => o.outcome === 'skipped' && o.reason)).toBe(true);
    expect(writes).toEqual([]);
  });

  // Their top role is above Larry's: the caller's job fails, so the queue retries it.
  it('throws when Discord will not let Larry rename them', async () => {
    fakeDiscord({ forbidden: [JO] });
    await expect(applyNickname(env, guard, member(JO), 'Jo', false)).rejects.toThrow('Missing Permissions');
  });
});
