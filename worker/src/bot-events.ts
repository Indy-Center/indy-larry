import { hasBearer } from './auth';
import { SNOWFLAKE } from './discord';
import type { RoleSyncEnv, RoleSyncMessage } from './role-sync';

/**
 * The Worker's HTTP side, on its workers.dev address (wrangler.jsonc). Its only caller so far is
 * larry's bot on the VPS, which sends Discord gateway events to `POST /bot/events` (decision 0004).
 * A new gateway event becomes a new type there, not a new route.
 */

export type BotEventsEnv = Pick<RoleSyncEnv, 'ROLE_SYNC_QUEUE'> & {
  /** larry's bot's shared secret, from the ENV_BOT_EVENTS_SECRET setting. Unset refuses every call. */
  BOT_EVENTS_SECRET?: string;
};

/** What larry's bot may send: a member joined the server, so sync them now. */
type BotEvent = { type: 'sync-member'; discordId: string };

const status = (code: number) => new Response(null, { status: code });

export async function handleFetch(request: Request, env: BotEventsEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (request.method !== 'POST' || pathname !== '/bot/events') return status(404);
  if (!(await hasBearer(request, env.BOT_EVENTS_SECRET))) return status(401);

  const event = readEvent(await request.text());
  if (!event) return status(400);
  const job: RoleSyncMessage = { type: 'sync-member', discordId: event.discordId };
  await env.ROLE_SYNC_QUEUE.send(job);
  return status(202);
}

/** The body as a known event, or null for anything else. */
function readEvent(text: string): BotEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const { type, discordId } = body as Record<string, unknown>;
  if (type === 'sync-member' && typeof discordId === 'string' && SNOWFLAKE.test(discordId)) return { type, discordId };
  return null;
}
