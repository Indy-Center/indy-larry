import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorReport, resetErrorMemory } from '../src/errors';
import { consume, SetupFaultError, type Job, type QueueJob } from '../src/send';

const ERRORS = '555555555555555555';
const env = { DISCORD_TOKEN: 'token', ERROR_CHANNEL_ID: ERRORS, RELEASE: 'abcdef1234567' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The parsed body of each message posted. */
function posted() {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => ({ url, body: JSON.parse((init as RequestInit).body as string) }));
}

beforeEach(() => {
  resetErrorMemory();
  vi.stubGlobal('fetch', vi.fn(async () => json({ id: '1' })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ErrorReport', () => {
  it('posts what was noted as one message to ERROR_CHANNEL_ID, pinging nobody', async () => {
    const report = new ErrorReport(env);
    report.add('first @everyone');
    report.add('second');
    await report.flush();

    const [call] = posted();
    expect(posted()).toHaveLength(1);
    expect(call!.url).toBe(`https://discord.com/api/v10/channels/${ERRORS}/messages`);
    expect(call!.body.allowed_mentions).toEqual({ parse: [] });
    expect(call!.body.content).toContain('**Larry worker** · `abcdef1`');
    expect(call!.body.content).toContain('first @everyone');
    expect(call!.body.content).toContain('second');
  });

  it('sends nothing without ERROR_CHANNEL_ID, or with nothing noted', async () => {
    const off = new ErrorReport({ DISCORD_TOKEN: 'token' });
    off.add('boom');
    await off.flush();
    await new ErrorReport(env).flush();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports the same error once per window and counts the repeats', async () => {
    let now = 0;
    for (let i = 0; i < 3; i++) {
      const report = new ErrorReport(env, () => now);
      report.add(`Unknown channel ${i}`); // numbers don't make it a different error
      await report.flush();
    }
    expect(posted()).toHaveLength(1);

    now = 11 * 60_000;
    const later = new ErrorReport(env, () => now);
    later.add('Unknown channel 9');
    await later.flush();
    expect(posted()).toHaveLength(2);
    expect(posted()[1]!.body.content).toContain('Also happened 2 more time(s)');
  });

  it('keeps a long error inside Discord’s limit and its code block closed', async () => {
    const report = new ErrorReport(env);
    report.add('```' + 'x'.repeat(5000));
    await report.flush();
    const content = posted()[0]!.body.content as string;
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content.trimEnd().endsWith('```')).toBe(true);
    expect(content.match(/```/g)).toHaveLength(2);
  });

  it('never throws when Discord is unreachable or refuses', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'));
    const a = new ErrorReport(env);
    a.add('one');
    await expect(a.flush()).resolves.toBeUndefined();

    vi.mocked(fetch).mockResolvedValueOnce(json({ message: 'Missing Access', code: 50001 }, 403));
    const b = new ErrorReport(env);
    b.add('two');
    await expect(b.flush()).resolves.toBeUndefined();
  });

  it('waits out one short rate limit', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ retry_after: 0.01 }, 429));
    const report = new ErrorReport(env);
    report.add('boom');
    await report.flush();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('consume reporting', () => {
  const job = { target: { channelId: '111' }, message: { content: 'hello' } } as Job;
  const message = (attempts = 1) => ({ id: 'a1b2c3d4-e5f6-4789-abcd-ef0123456789', body: job, attempts, ack: vi.fn(), retry: vi.fn() });
  const batch = (...messages: ReturnType<typeof message>[]) => ({ messages }) as unknown as MessageBatch<QueueJob>;

  it('reports a dropped message, and fails the run with a SetupFaultError for a setup fault', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ message: 'Missing Access', code: 50001 }, 403));
    const report = vi.fn();
    await expect(consume(batch(message()), { DISCORD_TOKEN: 't' }, report)).rejects.toBeInstanceOf(SetupFaultError);
    expect(report).toHaveBeenCalledWith(expect.stringContaining('Missing Access'));
  });

  it('reports a message on its last retry, before it goes to the dead letter queue', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ message: 'down' }, 502));
    const report = vi.fn();
    await consume(batch(message(1)), { DISCORD_TOKEN: 't' }, report);
    expect(report).not.toHaveBeenCalled();

    const last = message(6);
    await consume(batch(last), { DISCORD_TOKEN: 't' }, report);
    expect(last.retry).toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.stringContaining('dead letter queue'));
  });
});
