import { findByTeamspeakUid, getUser, IdentityConflict, writeTeamspeakUid } from '../identity';
import type { RoleSyncEnv } from '../role-sync';
import { jobsStore } from '../teamspeak-jobs';
import type { TsResult } from '../teamspeak-shape';
import { checkMode } from './platform';
import { removeManagedGroups, teamspeakPlatform } from './teamspeak';

/**
 * TeamSpeak links. A member links a TeamSpeak identity only by opening the link teamspeak-bot sends it
 * privately when it connects unlinked: no route or RPC lists connected clients or sends a link on request.
 *
 * On `client-connected` for a UID no member holds, larry makes a one-time token, keeps `token → uid` and
 * `uid → sent-at` in KV for 15 minutes, and queues a `send-text` job with the link. While that link is
 * unused and under 15 minutes old, a reconnect sends nothing. confirmTsLink() links the token's UID to the
 * CID that opens it, once. The link is written to identity's `teamspeak_uid` (identity.ts).
 */

const LINK_SECONDS = 15 * 60;
const tokenKey = (token: string) => `teamspeak-link:token:${token}`;
const sentKey = (uid: string) => `teamspeak-link:sent:${uid}`;
// 32 random bytes in URL-safe base64, unpadded.
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const EXPIRED = "This link has expired or was already used. Reconnect to TeamSpeak and we'll send you a new one.";
const TAKEN = 'That TeamSpeak identity is linked to another member.';
const SIGN_IN = 'Sign in to flyindycenter.com once before linking.';

const linkText = (token: string) => `Link this TeamSpeak identity to your Indy Center account: https://flyindycenter.com/profile?ts=${token} (works once, for 15 minutes)`;

/**
 * The `teamspeak-results` consumer's `client-connected`: a UID a member holds, or one no member holds,
 * which is sent its link. Throws (so the result is retried) when identity can't be reached.
 */
export async function receiveConnect(env: RoleSyncEnv, result: Extract<TsResult, { type: 'client-connected' }>): Promise<void> {
  const mode = checkMode(env);
  const holder = await findByTeamspeakUid(env, result.uid);
  if (holder) {
    // A UID a member holds: the member's sync on connect belongs here. For now it is only logged.
    console.log(`TeamSpeak ${result.uid} connected: linked to CID ${holder.cid}`);
    return;
  }

  if (await env.KV.get(sentKey(result.uid))) {
    console.log(`TeamSpeak ${result.uid} connected unlinked: the link sent in the last 15 minutes is still unused, so none is sent`);
    return;
  }
  // A message to the client is a TeamSpeak write, so `dry-run` only logs it, as it does the groups.
  if (mode !== 'live') {
    console.log(`Link TeamSpeak (dry run): would send TeamSpeak ${result.uid} a link`);
    return;
  }
  const token = newToken();
  await env.KV.put(tokenKey(token), result.uid, { expirationTtl: LINK_SECONDS });
  await env.KV.put(sentKey(result.uid), new Date().toISOString(), { expirationTtl: LINK_SECONDS });
  await jobsStore(env).enqueue({ type: 'send-text', clientId: result.clientId, text: linkText(token) });
  // Never the token: whoever holds it can link the identity.
  console.log(`Link TeamSpeak (live): sent TeamSpeak ${result.uid} a link`);
}

/**
 * RPC: link the TeamSpeak identity a link message names to the CID that opened it, and queue the member's
 * sync. A different UID the member had loses its managed groups first. The link is written in both modes,
 * as Discord's is; the removal follows `ROLE_SYNC_MODE`.
 */
export async function confirmTsLink(env: RoleSyncEnv, cid: number, token: string): Promise<void> {
  const mode = checkMode(env);
  const uid = typeof token === 'string' && TOKEN.test(token) ? await env.KV.get(tokenKey(token)) : null;
  if (!uid) throw new Error(EXPIRED);
  const holder = await findByTeamspeakUid(env, uid);
  if (holder && holder.cid !== cid) throw new Error(TAKEN);
  const user = await getUser(env, cid);
  if (!user) throw new Error(SIGN_IN);

  // Used: it can't link twice, and the next connect of an identity still unlinked gets a fresh one.
  await env.KV.delete(tokenKey(token));
  await env.KV.delete(sentKey(uid));
  if (user.teamspeakUid && user.teamspeakUid !== uid) await removeManagedGroups(env, mode, user.teamspeakUid);
  try {
    if (!(await writeTeamspeakUid(env, cid, uid))) throw new Error(SIGN_IN);
  } catch (error) {
    // Someone linked it between the check and the write.
    if (error instanceof IdentityConflict) throw new Error(TAKEN);
    throw error;
  }
  await env.ROLE_SYNC_QUEUE.send(teamspeakPlatform.messageFor(cid, { uid }));
}

function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
