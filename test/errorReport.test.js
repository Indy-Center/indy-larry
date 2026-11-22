const test = require('node:test');
const assert = require('node:assert/strict');
const { createReporter, formatDuration, upMessage, keyOf } = require('../src/errorReport');

const CHANNEL = '555555555555555555';

/** A reporter whose Discord is `answers` (one per call, then 200s), recording what it posts. */
function setup({ answers = [], now = () => 0 } = {}) {
  const posts = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    const { status = 200, body = { id: '1' } } = answer ?? {};
    return { ok: status < 300, status, json: async () => body };
  };
  const reporter = createReporter({ token: 't', channelId: CHANNEL, release: 'abcdef1234567', fetchImpl, log: (...a) => logs.push(a.join(' ')), now, flushDelayMs: 60_000 });
  return { reporter, posts, logs };
}

test('a burst of errors goes out as one message, pinging nobody', async () => {
  const { reporter, posts } = setup();
  reporter.report('Refresh failed: @everyone timeout');
  reporter.report('Bookings update failed: 500');
  await reporter.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, `https://discord.com/api/v10/channels/${CHANNEL}/messages`);
  assert.deepEqual(posts[0].body.allowed_mentions, { parse: [] });
  assert.match(posts[0].body.content, /\*\*Larry bot\*\* · `abcdef1`/);
  assert.match(posts[0].body.content, /Refresh failed/);
  assert.match(posts[0].body.content, /Bookings update failed/);
});

test('the same error is reported once per window, with the repeats counted on the next report', async () => {
  let now = 0;
  const { reporter, posts } = setup({ now: () => now });
  reporter.report('[2026-11-21T10:00:00.000Z] Refresh failed: timeout after 10000ms');
  reporter.report('[2026-11-21T10:00:30.000Z] Refresh failed: timeout after 10001ms');
  reporter.report('[2026-11-21T10:01:00.000Z] Refresh failed: timeout after 10002ms');
  await reporter.flush();
  assert.equal(posts.length, 1);

  now = 16 * 60_000;
  reporter.report('[2026-11-21T10:16:00.000Z] Refresh failed: timeout after 10000ms');
  await reporter.flush();
  assert.equal(posts.length, 2);
  assert.match(posts[1].body.content, /Also happened 2 more time\(s\)/);
});

test('every message stays inside Discord’s limit with its code blocks closed', async () => {
  const { reporter, posts } = setup();
  for (let i = 0; i < 5; i++) reporter.report(`error ${'abcdefghij'[i]} ` + '```' + 'x'.repeat(1500));
  await reporter.flush();
  assert.ok(posts.length > 1);
  for (const { body } of posts) {
    assert.ok(body.content.length <= 2000, `${body.content.length} characters`);
    assert.equal(body.content.match(/```/g).length % 2, 0);
  }
});

test('a refused report is logged and dropped, never thrown', async () => {
  const { reporter, posts, logs } = setup({ answers: [{ status: 403, body: { message: 'Missing Access', code: 50001 } }] });
  reporter.report('boom');
  await reporter.flush();
  assert.equal(posts.length, 1);
  assert.match(logs[0], /403 \(50001\) Missing Access/);
});

test('a rate limit is waited out and the report sent', async () => {
  const { reporter, posts } = setup({ answers: [{ status: 429, body: { retry_after: 0.01 } }] });
  reporter.report('boom');
  await reporter.flush();
  assert.equal(posts.length, 2);
});

test('nothing is sent without a channel', async () => {
  const reporter = createReporter({ token: 't', channelId: undefined, fetchImpl: () => assert.fail('sent') });
  reporter.report('boom');
  await reporter.flush();
  await reporter.say('hi');
  assert.equal(reporter.enabled, false);
});

test('a crash report is headed as Larry going down', async () => {
  const { reporter, posts } = setup();
  reporter.report('TypeError: x is undefined', { fatal: true });
  await reporter.flush();
  assert.match(posts[0].body.content, /^🔴 \*\*Larry bot\*\* is down: crashed/);
});

test('keyOf ignores the timestamp and numbers', () => {
  assert.equal(keyOf('[2026-11-21T10:00:00.000Z] Failed 123'), keyOf('[2026-11-22T11:11:11.111Z] Failed 9'));
  assert.notEqual(keyOf('Refresh failed'), keyOf('Bookings failed'));
});

test('formatDuration', () => {
  assert.equal(formatDuration(12_000), '12 s');
  assert.equal(formatDuration(5 * 60_000), '5 min');
  assert.equal(formatDuration(200 * 60_000), '3 h 20 min');
  assert.equal(formatDuration(120 * 60_000), '2 h');
  assert.equal(formatDuration(72 * 3600_000), '3 days');
});

test('upMessage says how long Larry was down, and whether it said goodbye', () => {
  const name = '**Larry bot**';
  assert.equal(upMessage(name, null, 1000), '🟢 **Larry bot** is up.');
  assert.equal(upMessage(name, { state: 'down', at: 0 }, 5 * 60_000), '🟢 **Larry bot** is back up after 5 min.');
  assert.match(upMessage(name, { state: 'up', at: 0 }, 10 * 60_000), /back up after about 10 min\. It went down without warning/);
  assert.equal(upMessage(name, { state: 'down', at: 10_000 }, 0), '🟢 **Larry bot** is up.'); // clock went backwards
});

test('say() posts a status line as it is and resolves with whether it went out', async () => {
  const ok = setup();
  assert.equal(await ok.reporter.say('🟢 **Larry bot** is up.'), true);
  assert.equal(ok.posts[0].body.content, '🟢 **Larry bot** is up.');

  const refused = setup({ answers: [{ status: 403, body: { message: 'Missing Access', code: 50001 } }] });
  assert.equal(await refused.reporter.say('🟢 **Larry bot** is up.'), false);
  assert.match(refused.logs[0], /Missing Access/);
});
