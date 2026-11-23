import { hasBearer } from './auth';
import { SNOWFLAKE } from './discord';
import { readJson, status } from './http';
import type { RoleSyncEnv, RoleSyncMessage } from './role-sync';
import { ackJobs, postResults, pullJobs, type TeamSpeakEnv } from './teamspeak-routes';
import { seedLinks, type TeamSpeakSeedEnv } from './teamspeak-seed';

/**
 * The Worker's HTTP side, on its workers.dev address (wrangler.jsonc): the bots on the VPS, each with its
 * own secret (auth.ts). larry's bot sends Discord gateway events to `POST /bot/events`; a new gateway event
 * becomes a new type there, not a new route. teamspeak-bot has three routes of its own (teamspeak-routes.ts).
 */

export type BotEventsEnv = RoleSyncEnv &
  TeamSpeakSeedEnv &
  TeamSpeakEnv & {
    /** larry's bot's shared secret, from the ENV_BOT_EVENTS_SECRET setting. Unset refuses every call. */
    BOT_EVENTS_SECRET?: string;
  };

/** A route: the one secret it takes, and what it does once that secret is checked. */
type Route = { secret: (env: BotEventsEnv) => string | undefined; handle: (request: Request, env: BotEventsEnv) => Promise<Response> };

/** Every route, all `POST`. A route takes only its own bot's secret; anything else gets 404. */
const ROUTES: Record<string, Route> = {
  '/bot/events': { secret: (env) => env.BOT_EVENTS_SECRET, handle: botEvent },
  '/teamspeak/jobs/pull': { secret: (env) => env.TEAMSPEAK_BOT_SECRET, handle: pullJobs },
  '/teamspeak/jobs/ack': { secret: (env) => env.TEAMSPEAK_BOT_SECRET, handle: ackJobs },
  '/teamspeak/results': { secret: (env) => env.TEAMSPEAK_BOT_SECRET, handle: postResults },
  // The cutover's seed script, with a secret of its own, set for the cutover and removed after (teamspeak-seed.ts).
  '/teamspeak/seed': { secret: (env) => env.TEAMSPEAK_SEED_SECRET, handle: seedLinks },
};

/** What larry's bot may send: a member joined the server, so sync them now. */
type BotEvent = { type: 'sync-member'; discordId: string };

export async function handleFetch(request: Request, env: BotEventsEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  if (request.method !== 'POST' || !route) return status(404);
  if (!(await hasBearer(request, route.secret(env)))) return status(401);
  return route.handle(request, env);
}

/** `POST /bot/events`: queues a known event's job on `role-sync` → `202`. */
async function botEvent(request: Request, env: BotEventsEnv): Promise<Response> {
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
