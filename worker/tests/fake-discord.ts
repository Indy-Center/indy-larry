import { vi } from 'vitest';
import { MAPPING } from '../src/mapping';

export const GUILD = '100000000000000000';
export const LARRY = '400000000000000000';

export type Server = {
  roles?: { id: string; name: string; permissions?: string; managed?: boolean; position?: number }[];
  /** Larry's own roles, when Larry isn't one of `members`. */
  larryRoles?: string[];
  channels?: { id: string; name: string; type: number; parent_id?: string | null; guild_id?: string }[];
  /** Null stands for the Server Members intent being off. */
  members?: { user: { id: string; bot?: boolean }; roles: string[]; nick?: string | null }[] | null;
  /** The server owner's user ID. */
  owner?: string;
  /** User IDs Discord answers "Unknown Member" for when a role is added. */
  unknown?: string[];
  /** IDs (of anything) Discord answers "Missing Permissions" for on a write. */
  forbidden?: string[];
  /** Mapped role IDs the server doesn't have. The guild read (`GET /guilds/<id>`) lists every other mapped role. */
  missingMapped?: string[];
};

/** The guild's roles as a run reads them: the server's own, plus each mapped role the test hasn't placed or removed, below every other role (position -1) so Larry outranks it even with no roles of its own. */
function guildRoles(server: Server) {
  const listed = server.roles ?? [];
  const mapped = MAPPING.flatMap((entry) =>
    entry.discordRoleId && !listed.some((role) => role.id === entry.discordRoleId) && !(server.missingMapped ?? []).includes(entry.discordRoleId)
      ? [{ id: entry.discordRoleId, name: entry.name, position: -1 }]
      : [],
  );
  return [...listed, ...mapped];
}

export type Write = { method: string; path: string; body?: Record<string, unknown> };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** A stand-in for Discord: answers the reads from `server` and records every write. */
export function fakeDiscord(server: Server): Write[] {
  const writes: Write[] = [];
  const created_ = { roles: 0, channels: 0 };
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
        if (path === `/guilds/${GUILD}`) return json({ id: GUILD, owner_id: server.owner ?? '999999999999999999', roles: guildRoles(server) });
        const single = path.match(new RegExp(`^/guilds/${GUILD}/members/(\\d+)$`))?.[1];
        if (single) {
          // Larry is always in its server, with `larryRoles` unless the test lists it as a member.
          const larry = single === LARRY ? { user: { id: LARRY }, roles: server.larryRoles ?? [] } : undefined;
          const found = (server.members ?? []).find((candidate) => candidate.user.id === single) ?? larry;
          return found ? json(found) : json({ message: 'Unknown Member', code: 10007 }, 404);
        }
        const channel = (server.channels ?? []).find((c) => path === `/channels/${c.id}`);
        return channel ? json(channel) : json({ message: 'Unknown Channel', code: 10003 }, 404);
      }

      writes.push({ method, path, body });
      // What Larry creates, renames or deletes stays that way for the next read. Created IDs count up from ...099.
      if (method === 'POST' && path === `/guilds/${GUILD}/roles`) {
        const created = { id: String(600000000000000099n + BigInt(created_.roles++)), name: body!.name as string, permissions: '0', position: 0 };
        (server.roles ??= []).push(created);
        return json(created);
      }
      if (method === 'POST' && path === `/guilds/${GUILD}/channels`) {
        const created = { id: String(700000000000000099n + BigInt(created_.channels++)), ...body, guild_id: GUILD } as NonNullable<Server['channels']>[number];
        (server.channels ??= []).push(created);
        return json(created);
      }
      if ((server.forbidden ?? []).some((id) => path.includes(id))) return json({ message: 'Missing Permissions', code: 50013 }, 403);
      const roleId = path.match(new RegExp(`^/guilds/${GUILD}/roles/(\\d+)$`))?.[1];
      const channelId = path.match(/^\/channels\/(\d+)$/)?.[1];
      const role = roleId ? server.roles?.find((candidate) => candidate.id === roleId) : undefined;
      const channel = channelId ? server.channels?.find((candidate) => candidate.id === channelId) : undefined;
      if (method === 'PATCH' && (role || channel) && typeof body?.name === 'string') (role ?? channel)!.name = body.name;
      const held = path.match(new RegExp(`^/guilds/${GUILD}/members/(\\d+)/roles/(\\d+)$`));
      const holder = held ? (server.members ?? []).find((candidate) => candidate.user.id === held[1]) : undefined;
      if (holder && method === 'PUT' && !holder.roles.includes(held![2]!)) holder.roles.push(held![2]!);
      if (holder && method === 'DELETE') holder.roles = holder.roles.filter((id) => id !== held![2]);
      if (method === 'DELETE' && roleId) {
        if (!role) return json({ message: 'Unknown Role', code: 10011 }, 404);
        server.roles = server.roles!.filter((candidate) => candidate !== role);
      }
      if (method === 'DELETE' && channelId) {
        if (!channel) return json({ message: 'Unknown Channel', code: 10003 }, 404);
        server.channels = server.channels!.filter((candidate) => candidate !== channel);
      }
      if (method === 'PUT' && (server.unknown ?? []).some((id) => path.includes(id))) return json({ message: 'Unknown Member', code: 10007 }, 404);
      return new Response(null, { status: 204 });
    }),
  );
  return writes;
}
