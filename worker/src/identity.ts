/**
 * Identity's users, the role sync's source for Discord and TeamSpeak links. The only file that talks to identity, so
 * a later swap to a different lookup is a change here.
 *
 * Identity is a plain fetch handler (no RPC): its `/api/users` routes take a bearer token from the
 * client-credentials grant at `/oauth/token`. larry calls them through the `IDENTITY` service binding's
 * `fetch`, which reaches the same routes with no trip over the public internet. The client needs the
 * `users:read` and `users:write` scopes. There is no "list every user" route: a user is found by CID
 * (`GET /api/users/{cid}`), by Discord ID (`GET /api/users?discord_id=`) or by TeamSpeak UID
 * (`GET /api/users?teamspeak_uid=`), each an exact match.
 */

export type IdentityEnv = {
  /** The identity Worker (`id`), as a service binding. */
  IDENTITY: Fetcher;
  /** The registered client's ID (a var) and secret (a Worker secret). */
  IDENTITY_CLIENT_ID: string;
  IDENTITY_CLIENT_SECRET: string;
};

/** The user claims the sync reads (identity's `/api/users` fields, camel-cased). */
export type IdentityUser = {
  cid: number;
  /** The Discord account they linked, or null. */
  discordId: string | null;
  /** The TeamSpeak identity (unique ID) linked to them, or null. */
  teamspeakUid: string | null;
  /** identity's `name` claim: the preferred name, else their VATSIM first and last name. */
  name: string | null;
  preferredName: string | null;
  givenName: string | null;
  familyName: string | null;
};

/** A user as `/api/users` sends it (identity's `Claims`). */
type Claims = {
  sub: string;
  discord_id: string | null;
  teamspeak_uid?: string | null;
  name: string | null;
  preferred_name: string | null;
  given_name: string | null;
  family_name: string | null;
};

// Only the path matters over a service binding; this is identity's address.
const ORIGIN = 'https://id.flyindycenter.com';
const SCOPE = 'users:read users:write';
// Ask for a new token this long before the old one expires.
const EXPIRY_MARGIN_MS = 60_000;

/** Raised for a link write identity refuses because the Discord ID or TeamSpeak UID is already someone's (409). */
export class IdentityConflict extends Error {}

const tokens = new WeakMap<Fetcher, { token: string; expiresAt: number }>();

/** A client-credentials token, kept for its lifetime within the isolate. */
async function token(env: IdentityEnv): Promise<string> {
  const kept = tokens.get(env.IDENTITY);
  if (kept &&kept.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return kept.token;

  const res = await env.IDENTITY.fetch(`${ORIGIN}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${env.IDENTITY_CLIENT_ID}:${env.IDENTITY_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE }).toString(),
  });
  if (!res.ok) throw new Error(`identity's /oauth/token answered ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in: number };
  tokens.set(env.IDENTITY, { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 });
  return body.access_token;
}

async function call(env: IdentityEnv, method: string, path: string, body?: unknown): Promise<Response> {
  const res = await env.IDENTITY.fetch(`${ORIGIN}${path}`, {
    method,
    headers: { Authorization: `Bearer ${await token(env)}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  // A token identity no longer accepts: drop it so the next call asks for a new one.
  if (res.status === 401) tokens.delete(env.IDENTITY);
  return res;
}

const userFrom = (claims: Claims): IdentityUser => ({
  cid: Number(claims.sub),
  discordId: claims.discord_id || null,
  teamspeakUid: claims.teamspeak_uid || null,
  name: claims.name ?? null,
  preferredName: claims.preferred_name ?? null,
  givenName: claims.given_name ?? null,
  familyName: claims.family_name ?? null,
});

/** The identity user with this CID, or null when they haven't signed in. */
export async function getUser(env: IdentityEnv, cid: number): Promise<IdentityUser | null> {
  const res = await call(env, 'GET', `/api/users/${cid}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`identity's GET /api/users/${cid} answered ${res.status}`);
  return userFrom((await res.json()) as Claims);
}

/** The identity user whose link is this Discord account, or null. */
export async function findByDiscordId(env: IdentityEnv, discordId: string): Promise<IdentityUser | null> {
  const res = await call(env, 'GET', `/api/users?discord_id=${encodeURIComponent(discordId)}`);
  if (!res.ok) throw new Error(`identity's GET /api/users?discord_id answered ${res.status}`);
  const found = (await res.json()) as Claims[];
  return found[0] ? userFrom(found[0]) : null;
}

/** The identity user whose link is this TeamSpeak identity (unique ID), or null. */
export async function findByTeamspeakUid(env: IdentityEnv, uid: string): Promise<IdentityUser | null> {
  const res = await call(env, 'GET', `/api/users?teamspeak_uid=${encodeURIComponent(uid)}`);
  if (!res.ok) throw new Error(`identity's GET /api/users?teamspeak_uid answered ${res.status}`);
  const found = (await res.json()) as Claims[];
  return found[0] ? userFrom(found[0]) : null;
}

/**
 * Link a Discord account to a CID, or (null) clear the link. Returns false when identity has no user
 * for the CID; throws IdentityConflict when the Discord ID is already someone else's.
 */
export function writeDiscordId(env: IdentityEnv, cid: number, discordId: string | null): Promise<boolean> {
  return writeLink(env, cid, 'discord_id', discordId);
}

/**
 * Link a TeamSpeak identity (unique ID) to a CID, or (null) clear the link. Returns false when identity has
 * no user for the CID; throws IdentityConflict when the UID is already someone else's.
 */
export function writeTeamspeakUid(env: IdentityEnv, cid: number, uid: string | null): Promise<boolean> {
  return writeLink(env, cid, 'teamspeak_uid', uid);
}

async function writeLink(env: IdentityEnv, cid: number, field: 'discord_id' | 'teamspeak_uid', value: string | null): Promise<boolean> {
  const res = await call(env, 'PATCH', `/api/users/${cid}`, { [field]: value });
  if (res.status === 404) return false;
  if (res.status === 409) throw new IdentityConflict(`${field} already in use`);
  if (!res.ok) throw new Error(`identity's PATCH /api/users/${cid} answered ${res.status}`);
  return true;
}
