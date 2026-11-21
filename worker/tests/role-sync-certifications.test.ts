import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { batchOf, fakeKv, fakeQueue } from './fake-cloudflare';
import { GUILD } from './fake-discord';
import { identityEnv } from './fake-identity';
import { fakeTraining, trainee } from './fake-training';
import { fakeVatusaAndDiscord } from './fake-vatusa';
import { lists, record } from './vatusa-records';

// The real mapping names no certification yet, so this file gives it two Discord-only entries.
vi.mock('../src/mapping', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/mapping')>();
  return {
    ...actual,
    MAPPING: [
      ...actual.MAPPING,
      { name: 'Radar Certified', discordRoleId: '900000000000000001', criteria: [{ conditions: [{ type: 'certification', value: 'T-RC' }] }] },
      { name: 'Oceanic', discordRoleId: '900000000000000002', criteria: [{ conditions: [{ type: 'certification', value: 'OCN' }] }] },
    ],
  };
});

const HOLDER = '800000000000000001';
const ENDORSED = '800000000000000002';
const NEITHER = '800000000000000003';

let logs: string[];

beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => void logs.push(line));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the certification condition', () => {
  it('matches a certification and an endorsement from the training roster, and nobody else', async () => {
    const env = {
      DISCORD_TOKEN: 'token',
      GUILD_ID: GUILD,
      SEND_CHANNELS: 'tech-team-alerts:300000000000000001',
      ROLE_SYNC_MODE: 'dry-run',
      KV: fakeKv(),
      TRAINING: fakeTraining({ members: [trainee(1000001, 'T-RC'), trainee(1000002, 'S3', ['OCN']), trainee(1000003, 'S3')] }),
      ...identityEnv(),
      ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>(),
      LARRY_QUEUE: fakeQueue<never>(),
    };
    const zid = [
      record({ cid: 1000001, rating_short: 'S3', discord_id: HOLDER }),
      record({ cid: 1000002, rating_short: 'S3', discord_id: ENDORSED }),
      record({ cid: 1000003, rating_short: 'S3', discord_id: NEITHER }),
    ];
    const staff = [record({ cid: 1000009, facility: 'ZHQ' })];
    const others = { ZME: [record({ cid: 1000004, facility: 'ZME' })], ZDC: [record({ cid: 1000005, facility: 'ZDC' })], ZAU: [record({ cid: 1000006, facility: 'ZAU' })], ZOB: [record({ cid: 1000007, facility: 'ZOB' })], ZTL: [record({ cid: 1000008, facility: 'ZTL' })], ZKC: [record({ cid: 1000010, facility: 'ZKC' })] };
    fakeVatusaAndDiscord(lists({ ZID: zid, ...others }, staff), { roles: [], members: [HOLDER, ENDORSED, NEITHER].map((id) => ({ user: { id }, roles: [] })) });

    const larry = new Larry({} as ExecutionContext, env as never);
    await larry.scheduled({ cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry() {} } as ScheduledController);
    logs = [];
    await larry.queue(batchOf('role-sync', env.ROLE_SYNC_QUEUE.sent).batch as never);

    const lines = logs.filter((line) => line.startsWith('Role sync'));
    expect(lines[0]).toMatch(/CID 1000001: add .*Radar Certified/);
    expect(lines[0]).not.toMatch(/Oceanic/);
    expect(lines[1]).toMatch(/CID 1000002: add .*Oceanic/);
    expect(lines[1]).not.toMatch(/Radar Certified/);
    expect(lines[2]).not.toMatch(/Radar Certified|Oceanic/);
  });
});
