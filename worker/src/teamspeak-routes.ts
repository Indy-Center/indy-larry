import { jobsStore, MAX_PULL, type TeamSpeakJobsEnv } from './teamspeak-jobs';
import type { TsResult } from './teamspeak-shape';

/**
 * teamspeak-bot's three routes, behind TEAMSPEAK_BOT_SECRET (bot-events.ts checks it). The bot pulls
 * its jobs from the jobs store (teamspeak-jobs.ts), acks them, and posts its results, which go on
 * `teamspeak-results` for the consumer below.
 */

export type TeamSpeakEnv = TeamSpeakJobsEnv & {
  /** teamspeak-bot's shared secret, from the ENV_TEAMSPEAK_BOT_SECRET setting. Unset refuses every call. */
  TEAMSPEAK_BOT_SECRET?: string;
  TEAMSPEAK_RESULTS: Queue<TsResult>;
};

const status = (code: number) => new Response(null, { status: code });

/** `POST /teamspeak/jobs/pull`: `{ max }` (a whole number from 1; more than 10 gives 10) → `200 { jobs }`. */
export async function pullJobs(request: Request, env: TeamSpeakEnv): Promise<Response> {
  const body = await readJson(request);
  const max = (body as { max?: unknown } | null)?.max;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) return status(400);
  const jobs = await jobsStore(env).pull(Math.min(max, MAX_PULL));
  return Response.json({ jobs });
}

/** `POST /teamspeak/jobs/ack`: `{ acks: jobId[], retries: jobId[] }` → `204`. */
export async function ackJobs(request: Request, env: TeamSpeakEnv): Promise<Response> {
  const body = (await readJson(request)) as { acks?: unknown; retries?: unknown } | null;
  const isIds = (value: unknown): value is string[] => Array.isArray(value) && value.every((id) => typeof id === 'string');
  if (!body || !isIds(body.acks) || !isIds(body.retries)) return status(400);
  await jobsStore(env).ack(body.acks, body.retries);
  return status(204);
}

/** `POST /teamspeak/results`: one result or a list of them, each put on `teamspeak-results` → `202`. */
export async function postResults(request: Request, env: TeamSpeakEnv): Promise<Response> {
  const body = await readJson(request);
  const results = Array.isArray(body) ? body : [body];
  if (!results.every(isResult)) return status(400);
  if (results.length > 0) await env.TEAMSPEAK_RESULTS.sendBatch(results.map((result) => ({ body: result })));
  return status(202);
}

/** The `teamspeak-results` consumer: logs each result. */
export function consumeTsResults(batch: MessageBatch<TsResult>) {
  for (const { body } of batch.messages) (body?.type === 'failed' ? console.warn : console.log)(describeResult(body));
}

function describeResult(result: TsResult): string {
  switch (result.type) {
    case 'applied':
      return `TeamSpeak job ${result.jobId} applied`;
    case 'failed':
      return `TeamSpeak job ${result.jobId} failed${result.error ? `: ${result.error}` : ''}`;
    case 'heartbeat':
      return `teamspeak-bot heartbeat at ${result.at}`;
    case 'reconnected':
      return `teamspeak-bot reconnected to ServerQuery at ${result.at}`;
    default:
      return `teamspeak-bot sent an unknown result: ${JSON.stringify(result)}`;
  }
}

function isResult(value: unknown): value is TsResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { type, jobId, error, at } = value as Record<string, unknown>;
  switch (type) {
    case 'applied':
      return typeof jobId === 'string' && jobId !== '';
    case 'failed':
      return typeof jobId === 'string' && jobId !== '' && (error === undefined || typeof error === 'string');
    case 'heartbeat':
    case 'reconnected':
      return typeof at === 'string' && at !== '';
    default:
      return false;
  }
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch {
    return null;
  }
}
