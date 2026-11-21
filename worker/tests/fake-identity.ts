/** A user as identity's `/api/users` sends it (its `Claims`), with made-up names. */
export type FakeUser = { sub: string; discord_id: string | null; preferred_name: string | null; given_name: string | null; family_name: string | null };

export const CLIENT_ID = 'larry';
export const CLIENT_SECRET = 'larry-secret';
export const TOKEN_LIFETIME_SECONDS = 3600;

/** An identity user; `discordId` is the account they linked, if any. */
export const idUser = (cid: number, discordId: string | null = null): FakeUser => ({
  sub: String(cid),
  discord_id: discordId,
  preferred_name: null,
  given_name: `Test${cid}`,
  family_name: 'Person',
});

/** The three settings identity access needs, for a test's env. */
export const identityEnv = (users: FakeUser[] = []) => ({
  IDENTITY: fakeIdentity(users) as unknown as Fetcher & ReturnType<typeof fakeIdentity>,
  IDENTITY_CLIENT_ID: CLIENT_ID,
  IDENTITY_CLIENT_SECRET: CLIENT_SECRET,
});

/**
 * A stand-in for the `IDENTITY` service binding, answering as identity's fetch handler does:
 * `/oauth/token` (client credentials, Basic auth), `GET /api/users?discord_id=`, `GET /api/users/{cid}`
 * and `PATCH /api/users/{cid}`, all but the first behind the bearer token it issued. `writes` records the
 * PATCH bodies; a PATCH giving one user another's Discord ID answers 409, like identity's unique column.
 * `down` makes every call answer 503.
 */
export function fakeIdentity(users: FakeUser[] = []) {
  const identity = {
    users,
    writes: [] as { cid: string; body: Record<string, unknown> }[],
    tokenRequests: [] as { authorization: string | null; body: string }[],
    apiCalls: [] as string[],
    down: false,
    fetch: async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const headers = new Headers(init.headers);
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (identity.down) return new Response('Service Unavailable', { status: 503 });

      if (url.pathname === '/oauth/token') {
        identity.tokenRequests.push({ authorization: headers.get('Authorization'), body: String(init.body) });
        const ok = headers.get('Authorization') === `Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`;
        return ok
          ? json({ access_token: `token-${identity.tokenRequests.length}`, token_type: 'Bearer', expires_in: TOKEN_LIFETIME_SECONDS, scope: 'users:read users:write' })
          : json({ error: 'invalid_client' }, 401);
      }

      if (!/^Bearer token-\d+$/.test(headers.get('Authorization') ?? '')) return json({ error: 'unauthenticated' }, 401);
      identity.apiCalls.push(`${init.method ?? 'GET'} ${url.pathname}${url.search}`);

      if (url.pathname === '/api/users') {
        const discordId = url.searchParams.get('discord_id');
        return json(identity.users.filter((user) => user.discord_id === discordId));
      }
      const cid = url.pathname.match(/^\/api\/users\/(\d+)$/)?.[1];
      const user = identity.users.find((candidate) => candidate.sub === cid);
      if (!cid || !user) return json({ error: 'not_found' }, 404);
      if (init.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as { discord_id: string | null };
        if (body.discord_id && identity.users.some((other) => other !== user && other.discord_id === body.discord_id)) return json({ error: 'conflict' }, 409);
        identity.writes.push({ cid, body });
        user.discord_id = body.discord_id;
      }
      return json(user);
    },
  };
  return identity;
}
