import { hasBearer } from './auth';
import { botEvent, type BotEventsEnv } from './bot-events';
import { status } from './http';
import { ackJobs, postResults, pullJobs, type TeamSpeakEnv } from './teamspeak-routes';
import { seedLinks, type TeamSpeakSeedEnv } from './teamspeak-seed';

/**
 * The Worker's HTTP side, on its workers.dev address (wrangler.jsonc): every route, each with the one
 * secret it takes (auth.ts). larry's bot has `POST /bot/events` (bot-events.ts), teamspeak-bot three routes
 * of its own (teamspeak-routes.ts), and the cutover's seed script one (teamspeak-seed.ts).
 */

export type RoutesEnv = BotEventsEnv & TeamSpeakEnv & TeamSpeakSeedEnv;

/** A route: the one secret it takes, and what it does once that secret is checked. */
type Route = { secret: (env: RoutesEnv) => string | undefined; handle: (request: Request, env: RoutesEnv) => Promise<Response> };

/** Every route, all `POST`. A route takes only its own caller's secret; anything else gets 404. */
const ROUTES: Record<string, Route> = {
  '/bot/events': { secret: (env) => env.BOT_EVENTS_SECRET, handle: botEvent },
  '/teamspeak/jobs/pull': { secret: (env) => env.TEAMSPEAK_BOT_SECRET, handle: pullJobs },
  '/teamspeak/jobs/ack': { secret: (env) => env.TEAMSPEAK_BOT_SECRET, handle: ackJobs },
  '/teamspeak/results': { secret: (env) => env.TEAMSPEAK_BOT_SECRET, handle: postResults },
  // The cutover's seed script, with a secret of its own, set for the cutover and removed after (teamspeak-seed.ts).
  '/teamspeak/seed': { secret: (env) => env.TEAMSPEAK_SEED_SECRET, handle: seedLinks },
};

export async function handleFetch(request: Request, env: RoutesEnv): Promise<Response> {
  const { pathname } = new URL(request.url);
  const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
  if (request.method !== 'POST' || !route) return status(404);
  if (!(await hasBearer(request, route.secret(env)))) return status(401);
  return route.handle(request, env);
}
