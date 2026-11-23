import { SNOWFLAKE } from './discord';
import { readJson, status } from './http';
import type { RoleSyncEnv, RoleSyncMessage } from './role-sync';

/**
 * `POST /bot/events` (routes.ts), behind BOT_EVENTS_SECRET: larry's bot on the VPS sends Discord gateway
 * events here. A new gateway event becomes a new type here, not a new route.
 */

export type BotEventsEnv = RoleSyncEnv & {
  /** larry's bot's shared secret, from the ENV_BOT_EVENTS_SECRET setting. Unset refuses every call. */
  BOT_EVENTS_SECRET?: string;
};

/** What larry's bot may send: a member joined the server, so sync them now. */
type BotEvent = { type: 'sync-member'; discordId: string };

/** Queues a known event's job on `role-sync` → `202`. */
export async function botEvent(request: Request, env: BotEventsEnv): Promise<Response> {
  const event = readEvent(await readJson(request));
  if (!event) return status(400);
  const job: RoleSyncMessage = { type: 'sync-member', discordId: event.discordId };
  await env.ROLE_SYNC_QUEUE.send(job);
  return status(202);
}

/** The body as a known event, or null for anything else. */
function readEvent(body: unknown): BotEvent | null {
  if (!body || typeof body !== 'object') return null;
  const { type, discordId } = body as Record<string, unknown>;
  if (type === 'sync-member' && typeof discordId === 'string' && SNOWFLAKE.test(discordId)) return { type, discordId };
  return null;
}
