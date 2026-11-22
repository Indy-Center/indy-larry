import { afterEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import type { VatusaRecord } from '../src/vatusa';
import { batchOf, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD, type Server } from './fake-discord';
import { identityEnv, idUser, type FakeUser } from './fake-identity';
import { fakeSource, group } from './fake-source';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import * as before from './frozen/role-sync-base';
import { lists, record, role } from './vatusa-records';

/**
 * The platform seam changed no behaviour: the same recorded members, run through the role sync as it was
 * before the seam (frozen/role-sync-base.ts) and through today's, make the same Discord writes (roles,
 * nicknames, alerts), identity calls, queued jobs and log lines, in `live` and `dry-run`.
 *
 * Delete this test, and frozen/role-sync-base.ts, once TeamSpeak's adapter has shipped.
 */

const ALERTS = '300000000000000001';
const CATEGORY = '310000000000000001';
const LARRY_ROLE = '600000000000000001';
const HIGH_ROLE = '600000000000000002';
const HAND_GIVEN = '600000000000000003';
const ROLE = {
  observer: '896858108054368298',
  member: '1125403438545641564',
  atc: '477495351838900254',
  seniorStaff: '1300575634296410164',
  neighbouringWebmasters: '1544788466863317124',
};

// Made-up Discord accounts, one per case.
const LINKED = '810000000000000001';
const VATUSA_ONLY = '810000000000000002';
const PRIVATE = '810000000000000003';
const RATING_0 = '810000000000000004';
const SHARED = '810000000000000005';
const STRANGER = '810000000000000006';
const ABOVE = '810000000000000007';
const OWNER = '810000000000000008';
const BOT = '810000000000000009';
const STALE = '810000000000000010';
const STALE_LINK = '810000000000000011';
const VATSIM_ONLY = '810000000000000012';
const OFF_LIST = '810000000000000013';
const NOT_IN_SERVER = '810000000000000014';
const LONG_NAME = '810000000000000015';

const s3 = (cid: number, discordId: string | null, overrides: Partial<VatusaRecord> = {}) => record({ cid, rating: 4, rating_short: 'S3', discord_id: discordId, ...overrides });

function recordedLists() {
  return lists(
    {
      ZID: [
        s3(1100001, null),
        s3(1100002, VATUSA_ONLY),
        s3(1100003, PRIVATE, { flag_nameprivacy: true, fname: 'Private' }),
        record({ cid: 1100004, rating: 0, rating_short: 'SUS', discord_id: RATING_0 }),
        s3(1100005, SHARED),
        s3(1100006, SHARED),
        s3(1100007, ABOVE, { roles: [role(1100007, 'ZID', 'ATM')] }),
        s3(1100008, OWNER),
        s3(1100009, STALE),
        s3(1100015, LONG_NAME, { fname: 'Bartholomew', lname: 'Featherstonehaugh-Smythe' }),
        record({ cid: 1000092 }),
      ],
      ZME: [record({ cid: 1000093, facility: 'ZME' })],
      ZDC: [record({ cid: 1000094, facility: 'ZDC' })],
      ZAU: [record({ cid: 1000095, facility: 'ZAU' })],
      ZOB: [record({ cid: 1000096, facility: 'ZOB' })],
      ZTL: [record({ cid: 1000097, facility: 'ZTL' })],
      ZKC: [record({ cid: 1000098, facility: 'ZKC' })],
    },
    [record({ cid: 1000099, facility: 'ZHQ', roles: [role(1000099, 'ZHQ', 'US2')] })],
  );
}

const member = (id: string, nick: string | null, ...roles: string[]) => ({ user: { id }, roles, nick });

function recordedServer(): Server {
  return {
    roles: [
      { id: LARRY_ROLE, name: 'Larry', position: 10 },
      { id: HIGH_ROLE, name: 'High', position: 15 },
      { id: HAND_GIVEN, name: 'Hand given', position: 1 },
      // A mapped role above larry's: skipped every run, never added or removed.
      { id: ROLE.seniorStaff, name: 'Senior Staff', position: 20 },
    ],
    larryRoles: [LARRY_ROLE],
    owner: OWNER,
    missingMapped: [ROLE.neighbouringWebmasters],
    channels: [{ id: CATEGORY, name: 'Training', type: 4 }],
    members: [
      member(LINKED, null, HAND_GIVEN),
      member(VATUSA_ONLY, 'Old name', ROLE.observer),
      member(PRIVATE, null),
      member(RATING_0, null, ROLE.member),
      member(SHARED, null, ROLE.observer, ROLE.member),
      member(STRANGER, 'Who', ROLE.member, HAND_GIVEN, ROLE.seniorStaff),
      member(ABOVE, null, HIGH_ROLE, ROLE.seniorStaff),
      member(OWNER, null),
      { user: { id: BOT, bot: true }, roles: [ROLE.member], nick: null },
      member(STALE, null, ROLE.atc),
      member(VATSIM_ONLY, null),
      member(OFF_LIST, null),
      member(LONG_NAME, null),
    ],
  };
}

function recordedUsers(): FakeUser[] {
  return [
    { ...idUser(1100001, LINKED), name: 'Preferred Name' },
    idUser(1100009, STALE_LINK),
    idUser(1100010, VATSIM_ONLY),
    idUser(1100002),
  ];
}

const extras = {
  users: [{ ...s3(1100011, OFF_LIST, { facility: 'ZAU' }), visiting_facilities: [{ facility: 'ZID' }] }],
  vatsimRatings: { 1100010: 3 },
};

type Api = {
  cron(): Promise<unknown>;
  queue(batch: MessageBatch<RoleSyncMessage>): Promise<unknown>;
  syncMembers(cids: number[]): Promise<unknown>;
  linkDiscord(cid: number, discordId: string, accessToken?: string): Promise<unknown>;
  unlink(cid: number, service: 'discord' | 'teamspeak'): Promise<unknown>;
  getLinks(cid: number): Promise<unknown>;
};

function makeEnv(mode: string) {
  return {
    DISCORD_TOKEN: 'token',
    DISCORD_JOIN_BOT_TOKEN: 'join-token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: `tech-team-alerts:${ALERTS}`,
    CHANNEL_CATEGORIES: `training:${CATEGORY}`,
    ROLE_SYNC_MODE: mode,
    GROUP_SYNC_TRAINING: 'live',
    KV: fakeKv(),
    TRAINING: fakeSource([group('S3-STUDENTS', 'S3 students', [1100001, 1100002, 1100006])]),
    ...identityEnv(recordedUsers()),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<unknown>(),
  };
}

type Env = ReturnType<typeof makeEnv>;

const oldApi = (env: Env): Api => {
  const e = env as unknown as before.RoleSyncEnv;
  return {
    cron: () => before.startRoleSync(e),
    queue: (batch) => before.consumeRoleSync(batch as never, e),
    syncMembers: (cids) => before.syncMembers(e, cids),
    linkDiscord: (cid, discordId, accessToken) => before.linkDiscord(e, cid, discordId, accessToken),
    unlink: (cid, service) => before.unlink(e, cid, service),
    getLinks: (cid) => before.getLinks(e, cid),
  };
};

const newApi = (env: Env): Api => {
  const larry = new Larry({} as ExecutionContext, env as never);
  return {
    cron: () => larry.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController),
    queue: (batch) => larry.queue(batch as never),
    syncMembers: (cids) => larry.syncMembers(cids),
    linkDiscord: (cid, discordId, accessToken) => larry.linkDiscord(cid, discordId, accessToken),
    unlink: (cid, service) => larry.unlink(cid, service),
    getLinks: (cid) => larry.getLinks(cid),
  };
};

/** Run the recorded members through one version of the role sync, and write down everything it did. */
async function transcript(mode: string, api: (env: Env) => Api) {
  const env = makeEnv(mode);
  const { writes, vatusaCalls, vatsimCalls } = fakeVatusaAndDiscord(recordedLists(), recordedServer(), [], extras);
  const logs: string[] = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((line: string) => void logs.push(`${level}: ${line}`));
  const sync = api(env);
  const answers: unknown[] = [];
  const attempt = async (call: () => Promise<unknown>) => {
    try {
      answers.push(await call());
    } catch (error) {
      answers.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  // Hand the queued role-sync jobs to the consumer, and note which it acked and which it retried.
  const drain = async (extra: RoleSyncMessage[] = []) => {
    const bodies = [...env.ROLE_SYNC_QUEUE.sent.splice(0), ...extra];
    const { batch, messages } = batchOf('role-sync', bodies);
    await attempt(() => sync.queue(batch));
    answers.push(messages.map((message) => ({ body: message.body, acked: message.acked, retried: message.retried })));
  };

  await attempt(() => sync.cron());
  await drain([{ type: 'run-member', runId: 'gone', discordId: VATUSA_ONLY, roleIds: [], nick: null }]);
  // Joins: one in the server, one that has left again.
  await drain([{ type: 'sync-member', discordId: VATUSA_ONLY }, { type: 'sync-member', discordId: NOT_IN_SERVER }]);
  // A job by CID whose account another member has linked since it was queued.
  await drain([{ type: 'sync-cid', cid: 1100002, discordId: LINKED }]);
  await attempt(() => sync.syncMembers([1100001, 1100002, 1100005, 1100009, 1100010, 1100015, 1100099]));
  await attempt(() => sync.syncMembers([1100001]));
  await drain();
  for (const cid of [1100001, 1100002, 1100005, 1100009, 1100099]) await attempt(() => sync.getLinks(cid));
  await attempt(() => sync.linkDiscord(1100002, VATUSA_ONLY, 'member-access-token'));
  await attempt(() => sync.linkDiscord(1100009, LINKED));
  await attempt(() => sync.unlink(1100001, 'discord'));
  await attempt(() => sync.unlink(1100001, 'teamspeak'));
  await drain();
  // A second run, once the links have changed.
  await attempt(() => sync.cron());
  await drain();

  vi.restoreAllMocks();
  return {
    writes,
    // TeamSpeak's adapter (registered since) logs that its part of each run is skipped: this env has no
    // TeamSpeak jobs store. That line is TeamSpeak's, not Discord's, so it is left out of the comparison.
    logs: logs.filter((line) => !line.startsWith("warn: Role sync: TeamSpeak's part of run ")),
    answers,
    vatusaCalls,
    vatsimCalls,
    identity: { writes: env.IDENTITY.writes, calls: env.IDENTITY.apiCalls },
    alertsQueued: env.LARRY_QUEUE.sent,
    // Times differ between the two runs; what was kept doesn't.
    kv: Object.fromEntries([...env.KV.store].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value.replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, '<time>')])),
  };
}

describe('the role sync before and after the platform seam', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const mode of ['live', 'dry-run']) {
    it(`makes the same changes, nicknames, alerts and log lines (${mode})`, async () => {
      const run = async (api: (env: Env) => Api) => {
        const uuid = vi.spyOn(crypto, 'randomUUID');
        let n = 0;
        uuid.mockImplementation(() => `00000000-0000-4000-8000-00000000000${n++}` as `${string}-${string}-${string}-${string}-${string}`);
        const result = await transcript(mode, api);
        vi.unstubAllGlobals();
        return result;
      };
      const was = await run(oldApi);
      const now = await run(newApi);

      // The recording covers what it says it does.
      const writes = was.writes.map((write) => `${write.method} ${write.path}`);
      if (mode === 'live') {
        expect(writes).toContain(`PUT /guilds/${GUILD}/members/${VATUSA_ONLY}/roles/${ROLE.member}`);
        expect(writes).toContain(`DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${ROLE.member}`);
        expect(writes).toContain(`PATCH /guilds/${GUILD}/members/${PRIVATE}`);
        expect(writes).not.toContain(`DELETE /guilds/${GUILD}/members/${STRANGER}/roles/${ROLE.seniorStaff}`);
      }
      expect(writes).toContain(`POST /channels/${ALERTS}/messages`);
      expect(was.logs.join('\n')).toContain(`${LINKED} CID 1100001`);
      expect(was.logs.join('\n')).toContain(`${STALE} unresolved (their CID is linked to another Discord account)`);
      expect(was.logs.join('\n')).toContain(`${SHARED} unresolved (2 CIDs give this Discord ID)`);
      expect(was.logs.join('\n')).toContain(`${STRANGER} unresolved:`);
      expect(was.logs.join('\n')).toContain(`${LINKED} unresolved (this Discord account is linked to another member): no changes`);
      expect(was.logs.join('\n')).toContain(`${BOT} is a bot account: left alone`);
      expect(was.logs.join('\n')).toContain(`${ABOVE} CID 1100007`);
      expect(was.logs.join('\n')).toContain(`nickname left alone`);
      expect(was.logs.join('\n')).toContain(`${VATSIM_ONLY} CID 1100010`);
      expect(was.logs.join('\n')).toContain(`${OFF_LIST} CID 1100011`);
      // Group roles are made only in live, so only live has any to give.
      if (mode === 'live') expect(was.logs.join('\n')).toContain('training groups (live)');

      expect(now).toEqual(was);
    });
  }
});
