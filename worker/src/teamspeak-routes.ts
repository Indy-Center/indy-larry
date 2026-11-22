import { receiveAccounts } from './platforms/teamspeak';
import { receiveConnect } from './platforms/teamspeak-links';
import { startRoleSync, type RoleSyncEnv } from './role-sync';
import { jobsStore, MAX_PULL, type TeamSpeakJobsEnv } from './teamspeak-jobs';
import { noteResult } from './teamspeak-quiet';
import type { TsResult } from './teamspeak-shape';

/**
 * teamspeak-bot's three routes, behind TEAMSPEAK_BOT_SECRET (bot-events.ts checks it). The bot pulls
 * its jobs from the jobs store (teamspeak-jobs.ts), acks them, and posts its results, which go on
 * `teamspeak-results` for the consumer below. `accounts` (the answer to the cron's `report-accounts`)
 * goes on to the role sync's TeamSpeak adapter (platforms/teamspeak.ts).
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

/**
 * The `teamspeak-results` consumer: logs each result, hands `accounts` to the role sync's TeamSpeak
 * adapter, which queues its jobs, `client-connected` to the TeamSpeak links (platforms/teamspeak-links.ts),
 * and `reconnected` to a full sync, as the cron runs. Every result keeps its time for the quiet alert
 * (teamspeak-quiet.ts). A result that throws there is retried on its own.
 */
export async function consumeTsResults(batch: MessageBatch<TsResult>, env: RoleSyncEnv): Promise<void> {
  for (const message of batch.messages) {
    const { body } = message;
    try {
      // Any result shows the bot is up: keep its time, and clear a standing quiet alert.
      await noteResult(env);
      if (body?.type === 'reconnected') {
        console.log(describeResult(body));
        await startRoleSync(env);
      } else if (body?.type === 'accounts') await receiveAccounts(env, body);
      else if (body?.type === 'client-connected') await receiveConnect(env, body);
      else (body?.type === 'failed' ? console.warn : console.log)(describeResult(body));
      message.ack();
    } catch (error) {
      console.error(`TeamSpeak result failed, retrying: ${String(error)}`);
      message.retry({ delaySeconds: 10 * message.attempts });
    }
  }
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
    case 'accounts':
      return `teamspeak-bot reported ${result.holders.length} accounts`;
    case 'client-connected':
      return `TeamSpeak ${result.uid} connected`;
    default:
      return `teamspeak-bot sent an unknown result: ${JSON.stringify(result)}`;
  }
}

function isResult(value: unknown): value is TsResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const { type, jobId, error, at, holders, connected, uid, clientId, nickname } = value as Record<string, unknown>;
  const isUid = (uid: unknown) => typeof uid === 'string' && uid !== '';
  const isHolder = (holder: unknown) =>
    !!holder && typeof holder === 'object' && isUid((holder as { uid?: unknown }).uid) && isGroups((holder as { groups?: unknown }).groups);
  switch (type) {
    case 'accounts':
      return Array.isArray(holders) && holders.every(isHolder) && Array.isArray(connected) && connected.every(isUid);
    case 'client-connected':
      return isUid(uid) && Number.isInteger(clientId) && (clientId as number) >= 0 && typeof nickname === 'string';
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

function isGroups(groups: unknown): boolean {
  return Array.isArray(groups) && groups.every((id) => Number.isInteger(id) && id > 0);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(await request.text());
  } catch {
    return null;
  }
}
