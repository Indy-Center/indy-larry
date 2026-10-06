import { vi } from 'vitest';

export const GUILD = '100000000000000000';
export const LARRY = '400000000000000000';

export type Server = {
  roles?: { id: string; name: string; permissions?: string; managed?: boolean }[];
  channels?: { id: string; name: string; type: number; parent_id?: string | null; guild_id?: string }[];
  /** Null stands for the Server Members intent being off. */
  members?: { user: { id: string }; roles: string[] }[] | null;
  /** User IDs Discord answers "Unknown Member" for when a role is added. */
  unknown?: string[];
};

export type Write = { method: string; path: string; body?: Record<string, unknown> };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A stand-in for Discord: answers the reads from `server` and records every write. */
export function fakeDiscord(server: Server): Write[] {
  const writes: Write[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace('https://discord.com/api/v10', '');
      const method = init.method ?? 'GET';
      const body = init.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : undefined;

      if (method === 'GET') {
        if (path === `/guilds/${GUILD}/roles`) return json(server.roles ?? []);
        if (path === `/guilds/${GUILD}/channels`) return json(server.channels ?? []);
        if (path === '/users/@me') return json({ id: LARRY });
        if (path.startsWith(`/guilds/${GUILD}/members?`)) {
          return server.members === null ? json({ message: 'Missing Access', code: 50001 }, 403) : json(server.members ?? []);
        }
        const channel = (server.channels ?? []).find((c) => path === `/channels/${c.id}`);
        return channel ? json(channel) : json({ message: 'Unknown Channel', code: 10003 }, 404);
      }

      writes.push({ method, path, body });
      if (method === 'POST' && path === `/guilds/${GUILD}/roles`) return json({ id: '600000000000000099', name: body!.name, permissions: '0' });
      if (method === 'POST' && path === `/guilds/${GUILD}/channels`) return json({ id: '700000000000000099', ...body });
      if (method === 'PUT' && (server.unknown ?? []).some((id) => path.includes(id))) return json({ message: 'Unknown Member', code: 10007 }, 404);
      return new Response(null, { status: 204 });
    }),
  );
  return writes;
}
