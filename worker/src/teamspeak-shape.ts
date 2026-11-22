/**
 * What larry and teamspeak-bot send each other, as JSON over teamspeak-bot's three routes
 * (teamspeak-routes.ts). teamspeak-bot keeps a copy of this file in teamspeak-server's `bot/`; there is
 * no shared package, so a change here is made there too. New job and result types join these unions.
 */

/** A TeamSpeak job: one change teamspeak-bot applies over ServerQuery. */
export type TsJob = {
  jobId: string;
  /** Give `uid` the server groups in `add` and take those in `remove`; any other group is left alone. */
  type: 'set-groups';
  /** The client's unique identifier (TeamSpeak's `client_unique_identifier`). */
  uid: string;
  add: number[];
  remove: number[];
};

/** A job as it is queued, before larry gives it its ID. */
export type TsJobRequest = WithoutId<TsJob>;
type WithoutId<J> = J extends unknown ? Omit<J, 'jobId'> : never;

/**
 * What teamspeak-bot reports, posted to `POST /teamspeak/results` and put on `teamspeak-results`.
 * `applied` and `failed` answer one job (a UID TeamSpeak doesn't know fails with `error: "unknown uid"`);
 * `heartbeat` comes every 5 minutes, `reconnected` after a lost ServerQuery connection is back.
 * `at` is when the bot sent it, as an ISO 8601 time.
 */
export type TsResult =
  | { type: 'applied'; jobId: string }
  | { type: 'failed'; jobId: string; error?: string }
  | { type: 'heartbeat'; at: string }
  | { type: 'reconnected'; at: string };
