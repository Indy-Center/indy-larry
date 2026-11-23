import { readJson, status } from './http';
import { receiveAccounts } from './platforms/teamspeak';
import { receiveConnect } from './platforms/teamspeak-links';
import { consumeEach, sendInBatches } from './queues';
import { startRoleSync, type RoleSyncEnv } from './role-sync';
import { jobsStore, MAX_PULL, type TeamSpeakJobsEnv } from './teamspeak-jobs';
import { noteResult } from './teamspeak-quiet';
import type { TeamSpeakResult } from './teamspeak-shape';

/**
 * teamspeak-bot's three routes, behind TEAMSPEAK_BOT_SECRET (routes.ts checks it). The bot pulls its jobs
 * from the jobs store (teamspeak-jobs.ts), acks them, and posts its results, which go on
 * `teamspeak-results` for the consumer below. Each kind of result is one entry of RESULTS: what a posted
 * one must hold, and what the consumer does with it.
 */

export type TeamSpeakEnv = TeamSpeakJobsEnv & {
  /** teamspeak-bot's shared secret, from the ENV_TEAMSPEAK_BOT_SECRET setting. Unset refuses every call. */
  TEAMSPEAK_BOT_SECRET?: string;
  TEAMSPEAK_RESULTS: Queue<TeamSpeakResult>;
};

/** `POST /teamspeak/jobs/pull`: `{ max }` (a whole number from 1; more than 10 gives 10) → `200 { jobs }`. */
export async function pullJobs(request: Request, env: TeamSpeakEnv): Promise<Response> {
  const body = await readJson(request);
  const max = (body as { max?: unknown } | null | undefined)?.max;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1) return status(400);
  const jobs = await jobsStore(env).pull(Math.min(max, MAX_PULL));
  return Response.json({ jobs });
}

/** `POST /teamspeak/jobs/ack`: `{ acks: jobId[], retries: jobId[] }` → `204`. */
export async function ackJobs(request: Request, env: TeamSpeakEnv): Promise<Response> {
  const body = (await readJson(request)) as { acks?: unknown; retries?: unknown } | null | undefined;
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
  await sendInBatches(env.TEAMSPEAK_RESULTS, results);
  return status(202);
}

/**
 * The `teamspeak-results` consumer: every result keeps its time for the quiet alert (teamspeak-quiet.ts),
 * then goes to its kind's handler. A result that throws is retried on its own.
 */
export async function consumeTeamSpeakResults(batch: MessageBatch<TeamSpeakResult>, env: RoleSyncEnv): Promise<void> {
  await consumeEach(batch, 'TeamSpeak result', async (result) => {
    // Any result shows the bot is up: keep its time, and clear a standing quiet alert.
    await noteResult(env);
    const kind = RESULTS[result?.type] as ResultKind<TeamSpeakResult> | undefined;
    if (kind) await kind.handle(env, result);
    else console.log(`teamspeak-bot sent an unknown result: ${JSON.stringify(result)}`);
  });
}

type ResultKind<Result extends TeamSpeakResult> = {
  /** Whether a posted body of this type holds what it must: anything else gets 400. */
  valid(fields: Record<string, unknown>): boolean;
  /** What the consumer does with it. */
  handle(env: RoleSyncEnv, result: Result): Promise<void>;
};

/** Every kind of result teamspeak-bot sends, by its `type`. */
const RESULTS: { [Type in TeamSpeakResult['type']]: ResultKind<Extract<TeamSpeakResult, { type: Type }>> } = {
  applied: {
    valid: ({ jobId }) => isText(jobId),
    handle: async (_env, result) => console.log(`TeamSpeak job ${result.jobId} applied`),
  },
  failed: {
    valid: ({ jobId, error }) => isText(jobId) && (error === undefined || typeof error === 'string'),
    handle: async (_env, result) => console.warn(`TeamSpeak job ${result.jobId} failed${result.error ? `: ${result.error}` : ''}`),
  },
  heartbeat: {
    valid: ({ at }) => isText(at),
    handle: async (_env, result) => console.log(`teamspeak-bot heartbeat at ${result.at}`),
  },
  reconnected: {
    valid: ({ at }) => isText(at),
    async handle(env, result) {
      console.log(`teamspeak-bot reconnected to ServerQuery at ${result.at}`);
      await startRoleSync(env);
    },
  },
  accounts: {
    valid: ({ holders, connected }) => Array.isArray(holders) && holders.every(isHolder) && Array.isArray(connected) && connected.every(isText),
    handle: receiveAccounts,
  },
  'client-connected': {
    valid: ({ uid, clientId, nickname }) => isText(uid) && Number.isInteger(clientId) && (clientId as number) >= 0 && typeof nickname === 'string',
    handle: receiveConnect,
  },
};

function isResult(value: unknown): value is TeamSpeakResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  const type = fields.type;
  return typeof type === 'string' && Object.hasOwn(RESULTS, type) && RESULTS[type as TeamSpeakResult['type']].valid(fields);
}

/** A string that isn't empty: a job ID, a UID, a time. */
const isText = (value: unknown) => typeof value === 'string' && value !== '';

function isHolder(holder: unknown): boolean {
  if (!holder || typeof holder !== 'object') return false;
  const { uid, groups } = holder as { uid?: unknown; groups?: unknown };
  return isText(uid) && Array.isArray(groups) && groups.every((id) => Number.isInteger(id) && id > 0);
}
