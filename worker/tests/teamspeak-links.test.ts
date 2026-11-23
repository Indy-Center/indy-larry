import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { TeamSpeakJobs } from '../src/teamspeak-jobs';
import type { TeamSpeakJob, TeamSpeakResult } from '../src/teamspeak-shape';
import { batchOf, fakeDurableObjects, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD } from './fake-discord';
import { identityEnv, idUser, type FakeUser } from './fake-identity';
import { fakeSource } from './fake-source';

/**
 * TeamSpeak links: an unlinked identity that connects gets a one-time link in a private message, and
 * confirmTsLink() links it for whoever opens it. Driven through the results consumer, the jobs store and
 * the RPCs. Made-up CIDs and UIDs throughout.
 */

const JO_UID = 'joMadeUpUid00000000000000000=';
const JO_OLD_UID = 'joOldMadeUpUid000000000000000=';
const JO_DISCORD = '830000000000000001';
const MANAGED = [17, 16, 15, 14, 13, 12, 11, 20, 21, 19, 18, 24, 25, 23, 26, 10, 7];
const MINUTE = 60_000;
const START = new Date('2026-11-22T12:00:00Z');

const EXPIRED = "This link has expired or was already used. Reconnect to TeamSpeak and we'll send you a new one.";
const TAKEN = 'That TeamSpeak identity is linked to another member.';
const SIGN_IN = 'Sign in to flyindycenter.com once before linking.';

const tsUser = (cid: number, uid: string | null, discordId: string | null = null): FakeUser => ({ ...idUser(cid, discordId), teamspeak_uid: uid });

function makeEnv(mode: string, users: FakeUser[]) {
  return {
    DISCORD_TOKEN: 'token',
    GUILD_ID: GUILD,
    SEND_CHANNELS: 'tech-team-alerts:300000000000000001',
    ROLE_SYNC_MODE: mode,
    KV: fakeKv({ expire: true }),
    TRAINING: fakeSource(),
    ...identityEnv(users),
    ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
    LARRY_QUEUE: fakeQueue<never>(),
    TEAMSPEAK_BOT_SECRET: 'made-up-teamspeak-bot-secret',
    TEAMSPEAK_RESULTS: fakeQueue<TeamSpeakResult>(),
    TEAMSPEAK_JOBS: fakeDurableObjects((ctx) => new TeamSpeakJobs(ctx, {})),
  };
}

let env: ReturnType<typeof makeEnv>;
let larry: Larry;
let logs: string[];

function start(mode: string, users: FakeUser[]) {
  env = makeEnv(mode, users);
  larry = new Larry({} as ExecutionContext, env as never);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  logs = [];
  for (const level of ['log', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation((line: string) => void logs.push(line));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const later = (minutes: number) => vi.setSystemTime(new Date(Date.now() + minutes * MINUTE));

/** teamspeak-bot reporting a client entering, through the results consumer. */
async function connect(uid: string, clientId = 5) {
  const { batch, messages } = batchOf<TeamSpeakResult>('teamspeak-results', [{ type: 'client-connected', uid, clientId, nickname: 'Jo' }]);
  await larry.queue(batch as never);
  return messages;
}

const store = () => env.TEAMSPEAK_JOBS.get(env.TEAMSPEAK_JOBS.idFromName('teamspeak-jobs'));
/** Every job waiting in the jobs store, oldest first, taken as teamspeak-bot would (pulled and acked), so a later call sees only newer ones. */
const tsJobs = async (): Promise<TeamSpeakJob[]> => {
  const jobs = store().pull(10);
  store().ack(jobs.map((job) => job.jobId), []);
  return jobs;
};
const texts = async () => (await tsJobs()).filter((job) => job.type === 'send-text');

/** The token in a link message. */
const tokenIn = (job: TeamSpeakJob) => (job.type === 'send-text' ? /\?ts=([A-Za-z0-9_-]+) /.exec(job.text)?.[1] : undefined);

/** Connect `uid` unlinked and return the token its message carries. */
async function linkMessage(uid: string): Promise<string> {
  await connect(uid);
  const [job] = await texts();
  return tokenIn(job!)!;
}

describe('the results route', () => {
  it('takes client-connected, and refuses a malformed one', async () => {
    start('live', []);
    const post = (body: unknown) =>
      larry.fetch(new Request('https://indy-larry.example.workers.dev/teamspeak/results', { method: 'POST', headers: { Authorization: `Bearer ${env.TEAMSPEAK_BOT_SECRET}` }, body: JSON.stringify(body) }));
    const good = { type: 'client-connected', uid: JO_UID, clientId: 5, nickname: 'Jo' };
    expect((await post(good)).status).toBe(202);
    for (const bad of [
      { type: 'client-connected', uid: '', clientId: 5, nickname: 'Jo' },
      { type: 'client-connected', uid: JO_UID, clientId: '5', nickname: 'Jo' },
      { type: 'client-connected', uid: JO_UID, clientId: 1.5, nickname: 'Jo' },
      { type: 'client-connected', uid: JO_UID, clientId: 5 },
    ]) {
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(env.TEAMSPEAK_RESULTS.sent).toEqual([good]);
  });
});

describe('an unlinked identity connecting', () => {
  it('is sent one private message with a 15-minute, single-use link', async () => {
    start('live', []);
    const messages = await connect(JO_UID, 42);

    const jobs = await tsJobs();
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job).toMatchObject({ type: 'send-text', clientId: 42 });
    const token = tokenIn(job)!;
    // 32 random bytes, URL-safe base64.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(job.type === 'send-text' && job.text).toBe(`Link this TeamSpeak identity to your Indy Center account: https://flyindycenter.com/profile?ts=${token} (works once, for 15 minutes)`);
    expect(messages[0]!.acked).toBe(true);
    // The token is never logged.
    expect(logs.join('\n')).not.toContain(token);
  });

  it('is sent nothing on a reconnect while that link is unused and under 15 minutes old', async () => {
    start('live', []);
    await linkMessage(JO_UID);
    later(14);
    await connect(JO_UID);

    expect(await texts()).toEqual([]);
  });

  it('is sent a fresh link on a reconnect after the last one expired, and the old one no longer works', async () => {
    start('live', [idUser(1000001)]);
    const first = await linkMessage(JO_UID);
    later(16);
    const second = await linkMessage(JO_UID);

    expect(second).not.toBe(first);
    await expect(larry.confirmTsLink(1000001, first)).rejects.toThrow(EXPIRED);
    await larry.confirmTsLink(1000001, second);
  });

  it('is sent a fresh link on a reconnect after the last one was used', async () => {
    start('live', [idUser(1000001)]);
    await larry.confirmTsLink(1000001, await linkMessage(JO_UID));
    // Unlinked again straight away, so the UID is no one's.
    await larry.unlink(1000001, 'teamspeak');
    later(1);
    await tsJobs();
    await connect(JO_UID);

    expect(await texts()).toHaveLength(1);
  });

  it('is sent a fresh link on a reconnect after the last one was used by a link identity refused', async () => {
    start('live', [idUser(1000001), idUser(1000002)]);
    const token = await linkMessage(JO_UID);
    env.IDENTITY.beforePatch = () => {
      env.IDENTITY.users.find((user) => user.sub === '1000002')!.teamspeak_uid = JO_UID;
    };
    await expect(larry.confirmTsLink(1000001, token)).rejects.toThrow(TAKEN);
    // That someone else's link goes again before the reconnect.
    env.IDENTITY.users.find((user) => user.sub === '1000002')!.teamspeak_uid = null;
    await connect(JO_UID);

    expect(await texts()).toHaveLength(1);
  });

  it('is sent nothing, and only logged, in dry-run', async () => {
    start('dry-run', []);
    await connect(JO_UID);

    expect(await tsJobs()).toEqual([]);
    expect(logs).toContain(`Link TeamSpeak (dry run): would send TeamSpeak ${JO_UID} a link`);
  });

  it('is retried, sending nothing, when identity is down', async () => {
    start('live', []);
    env.IDENTITY.down = true;
    const messages = await connect(JO_UID);

    expect(await tsJobs()).toEqual([]);
    expect(messages.map((message) => [message.acked, message.retried])).toEqual([[false, true]]);
  });
});

describe('a linked identity connecting', () => {
  it('is sent no link', async () => {
    start('live', [tsUser(1000001, JO_UID)]);
    const messages = await connect(JO_UID);

    expect(await tsJobs()).toEqual([]);
    expect(messages[0]!.acked).toBe(true);
    expect(logs).toContain(`TeamSpeak ${JO_UID} connected: linked to CID 1000001`);
  });
});

describe('confirmTsLink', () => {
  it('links the UID once, and queues the member’s sync', async () => {
    start('live', [idUser(1000001)]);
    const token = await linkMessage(JO_UID);
    await larry.confirmTsLink(1000001, token);

    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { teamspeak_uid: JO_UID } }]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'ts-sync-cid', cid: 1000001, uid: JO_UID }]);
    expect(await larry.getLinks(1000001)).toEqual({ discord: null, teamspeak: { uid: JO_UID } });
    await expect(larry.confirmTsLink(1000001, token)).rejects.toThrow(EXPIRED);
    expect(env.IDENTITY.writes).toHaveLength(1);
  });

  it('queues one job for a member also on Discord, which syncs both', async () => {
    start('live', [idUser(1000001, JO_DISCORD)]);
    await larry.confirmTsLink(1000001, await linkMessage(JO_UID));

    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'ts-sync-cid', cid: 1000001, uid: JO_UID }]);
  });

  it('refuses an unknown token', async () => {
    start('live', [idUser(1000001)]);
    for (const token of ['A'.repeat(43), 'not a token', '']) await expect(larry.confirmTsLink(1000001, token)).rejects.toThrow(EXPIRED);
    expect(env.IDENTITY.writes).toEqual([]);
  });

  it('refuses an expired token', async () => {
    start('live', [idUser(1000001)]);
    const token = await linkMessage(JO_UID);
    later(15);

    await expect(larry.confirmTsLink(1000001, token)).rejects.toThrow(EXPIRED);
    expect(env.IDENTITY.writes).toEqual([]);
  });

  it('refuses a UID another member holds', async () => {
    start('live', [idUser(1000001), idUser(1000002)]);
    const token = await linkMessage(JO_UID);
    // Linked to 1000002 some other way after the message went out (an earlier token, say).
    env.IDENTITY.users.find((user) => user.sub === '1000002')!.teamspeak_uid = JO_UID;

    await expect(larry.confirmTsLink(1000001, token)).rejects.toThrow(TAKEN);
    expect(env.IDENTITY.writes).toEqual([]);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('refuses with the same message when identity answers 409 to the write', async () => {
    start('live', [idUser(1000001), idUser(1000002)]);
    const token = await linkMessage(JO_UID);
    env.IDENTITY.beforePatch = () => {
      env.IDENTITY.users.find((user) => user.sub === '1000002')!.teamspeak_uid = JO_UID;
    };

    await expect(larry.confirmTsLink(1000001, token)).rejects.toThrow(TAKEN);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
    await expect(larry.confirmTsLink(1000001, token)).rejects.toThrow(EXPIRED);
  });

  it("refuses a CID identity doesn't know", async () => {
    start('live', []);
    const token = await linkMessage(JO_UID);

    await expect(larry.confirmTsLink(1000001, token)).rejects.toThrow(SIGN_IN);
    expect(env.IDENTITY.writes).toEqual([]);
  });

  it("removes the old UID's managed groups before writing the new one", async () => {
    start('live', [tsUser(1000001, JO_OLD_UID)]);
    const token = await linkMessage(JO_UID);
    let jobsAtWrite: TeamSpeakJob[] = [];
    env.IDENTITY.beforePatch = () => void (jobsAtWrite = store().pull(10));
    await larry.confirmTsLink(1000001, token);

    expect(jobsAtWrite.map(({ jobId: _, ...job }) => job)).toEqual([{ type: 'set-groups', uid: JO_OLD_UID, add: [], remove: MANAGED }]);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { teamspeak_uid: JO_UID } }]);
  });

  it('removes nothing when the member relinks the UID they hold', async () => {
    start('live', [idUser(1000001)]);
    const token = await linkMessage(JO_UID);
    env.IDENTITY.users[0]!.teamspeak_uid = JO_UID;
    await larry.confirmTsLink(1000001, token);

    expect(await tsJobs()).toEqual([]);
  });

  it("links in dry-run too, logging the old UID's removal instead of queueing it", async () => {
    start('live', [tsUser(1000001, JO_OLD_UID)]);
    const token = await linkMessage(JO_UID);
    env.ROLE_SYNC_MODE = 'dry-run';
    await larry.confirmTsLink(1000001, token);

    expect(await tsJobs()).toEqual([]);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { teamspeak_uid: JO_UID } }]);
    expect(logs).toContain(`Link TeamSpeak (dry run): would remove every managed group from TeamSpeak ${JO_OLD_UID}`);
  });
});

describe("unlink(cid, 'teamspeak')", () => {
  it('queues the removal of every managed group before clearing the link', async () => {
    start('live', [tsUser(1000001, JO_UID)]);
    let jobsAtWrite: TeamSpeakJob[] = [];
    env.IDENTITY.beforePatch = () => void (jobsAtWrite = store().pull(10));
    await larry.unlink(1000001, 'teamspeak');

    expect(jobsAtWrite.map(({ jobId: _, ...job }) => job)).toEqual([{ type: 'set-groups', uid: JO_UID, add: [], remove: MANAGED }]);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { teamspeak_uid: null } }]);
    expect(await larry.getLinks(1000001)).toEqual({ discord: null, teamspeak: null });
  });

  it('leaves their Discord account alone: unlinking TeamSpeak queues no Discord sync', async () => {
    start('live', [tsUser(1000001, JO_UID, JO_DISCORD)]);
    await larry.unlink(1000001, 'teamspeak');

    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('clears the link in dry-run, logging the removal instead of queueing it', async () => {
    start('dry-run', [tsUser(1000001, JO_UID)]);
    await larry.unlink(1000001, 'teamspeak');

    expect(await tsJobs()).toEqual([]);
    expect(env.IDENTITY.writes).toEqual([{ cid: '1000001', body: { teamspeak_uid: null } }]);
    expect(logs).toContain(`Link TeamSpeak (dry run): would remove every managed group from TeamSpeak ${JO_UID}`);
  });

  it('queues no removal for a member with no TeamSpeak link', async () => {
    start('live', [idUser(1000001)]);
    await larry.unlink(1000001, 'teamspeak');

    expect(await tsJobs()).toEqual([]);
  });
});
