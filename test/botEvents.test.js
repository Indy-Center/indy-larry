const test = require('node:test');
const assert = require('node:assert/strict');
const { memberJoinHandler } = require('../src/botEvents');

const WORKER_URL = 'https://larry.example.workers.dev';
const SECRET = 'made-up-secret';
const JOINER = '500000000000000007';

/** A fetch stand-in that records each call and answers with `answer`. */
function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return answer(init);
  };
  return { fetch, calls };
}

function logger() {
  const lines = [];
  return { lines, error: (...args) => lines.push(args.join(' ')) };
}

const join = (options) => memberJoinHandler({ workerUrl: WORKER_URL, secret: SECRET, ...options })({ id: JOINER });

test('a join posts sync-member with the secret', async () => {
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 202 }));
  const log = logger();
  assert.equal(await join({ fetch, log }), true);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${WORKER_URL}/bot/events`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${SECRET}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { type: 'sync-member', discordId: JOINER });
  assert.ok(calls[0].init.signal instanceof AbortSignal); // the 10-second limit
  assert.deepEqual(log.lines, []);
});

test('a trailing slash on the Worker address makes no difference', async () => {
  const { fetch, calls } = fakeFetch(() => new Response(null, { status: 202 }));
  await memberJoinHandler({ workerUrl: `${WORKER_URL}/`, secret: SECRET, fetch, log: logger() })({ id: JOINER });
  assert.equal(calls[0].url, `${WORKER_URL}/bot/events`);
});

test('a refused send is logged, not thrown', async () => {
  const { fetch } = fakeFetch(() => new Response(null, { status: 401 }));
  const log = logger();
  assert.equal(await join({ fetch, log }), false);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], new RegExp(`${JOINER}.*401`));
});

test('a network error is logged, not thrown', async () => {
  const log = logger();
  assert.equal(await join({ fetch: async () => { throw new TypeError('fetch failed'); }, log }), false);
  assert.match(log.lines[0], /fetch failed/);
});

test('a send with no answer in time is given up on and logged', async () => {
  // Answers only when aborted, as fetch does.
  const fetch = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const log = logger();
  const started = Date.now();
  assert.equal(await join({ fetch, log, timeoutMs: 20 }), false);
  assert.ok(Date.now() - started < 1000);
  assert.equal(log.lines.length, 1);
  assert.match(log.lines[0], new RegExp(JOINER));
});
