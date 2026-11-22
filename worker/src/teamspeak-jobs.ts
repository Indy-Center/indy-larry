import { DurableObject } from 'cloudflare:workers';
import type { TsJob, TsJobRequest } from './teamspeak-shape';

/**
 * The TeamSpeak jobs store: one Durable Object with SQLite storage, by a fixed name, holding the jobs
 * teamspeak-bot pulls over HTTPS (teamspeak-routes.ts). It keeps a queue's behaviour: the oldest jobs
 * that aren't leased go out first, each leased for 60 seconds; an ack deletes a job; a retry, or a lease
 * running out, counts one try, and a job's 5th try moves it to the dead-letter table, logged.
 * One object serialises every call, so a job can't be handed out twice at once.
 */

export const LEASE_MS = 60_000;
export const MAX_TRIES = 5;
/** The most jobs one pull hands out. */
export const MAX_PULL = 10;
/** The one instance's name. */
const STORE = 'teamspeak-jobs';

export type TeamSpeakJobsEnv = {
  TEAMSPEAK_JOBS: DurableObjectNamespace<TeamSpeakJobs>;
};

type JobRow = { job_id: string; body: string; tries: number };

export class TeamSpeakJobs extends DurableObject {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env as never);
    this.sql = ctx.storage.sql;
    // `seq` orders jobs oldest first. `leased_until` is 0 for a job waiting to be pulled, else when its lease ends (ms).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS jobs (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0,
      leased_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS dead_jobs (
      job_id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      tries INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      dead_at INTEGER NOT NULL
    )`);
  }

  /** Adds a job and returns its ID. */
  enqueue(request: TsJobRequest): string {
    const jobId = crypto.randomUUID();
    const job = { jobId, ...request } as TsJob;
    this.sql.exec('INSERT INTO jobs (job_id, body, created_at) VALUES (?, ?, ?)', jobId, JSON.stringify(job), Date.now());
    return jobId;
  }

  /**
   * Adds a job after deleting any older job of the same type that hasn't been pulled (no lease, no try),
   * so at most one of them waits. A leased or retried one is left alone. Returns the new job's ID.
   */
  enqueueReplacing(request: TsJobRequest): string {
    this.sql.exec("DELETE FROM jobs WHERE leased_until = 0 AND tries = 0 AND json_extract(body, '$.type') = ?", request.type);
    return this.enqueue(request);
  }

  /** Up to `max` (at most 10) of the oldest jobs not leased, each now leased for 60 seconds. */
  pull(max: number): TsJob[] {
    const now = Date.now();
    for (const row of this.sql.exec<JobRow>('SELECT job_id, body, tries FROM jobs WHERE leased_until > 0 AND leased_until <= ? ORDER BY seq', now).toArray()) {
      this.countTry(row, 'its lease ran out');
    }
    const limit = Math.max(0, Math.min(Math.floor(max), MAX_PULL));
    const rows = this.sql.exec<JobRow>('SELECT job_id, body, tries FROM jobs WHERE leased_until = 0 ORDER BY seq LIMIT ?', limit).toArray();
    for (const row of rows) this.sql.exec('UPDATE jobs SET leased_until = ? WHERE job_id = ?', now + LEASE_MS, row.job_id);
    return rows.map((row) => JSON.parse(row.body) as TsJob);
  }

  /** Deletes the jobs in `acks`; each in `retries` counts a try and can be pulled again. Unknown IDs are ignored. */
  ack(acks: string[], retries: string[]): void {
    for (const jobId of acks) this.sql.exec('DELETE FROM jobs WHERE job_id = ?', jobId);
    for (const jobId of retries) {
      const row = this.sql.exec<JobRow>('SELECT job_id, body, tries FROM jobs WHERE job_id = ?', jobId).toArray()[0];
      if (row) this.countTry(row, 'teamspeak-bot asked for a retry');
    }
  }

  /** One more try: the job waits to be pulled again, or after its 5th moves to the dead-letter table. */
  private countTry(row: JobRow, why: string) {
    const tries = row.tries + 1;
    if (tries < MAX_TRIES) {
      this.sql.exec('UPDATE jobs SET tries = ?, leased_until = 0 WHERE job_id = ?', tries, row.job_id);
      return;
    }
    this.sql.exec('INSERT OR REPLACE INTO dead_jobs (job_id, body, tries, created_at, dead_at) SELECT job_id, body, ?, created_at, ? FROM jobs WHERE job_id = ?', tries, Date.now(), row.job_id);
    this.sql.exec('DELETE FROM jobs WHERE job_id = ?', row.job_id);
    console.error(`TeamSpeak job ${row.job_id} moved to the dead-letter table after ${tries} tries (last: ${why}): ${row.body}`);
  }
}

/** The one jobs store every caller reaches. */
export function jobsStore(env: TeamSpeakJobsEnv) {
  return env.TEAMSPEAK_JOBS.get(env.TEAMSPEAK_JOBS.idFromName(STORE));
}

/**
 * Queues a `set-groups` job: give TeamSpeak identity `uid` the server groups in `add` and take those in
 * `remove`. Returns the job's ID. Enqueue-only: the result comes back later on `teamspeak-results`.
 */
export async function enqueueTsGroups(env: TeamSpeakJobsEnv, uid: string, add: number[], remove: number[]): Promise<string> {
  if (typeof uid !== 'string' || uid === '') throw new TypeError('uid must be a TeamSpeak unique identifier.');
  for (const groups of [add, remove]) {
    if (!Array.isArray(groups) || !groups.every((id) => Number.isInteger(id) && id > 0)) throw new TypeError('add and remove must be lists of server group IDs.');
  }
  return jobsStore(env).enqueue({ type: 'set-groups', uid, add: [...add], remove: [...remove] });
}
