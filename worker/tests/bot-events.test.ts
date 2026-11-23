import { beforeEach, describe, expect, it } from 'vitest';
import Larry from '../src/index';
import type { RoleSyncMessage } from '../src/role-sync';
import { fakeQueue } from './fake-cloudflare';

const SECRET = 'made-up-bot-events-secret';
const JOINER = '500000000000000007';
const URL = 'https://indy-larry.example.workers.dev';

let env: { BOT_EVENTS_SECRET?: string; ROLE_SYNC_QUEUE: ReturnType<typeof fakeQueue<RoleSyncMessage>> };
let larry: Larry;

beforeEach(() => {
  env = { BOT_EVENTS_SECRET: SECRET, ROLE_SYNC_QUEUE: fakeQueue<RoleSyncMessage>() };
  larry = new Larry({} as ExecutionContext, env as never);
});

function post(path: string, body: unknown, authorization: string | null = `Bearer ${SECRET}`, method = 'POST') {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (authorization !== null) headers.Authorization = authorization;
  return larry.fetch(new Request(`${URL}${path}`, { method, headers, body: method === 'GET' ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }));
}

describe('POST /bot/events', () => {
  it('queues sync-member on role-sync with the right secret, and answers 202', async () => {
    const res = await post('/bot/events', { type: 'sync-member', discordId: JOINER });
    expect(res.status).toBe(202);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([{ type: 'sync-member', discordId: JOINER }]);
  });

  it('answers 401 with no secret, a wrong one, or one sent another way, and queues nothing', async () => {
    for (const authorization of [null, 'Bearer not-the-secret', `Bearer ${SECRET}x`, SECRET, `Basic ${SECRET}`, 'Bearer ']) {
      const res = await post('/bot/events', { type: 'sync-member', discordId: JOINER }, authorization);
      expect(res.status, String(authorization)).toBe(401);
    }
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('answers 401 to everyone when the Worker has no secret set', async () => {
    env.BOT_EVENTS_SECRET = undefined;
    expect((await post('/bot/events', { type: 'sync-member', discordId: JOINER })).status).toBe(401);
    env.BOT_EVENTS_SECRET = '';
    expect((await post('/bot/events', { type: 'sync-member', discordId: JOINER }, 'Bearer ')).status).toBe(401);
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });

  it('answers 400 to an unknown type or a body that is not a known one', async () => {
    for (const body of [{ type: 'member-left', discordId: JOINER }, { discordId: JOINER }, { type: 'sync-member' }, { type: 'sync-member', discordId: 'not-an-id' }, { type: 'sync-member', discordId: 500000000000000007 }, 'not json', [], null]) {
      const res = await post('/bot/events', body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });
});

describe('every other request', () => {
  it('answers 404 to another path or method, secret or not', async () => {
    const body = { type: 'sync-member', discordId: JOINER };
    for (const res of [await post('/', body), await post('/bot/events/', body), await post('/bot', body), await post('/teamspeak/jobs', body), await post('/bot/events', body, `Bearer ${SECRET}`, 'GET'), await post('/bot/events', body, `Bearer ${SECRET}`, 'PUT'), await post('/anything', body, null)]) {
      expect(res.status).toBe(404);
    }
    expect(env.ROLE_SYNC_QUEUE.sent).toEqual([]);
  });
});
