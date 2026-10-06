import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { channelName, checkRooms, prepareRoomSend, syncRooms } from '../src/rooms';

const GUILD = '100000000000000000';
const CATEGORY = '200000000000000000';
const ADMIN = '300000000000000000';
const LARRY = '400000000000000000';
const TEACHER = '500000000000000001';
const STUDENT = '500000000000000002';
const STRANGER = '500000000000000003';
const ROLE = '600000000000000001';
const CHANNEL = '700000000000000001';

const env = { DISCORD_TOKEN: 'token', GUILD_ID: GUILD, ROOM_CATEGORY_ID: CATEGORY, ROOM_ADMIN_ROLE_ID: ADMIN };

type Server = {
  roles: { id: string; name: string }[];
  channels: { id: string; name: string; type: number; parent_id?: string | null; guild_id?: string }[];
  /** Null stands for the Server Members intent being off. */
  members: { user: { id: string }; roles: string[] }[] | null;
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A stand-in for Discord: answers the reads from `server` and records every write. */
function fakeDiscord(server: Server) {
  const writes: { method: string; path: string; body?: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace('https://discord.com/api/v10', '');
      const method = init.method ?? 'GET';
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;

      if (method === 'GET') {
        if (path === `/guilds/${GUILD}/roles`) return json(server.roles);
        if (path === `/guilds/${GUILD}/channels`) return json(server.channels);
        if (path === '/users/@me') return json({ id: LARRY });
        if (path.startsWith(`/guilds/${GUILD}/members?`)) {
          return server.members ? json(server.members) : json({ message: 'Missing Access', code: 50001 }, 403);
        }
        const channel = server.channels.find((c) => path === `/channels/${c.id}`);
        return channel ? json(channel) : json({ message: 'Unknown Channel', code: 10003 }, 404);
      }

      writes.push({ method, path, body });
      if (method === 'POST' && path === `/guilds/${GUILD}/roles`) return json({ id: '600000000000000099', name: body!.name });
      if (method === 'POST' && path === `/guilds/${GUILD}/channels`) return json({ id: '700000000000000099', ...body });
      if (method === 'PUT' && path.includes(STRANGER) && server.members === null) return json({ message: 'Unknown Member', code: 10007 }, 404);
      return new Response(null, { status: 204 });
    }),
  );
  return writes;
}

const room = { key: 'JR', role: { name: 'JR' }, channel: { name: 'Jo Rivera' }, members: [TEACHER, STUDENT] };
const member = (id: string, ...roles: string[]) => ({ user: { id }, roles });

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

describe('checkRooms', () => {
  it('refuses two rooms that would fight over a role or a channel', () => {
    expect(() => checkRooms({ rooms: [room, { ...room, key: 'XX', channel: { name: 'Someone Else' } }] })).toThrow('Two rooms ask for the role "JR"');
    expect(() => checkRooms({ rooms: [room, { ...room, key: 'XX', role: { name: 'XX' }, channel: { name: 'jo  rivera' } }] })).toThrow('Two rooms ask for the channel "jo-rivera"');
  });

  it('refuses a bad ID, a missing name and @everyone', () => {
    expect(() => checkRooms({ rooms: [{ ...room, members: ['nope'] }] })).toThrow("isn't a Discord user ID");
    expect(() => checkRooms({ rooms: [{ ...room, channel: { name: '!!' } }] })).toThrow('needs a channel name');
    expect(() => checkRooms({ rooms: [{ ...room, role: { name: '@everyone' } }] })).toThrow('@everyone');
  });
});

describe('syncRooms', () => {
  it('says so when rooms are not set up', async () => {
    await expect(syncRooms({ DISCORD_TOKEN: 'token' }, { rooms: [] })).rejects.toThrow('Rooms are not set up: GUILD_ID');
  });

  it('adopts a role and a channel that already exist, and leaves the channel as it is', async () => {
    const writes = fakeDiscord({
      roles: [{ id: ROLE, name: 'JR' }],
      channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: CATEGORY }],
      members: [member(TEACHER, ROLE), member(STUDENT, ROLE)],
    });
    const result = await syncRooms(env, { rooms: [room] });

    expect(result.rooms[0]).toMatchObject({ roleId: ROLE, role: 'found', channelId: CHANNEL, channel: 'found', added: [], removed: [] });
    // Nothing created, nobody changed, and no permissions touched.
    expect(writes).toEqual([]);
  });

  it('creates what is missing: a role with no permissions, and a channel only the room can see', async () => {
    const writes = fakeDiscord({ roles: [], channels: [], members: [member(TEACHER), member(STUDENT)] });
    const result = await syncRooms(env, { rooms: [room] });

    expect(result.rooms[0]).toMatchObject({ role: 'created', channel: 'created', channelName: 'jo-rivera', added: [TEACHER, STUDENT] });
    expect(writes[0]).toMatchObject({ method: 'POST', path: `/guilds/${GUILD}/roles`, body: { name: 'JR', permissions: '0' } });

    const channel = writes[1]!.body!;
    expect(channel).toMatchObject({ name: 'jo-rivera', type: 0, parent_id: CATEGORY });
    const overwrites = channel.permission_overwrites as { id: string; type: number; allow?: string; deny?: string }[];
    expect(overwrites.map((o) => o.id)).toEqual([GUILD, '600000000000000099', ADMIN, LARRY]);
    expect(overwrites[0]!).toMatchObject({ type: 0, deny: '1024' }); // @everyone cannot view
    expect(BigInt(overwrites[1]!.allow!) & 1024n).toBe(1024n);
    expect(overwrites[3]!.type).toBe(1); // Larry is a member, not a role
  });

  it('does not adopt a channel of the same name outside the category', async () => {
    fakeDiscord({
      roles: [{ id: ROLE, name: 'JR' }],
      channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: '999999999999999999' }],
      members: [],
    });
    expect((await syncRooms(env, { rooms: [{ ...room, members: [] }] })).rooms[0]!.channel).toBe('created');
  });

  it('takes the role from anyone who should not hold it, however they got it', async () => {
    const writes = fakeDiscord({
      roles: [{ id: ROLE, name: 'JR' }],
      channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: CATEGORY }],
      members: [member(TEACHER, ROLE), member(STUDENT), member(STRANGER, ROLE)],
    });
    const result = await syncRooms(env, { rooms: [room] });

    expect(result.rooms[0]).toMatchObject({ added: [STUDENT], removed: [STRANGER] });
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      `PUT /guilds/${GUILD}/members/${STUDENT}/roles/${ROLE}`,
      `DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${ROLE}`,
    ]);
  });

  it('reports someone who is not in the server and leaves them for next time', async () => {
    const writes = fakeDiscord({
      roles: [{ id: ROLE, name: 'JR' }],
      channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: CATEGORY }],
      members: [member(TEACHER, ROLE)],
    });
    const result = await syncRooms(env, { rooms: [room] });

    expect(result.rooms[0]).toMatchObject({ added: [], notInServer: [STUDENT] });
    expect(writes).toEqual([]);
  });

  it('changes nothing in a dry run, and says what it would do', async () => {
    const writes = fakeDiscord({ roles: [], channels: [], members: [member(TEACHER), member(STUDENT)] });
    const result = await syncRooms(env, { rooms: [room], dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.rooms[0]).toMatchObject({ roleId: null, role: 'would-create', channelId: null, channel: 'would-create', added: [TEACHER, STUDENT] });
    expect(writes).toEqual([]);
  });

  // Without the Server Members intent Larry cannot see who holds a role.
  it('removes nobody when it cannot list members, and still adds', async () => {
    const writes = fakeDiscord({
      roles: [{ id: ROLE, name: 'JR' }],
      channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: CATEGORY }],
      members: null,
    });
    const result = await syncRooms(env, { rooms: [{ ...room, members: [TEACHER, STRANGER] }] });

    expect(result.canSeeMembers).toBe(false);
    expect(result.rooms[0]).toMatchObject({ added: [TEACHER], removed: [], notInServer: [STRANGER] });
    expect(writes.every((w) => w.method === 'PUT')).toBe(true);
  });

  it('will not guess between two roles of the same name, and carries on with the other rooms', async () => {
    fakeDiscord({
      roles: [
        { id: ROLE, name: 'JR' },
        { id: '600000000000000002', name: 'JR' },
        { id: '600000000000000003', name: 'SW' },
      ],
      channels: [],
      members: [],
    });
    const other = { key: 'SW', role: { name: 'SW' }, channel: { name: 'Sam Wu' }, members: [] };
    const result = await syncRooms(env, { rooms: [room, other] });

    expect(result.rooms[0]!.error).toMatch('2 roles are named "JR"');
    expect(result.rooms[1]).toMatchObject({ key: 'SW', role: 'found', channel: 'created' });
    expect(result.rooms[1]!.error).toBeUndefined();
  });

  it('uses the IDs it is given over a name that has since changed', async () => {
    const writes = fakeDiscord({
      roles: [{ id: ROLE, name: 'Renamed' }],
      channels: [{ id: CHANNEL, name: 'renamed-by-hand', type: 0, parent_id: CATEGORY }],
      members: [member(TEACHER, ROLE), member(STUDENT, ROLE)],
    });
    const result = await syncRooms(env, { rooms: [{ ...room, role: { id: ROLE, name: 'JR' }, channel: { id: CHANNEL, name: 'Jo Rivera' } }] });

    expect(result.rooms[0]).toMatchObject({ roleId: ROLE, channelId: CHANNEL, channelName: 'renamed-by-hand' });
    expect(writes).toEqual([]);
  });
});

describe('prepareRoomSend', () => {
  it('accepts a channel under the room category', async () => {
    fakeDiscord({ roles: [], channels: [{ id: CHANNEL, name: 'jo-rivera', type: 0, parent_id: CATEGORY, guild_id: GUILD }], members: [] });
    const job = await prepareRoomSend(env, { channelId: CHANNEL, content: 'hello' });
    expect(job.target).toEqual({ channelId: CHANNEL });
    expect(job.message.content).toBe('hello');
  });

  it('refuses a channel anywhere else, and one Larry cannot see', async () => {
    fakeDiscord({ roles: [], channels: [{ id: CHANNEL, name: 'general', type: 0, parent_id: '999999999999999999', guild_id: GUILD }], members: [] });
    await expect(prepareRoomSend(env, { channelId: CHANNEL, content: 'x' })).rejects.toThrow("isn't a room");
    await expect(prepareRoomSend(env, { channelId: '700000000000000002', content: 'x' })).rejects.toThrow("can't see channel");
  });

  it('checks the message before asking Discord anything', async () => {
    fakeDiscord({ roles: [], channels: [], members: [] });
    await expect(prepareRoomSend(env, { channelId: CHANNEL })).rejects.toThrow('needs content');
    expect(fetch).not.toHaveBeenCalled();
  });
});
