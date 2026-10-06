import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelName, checkChannels, prepareChannelIdSend, syncChannels } from '../src/managed-channels';
import { fakeDiscord, GUILD, LARRY } from './fake-discord';

const CATEGORY = '200000000000000000';
const ELSEWHERE = '299999999999999999';
const ROLE = '600000000000000001';
const ADMIN = '300000000000000000';
const CHANNEL = '700000000000000001';

const env = { DISCORD_TOKEN: 'token', GUILD_ID: GUILD, CHANNEL_CATEGORIES: `training:${CATEGORY}` };
const wanted = { key: 'JR', category: 'training', name: 'Jo Rivera', visibleTo: [ROLE, ADMIN] };

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('channelName', () => {
  it('writes a name the way Discord stores it', () => {
    expect(channelName('Jo Rivera')).toBe('jo-rivera');
    expect(channelName("  Seán O'Brien-Smith ")).toBe('sean-o-brien-smith');
    expect(channelName('Jo 1234567')).toBe('jo-1234567');
  });
});

describe('checkChannels', () => {
  it('refuses a category that is not in the setting, and lists the ones that are', () => {
    expect(() => checkChannels(env, { channels: [{ ...wanted, category: 'staff' }] })).toThrow('Unknown category "staff". Known categories: training');
    expect(() => checkChannels({}, { channels: [wanted] })).toThrow('Known categories: none');
  });

  it('refuses two entries for one channel, a bad ID, and a channel nobody could see', () => {
    expect(() => checkChannels(env, { channels: [wanted, { ...wanted, key: 'again', name: 'jo  rivera' }] })).toThrow('Two entries ask for the channel "jo-rivera"');
    expect(() => checkChannels(env, { channels: [{ ...wanted, visibleTo: ['nope'] }] })).toThrow("isn't a Discord role ID");
    expect(() => checkChannels(env, { channels: [{ ...wanted, visibleTo: [] }] })).toThrow('visible to at least one role');
    expect(() => checkChannels(env, { channels: [{ ...wanted, name: '!!' }] })).toThrow('needs a name');
  });
});

describe('syncChannels', () => {
  it('adopts a channel that already exists and leaves it exactly as it is', async () => {
    const writes = fakeDiscord({ channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: CATEGORY }] });
    const result = await syncChannels(env, { channels: [wanted] });

    expect(result.channels[0]).toMatchObject({ channelId: CHANNEL, channel: 'found', channelName: 'jo-rivera' });
    // Nothing created, and no permissions touched.
    expect(writes).toEqual([]);
  });

  it('creates a missing channel that only the given roles and Larry can see', async () => {
    const writes = fakeDiscord({});
    const result = await syncChannels(env, { channels: [wanted] });

    expect(result.channels[0]).toMatchObject({ channel: 'created', channelId: '700000000000000099', channelName: 'jo-rivera' });
    const body = writes[0]!.body!;
    expect(body).toMatchObject({ name: 'jo-rivera', type: 0, parent_id: CATEGORY });
    const overwrites = body.permission_overwrites as { id: string; type: number; allow?: string; deny?: string }[];
    expect(overwrites.map((o) => o.id)).toEqual([GUILD, ROLE, ADMIN, LARRY]);
    expect(overwrites[0]).toMatchObject({ type: 0, deny: '1024' }); // @everyone cannot view
    expect(BigInt(overwrites[1]!.allow!) & 1024n).toBe(1024n);
    expect(overwrites[3]!.type).toBe(1); // Larry is a member, not a role
  });

  it('does not adopt a channel of the same name in another category', async () => {
    fakeDiscord({ channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: ELSEWHERE }] });
    expect((await syncChannels(env, { channels: [wanted] })).channels[0]!.channel).toBe('created');
  });

  it('changes nothing in a dry run', async () => {
    const writes = fakeDiscord({});
    const result = await syncChannels(env, { channels: [wanted], dryRun: true });

    expect(result.channels[0]).toMatchObject({ channelId: null, channel: 'would-create' });
    expect(writes).toEqual([]);
  });

  it('renames a channel it knows by ID when asked to, and touches nothing else', async () => {
    const writes = fakeDiscord({ channels: [{ id: CHANNEL, name: 'joanna-rivera', type: 0, parent_id: CATEGORY }] });
    const result = await syncChannels(env, { channels: [{ ...wanted, id: CHANNEL, rename: true }] });

    expect(result.channels[0]).toMatchObject({ channelId: CHANNEL, channel: 'found', channelName: 'jo-rivera', renamedFrom: 'joanna-rivera' });
    expect(writes).toEqual([{ method: 'PATCH', path: `/channels/${CHANNEL}`, body: { name: 'jo-rivera' } }]);
  });

  it('only reports the rename in a dry run', async () => {
    const writes = fakeDiscord({ channels: [{ id: CHANNEL, name: 'joanna-rivera', type: 0, parent_id: CATEGORY }] });
    const result = await syncChannels(env, { channels: [{ ...wanted, id: CHANNEL, rename: true }], dryRun: true });

    expect(result.channels[0]!.renamedFrom).toBe('joanna-rivera');
    expect(writes).toEqual([]);
  });

  it('uses the ID it is given over a name that has since changed', async () => {
    const writes = fakeDiscord({ channels: [{ id: CHANNEL, name: 'renamed-by-hand', type: 0, parent_id: CATEGORY }] });
    const result = await syncChannels(env, { channels: [{ ...wanted, id: CHANNEL }] });

    expect(result.channels[0]).toMatchObject({ channelId: CHANNEL, channelName: 'renamed-by-hand', channel: 'found' });
    expect(writes).toEqual([]);
  });

  it('will not guess between two channels of the same name, and carries on with the rest', async () => {
    fakeDiscord({
      channels: [
        { id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: CATEGORY },
        { id: '700000000000000002', name: 'jo-rivera', type: 0, parent_id: CATEGORY },
      ],
    });
    const result = await syncChannels(env, { channels: [wanted, { ...wanted, key: 'SW', name: 'Sam Wu' }] });

    expect(result.channels[0]!.error).toMatch('2 channels are named "jo-rivera"');
    expect(result.channels[1]).toMatchObject({ key: 'SW', channel: 'created' });
  });
});

describe('prepareChannelIdSend', () => {
  it('accepts a channel under a category Larry looks after', async () => {
    fakeDiscord({ channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: CATEGORY, guild_id: GUILD }] });
    const job = await prepareChannelIdSend(env, { channelId: CHANNEL, content: 'hello' });
    expect(job.target).toEqual({ channelId: CHANNEL });
    expect(job.message.content).toBe('hello');
  });

  it('refuses a channel anywhere else, and one Larry cannot see', async () => {
    fakeDiscord({ channels: [{ id: CHANNEL, name: 'general', type: 0, parent_id: ELSEWHERE, guild_id: GUILD }] });
    await expect(prepareChannelIdSend(env, { channelId: CHANNEL, content: 'x' })).rejects.toThrow("isn't one Larry looks after");
    await expect(prepareChannelIdSend(env, { channelId: '700000000000000002', content: 'x' })).rejects.toThrow("can't see channel");
  });

  it('checks the message before asking Discord anything', async () => {
    fakeDiscord({});
    await expect(prepareChannelIdSend(env, { channelId: CHANNEL })).rejects.toThrow('needs content');
    expect(fetch).not.toHaveBeenCalled();
  });
});
