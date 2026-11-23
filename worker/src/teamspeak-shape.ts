/**
 * What larry and teamspeak-bot send each other, as JSON over teamspeak-bot's three routes
 * (teamspeak-routes.ts). teamspeak-bot keeps a copy of this file in teamspeak-server's `bot/`; there is
 * no shared package, so a change here is made there too. New job and result types join these unions.
 */

/** A TeamSpeak job: one change teamspeak-bot applies over ServerQuery, or one report it makes. */
export type TeamSpeakJob =
  | {
      jobId: string;
      /** Give `uid` the server groups in `add` and take those in `remove`; any other group is left alone. */
      type: 'set-groups';
      /** The client's unique identifier (TeamSpeak's `client_unique_identifier`). */
      uid: string;
      add: number[];
      remove: number[];
    }
  | {
      jobId: string;
      /**
       * Answer with one `accounts` result: every identity in the client database holding at least one of
       * `groups` (the groups the mapping names), with all its server groups, and the UIDs connected now.
       */
      type: 'report-accounts';
      groups: number[];
    }
  | {
      jobId: string;
      /** Send `text` to one connected client as a private text message. */
      type: 'send-text';
      /** The client's ID on the server now (TeamSpeak's `clid`), from its `client-connected` result. */
      clientId: number;
      text: string;
    };

/** A job as it is queued, before larry gives it its ID. */
export type TeamSpeakJobRequest = WithoutId<TeamSpeakJob>;
type WithoutId<J> = J extends unknown ? Omit<J, 'jobId'> : never;

/**
 * What teamspeak-bot reports, posted to `POST /teamspeak/results` and put on `teamspeak-results`.
 * `applied` and `failed` answer one job (a UID TeamSpeak doesn't know fails with `error: "unknown uid"`);
 * `heartbeat` comes every 5 minutes, `reconnected` after a lost ServerQuery connection is back.
 * `at` is when the bot sent it, as an ISO 8601 time. `accounts` answers `report-accounts`: `holders` are the
 * identities holding a group the job named, each with all its server groups; `connected` the UIDs connected
 * now, query clients excluded. `client-connected` is sent for each client that enters the server (query
 * clients excluded): its UID, its client ID for this connection (`clid`) and its nickname.
 */
export type TeamSpeakResult =
  | { type: 'applied'; jobId: string }
  | { type: 'failed'; jobId: string; error?: string }
  | { type: 'heartbeat'; at: string }
  | { type: 'reconnected'; at: string }
  | { type: 'accounts'; holders: { uid: string; groups: number[] }[]; connected: string[] }
  | { type: 'client-connected'; uid: string; clientId: number; nickname: string };
