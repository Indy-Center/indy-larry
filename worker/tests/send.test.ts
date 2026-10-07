import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consume, editNow, enqueue, enqueueEdit, prepare, prepareEdit, sendNow, type Job } from '../src/send';

const USER = '123456789012345678';
const DM_CHANNEL = '999999999999999999';

function makeEnv() {
  return {
    DISCORD_TOKEN: 'token',
    SEND_CHANNELS: 'events:111,training:222',
    LARRY_QUEUE: { send: vi.fn() } as unknown as Queue<Job> & { send: ReturnType<typeof vi.fn> },
  };
}

function makeMessage(body: Job, id = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789', attempts = 1) {
  return { id, body, attempts, ack: vi.fn(), retry: vi.fn() };
}

function makeBatch(...messages: ReturnType<typeof makeMessage>[]) {
  return { messages } as unknown as MessageBatch<Job>;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** The [url, parsed body] of each fetch call. */
function calls() {
  return vi.mocked(fetch).mock.calls.map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)]);
}

const channelJob = { target: { channelId: '111' }, message: { content: 'hello', allowed_mentions: { parse: ['users'] } } } as Job;

describe('prepare', () => {
  it('resolves a channel name and pings mentioned users by default', () => {
    expect(prepare(makeEnv(), 'channel', { channel: 'training', content: `Hi <@${USER}> @everyone` })).toEqual({
      target: { channelId: '222' },
      message: { content: `Hi <@${USER}> @everyone`, embeds: undefined, allowed_mentions: { parse: ['users'] } },
    });
  });

  it('passes allowedMentions through unchanged', () => {
    const job = prepare(makeEnv(), 'channel', {
      channel: 'events',
      embeds: [{ title: 'FNO' }],
      allowedMentions: { parse: ['everyone'], roles: ['5'] },
    });
    expect(job.message.allowed_mentions).toEqual({ parse: ['everyone'], roles: ['5'] });
    expect(job.message.embeds).toEqual([{ title: 'FNO' }]);
  });

  it('rejects a channel not in SEND_CHANNELS and lists the known ones', () => {
    expect(() => prepare(makeEnv(), 'channel', { channel: 'nope', content: 'x' })).toThrow(
      'Unknown channel "nope". Known channels: events, training',
    );
    expect(() => prepare({ SEND_CHANNELS: '' }, 'channel', { channel: 'events', content: 'x' })).toThrow('Known channels: none');
  });

  it('only accepts channel IDs by name', () => {
    expect(() => prepare(makeEnv(), 'channel', { channel: '111', content: 'x' })).toThrow('Unknown channel "111"');
  });

  it('targets a user for a DM, ignoring any channel', () => {
    const request = { userId: USER, channel: 'events', content: 'x' };
    expect(prepare(makeEnv(), 'direct', request).target).toEqual({ userId: USER });
  });

  it("rejects a user ID that isn't a snowflake", () => {
    expect(() => prepare(makeEnv(), 'direct', { userId: 'bob', content: 'x' })).toThrow(`"bob" isn't a Discord user ID`);
  });

  it('rejects empty, oversized and malformed messages', () => {
    const env = makeEnv();
    expect(() => prepare(env, 'channel', { channel: 'events', embeds: [] })).toThrow(/needs content or at least one embed/);
    expect(() => prepare(env, 'channel', { channel: 'events', content: 'x'.repeat(2001) })).toThrow(/limited to 2000 characters/);
    const embeds = Array.from({ length: 11 }, () => ({ title: 't' }));
    expect(() => prepare(env, 'channel', { channel: 'events', embeds })).toThrow(/limited to 10 embeds/);
    expect(() => prepare(env, 'channel', { channel: 'events', embeds: {} as never })).toThrow(/embeds must be an array/);
    expect(() => prepare(env, 'channel', null as never)).toThrow(/Expected a message object/);
  });
});

describe('buttons', () => {
  const link = { label: 'Open Teach', url: 'https://training.flyindycenter.com/teach' };

  it('puts link buttons in one row under the message', () => {
    const job = prepare(makeEnv(), 'channel', { channel: 'events', content: 'x', buttons: [link, { label: ' Wiki ', url: 'http://wiki.test/a' }] });
    expect(job.message.components).toEqual([
      {
        type: 1,
        components: [
          { type: 2, style: 5, label: 'Open Teach', url: 'https://training.flyindycenter.com/teach' },
          { type: 2, style: 5, label: 'Wiki', url: 'http://wiki.test/a' },
        ],
      },
    ]);
  });

  it('sends no components at all unless buttons are asked for', () => {
    expect('components' in prepare(makeEnv(), 'channel', { channel: 'events', content: 'x' }).message).toBe(false);
  });

  it('takes an empty list as "no buttons", which is how an edit removes them', () => {
    expect(prepare(makeEnv(), 'channel', { channel: 'events', content: 'x', buttons: [] }).message.components).toEqual([]);
  });

  it('rejects a button with no label, a bad address, or too many of them', () => {
    const env = makeEnv();
    const send = (buttons: unknown) => () => prepare(env, 'channel', { channel: 'events', content: 'x', buttons: buttons as never });
    expect(send([{ label: '', url: link.url }])).toThrow(/needs a label of up to 80 characters/);
    expect(send([{ label: 'x'.repeat(81), url: link.url }])).toThrow(/needs a label/);
    expect(send([{ label: 'Go', url: 'javascript:alert(1)' }])).toThrow(/Button "Go" needs an http\(s\) address/);
    expect(send([{ label: 'Go', url: `https://a.test/${'x'.repeat(512)}` }])).toThrow(/up to 512 characters/);
    expect(send(Array.from({ length: 6 }, () => link))).toThrow(/limited to 5 buttons/);
    expect(send('nope')).toThrow(/buttons must be an array/);
  });
});

describe('prepareEdit', () => {
  const MESSAGE = '555555555555555555';

  it('targets the message in its channel, and pings nobody', () => {
    expect(prepareEdit(makeEnv(), { channel: 'events', messageId: MESSAGE, embeds: [{ title: 'Claimed' }], content: `<@${USER}>` })).toEqual({
      target: { channelId: '111' },
      edit: MESSAGE,
      message: { content: `<@${USER}>`, embeds: [{ title: 'Claimed' }], allowed_mentions: { parse: [] } },
    });
  });

  it('never pings, whatever the caller allows', () => {
    const job = prepareEdit(makeEnv(), { channel: 'events', messageId: MESSAGE, content: '@everyone', allowedMentions: { parse: ['everyone'] } });
    expect(job.message.allowed_mentions).toEqual({ parse: [] });
  });

  it('rejects a message ID that is not one, and anything a new message would be refused for', () => {
    const env = makeEnv();
    expect(() => prepareEdit(env, { channel: 'events', messageId: 'latest', content: 'x' })).toThrow(`"latest" isn't a Discord message ID`);
    expect(() => prepareEdit(env, { channel: 'nope', messageId: MESSAGE, content: 'x' })).toThrow('Unknown channel "nope"');
    expect(() => prepareEdit(env, { channel: 'events', messageId: MESSAGE })).toThrow(/needs content or at least one embed/);
  });
});

describe('enqueue', () => {
  it('queues the prepared job', async () => {
    const env = makeEnv();
    await enqueue(env, 'channel', { channel: 'events', content: 'hello' });
    expect(env.LARRY_QUEUE.send).toHaveBeenCalledWith(channelJob);
  });

  it('queues nothing when the request is bad', async () => {
    const env = makeEnv();
    await expect(enqueue(env, 'channel', { channel: 'nope', content: 'x' })).rejects.toThrow();
    expect(env.LARRY_QUEUE.send).not.toHaveBeenCalled();
  });
});

describe('sendNow', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('posts to the channel with bot auth and returns the message', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ id: '555' }));
    await expect(sendNow(makeEnv(), 'channel', { channel: 'events', content: 'hello' })).resolves.toEqual({
      channelId: '111',
      messageId: '555',
    });
    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/channels/111/messages');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bot token');
    expect(JSON.parse(init.body as string)).toEqual({ content: 'hello', allowed_mentions: { parse: ['users'] } });
  });

  it('opens a DM channel and posts to it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ id: DM_CHANNEL })).mockResolvedValueOnce(json({ id: '556' }));
    await expect(sendNow(makeEnv(), 'direct', { userId: USER, content: 'psst' })).resolves.toEqual({
      channelId: DM_CHANNEL,
      messageId: '556',
    });
    expect(calls()).toEqual([
      ['https://discord.com/api/v10/users/@me/channels', { recipient_id: USER }],
      [`https://discord.com/api/v10/channels/${DM_CHANNEL}/messages`, { content: 'psst', allowed_mentions: { parse: ['users'] } }],
    ]);
  });

  it("explains a user who can't be DMed", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ id: DM_CHANNEL }))
      .mockResolvedValueOnce(json({ message: 'Cannot send messages to this user', code: 50007 }, 403));
    await expect(sendNow(makeEnv(), 'direct', { userId: USER, content: 'psst' })).rejects.toThrow(
      `Can't DM user ${USER}: they don't share a server with Larry or don't accept DMs`,
    );
  });

  it("throws with Discord's reason when it refuses", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ message: 'Missing Permissions', code: 50013 }, 403));
    await expect(sendNow(makeEnv(), 'channel', { channel: 'events', content: 'x' })).rejects.toThrow(
      'Discord refused the message: 403 (50013) Missing Permissions',
    );
  });

  it('waits out a short rate limit once', async () => {
    vi.useFakeTimers();
    vi.mocked(fetch).mockResolvedValueOnce(json({ retry_after: 1.2 }, 429)).mockResolvedValueOnce(json({ id: '557' }));
    const sent = sendNow(makeEnv(), 'channel', { channel: 'events', content: 'x' });
    await vi.advanceTimersByTimeAsync(1200);
    await expect(sent).resolves.toEqual({ channelId: '111', messageId: '557' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails a long rate limit right away', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ message: 'You are being rate limited.', retry_after: 30 }, 429));
    await expect(sendNow(makeEnv(), 'channel', { channel: 'events', content: 'x' })).rejects.toThrow(/429/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("doesn't call Discord for a bad request", async () => {
    await expect(sendNow(makeEnv(), 'channel', { channel: 'nope', content: 'x' })).rejects.toThrow(/Unknown channel/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('editNow and enqueueEdit', () => {
  const MESSAGE = '555555555555555555';

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('patches the message and returns it', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ id: MESSAGE }));
    await expect(editNow(makeEnv(), { channel: 'events', messageId: MESSAGE, embeds: [{ title: 'Passed' }], buttons: [] })).resolves.toEqual({
      channelId: '111',
      messageId: MESSAGE,
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://discord.com/api/v10/channels/111/messages/${MESSAGE}`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ embeds: [{ title: 'Passed' }], allowed_mentions: { parse: [] }, components: [] });
  });

  it("throws with Discord's reason when the message is gone", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ message: 'Unknown Message', code: 10008 }, 404));
    await expect(editNow(makeEnv(), { channel: 'events', messageId: MESSAGE, content: 'x' })).rejects.toThrow('404 (10008) Unknown Message');
  });

  it('queues the edit, and nothing when it is bad', async () => {
    const env = makeEnv();
    await enqueueEdit(env, { channel: 'events', messageId: MESSAGE, content: 'hello' });
    expect(env.LARRY_QUEUE.send).toHaveBeenCalledWith({ target: { channelId: '111' }, edit: MESSAGE, message: { content: 'hello', allowed_mentions: { parse: [] } } });

    await expect(enqueueEdit(env, { channel: 'events', messageId: 'x', content: 'hello' })).rejects.toThrow();
    expect(env.LARRY_QUEUE.send).toHaveBeenCalledOnce();
  });
});

describe('consume', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts with a nonce, then acks', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ id: '1' }));
    const message = makeMessage(channelJob);
    await consume(makeBatch(message), makeEnv());

    const [[url, body]] = calls() as [[string, Record<string, unknown>]];
    expect(url).toBe('https://discord.com/api/v10/channels/111/messages');
    expect(body.content).toBe('hello');
    expect(body.nonce).toBe('a1b2c3d4e5f64789abcdef012');
    expect(body.enforce_nonce).toBe(true);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('delivers a queued DM', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ id: DM_CHANNEL })).mockResolvedValueOnce(json({ id: '2' }));
    const message = makeMessage({ target: { userId: USER }, message: { content: 'psst' } });
    await consume(makeBatch(message), makeEnv());

    expect(calls().map(([url]) => url)).toEqual([
      'https://discord.com/api/v10/users/@me/channels',
      `https://discord.com/api/v10/channels/${DM_CHANNEL}/messages`,
    ]);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it("waits for Discord's retry_after on a 429", async () => {
    vi.mocked(fetch).mockResolvedValue(json({ retry_after: 2.3 }, 429));
    const message = makeMessage(channelJob);
    await consume(makeBatch(message), makeEnv());

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 3 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('backs off on a Discord server error', async () => {
    vi.mocked(fetch).mockResolvedValue(new Response('oops', { status: 502 }));
    const message = makeMessage(channelJob, undefined, 3);
    await consume(makeBatch(message), makeEnv());

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 30 });
  });

  it('retries a network failure', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('connection reset'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const message = makeMessage(channelJob);
    await consume(makeBatch(message), makeEnv());

    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 10 });
  });

  it('drops a message Discord refuses (4xx) instead of retrying it', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ message: 'Invalid Form Body', code: 50035 }, 400));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = makeMessage(channelJob);
    await consume(makeBatch(message), makeEnv());

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('400 (50035) Invalid Form Body'));
  });

  it('fails the run when Larry lacks permission in a channel, still dropping the message', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ message: 'Missing Permissions', code: 50013 }, 403));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = makeMessage(channelJob);

    await expect(consume(makeBatch(message), makeEnv())).rejects.toThrow('403 (50013) Missing Permissions');
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('fails the run for a channel Larry cannot see, one that is gone, or a bad token', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const [body, status] of [
      [{ message: 'Missing Access', code: 50001 }, 403],
      [{ message: 'Unknown Channel', code: 10003 }, 404],
      [{ message: '401: Unauthorized', code: 0 }, 401],
    ] as const) {
      vi.mocked(fetch).mockResolvedValue(json(body, status));
      await expect(consume(makeBatch(makeMessage(channelJob)), makeEnv())).rejects.toThrow("Larry can't do what it was asked to");
    }
  });

  it('handles the rest of the batch before failing the run', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ message: 'Missing Permissions', code: 50013 }, 403))
      .mockResolvedValueOnce(json({ id: '2' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const refused = makeMessage(channelJob, '11111111-0000-0000-0000-000000000000');
    const fine = makeMessage({ ...channelJob, target: { channelId: '222' } }, '22222222-0000-0000-0000-000000000000');

    await expect(consume(makeBatch(refused, fine), makeEnv())).rejects.toThrow('Missing Permissions');
    expect(refused.ack).toHaveBeenCalledOnce();
    expect(fine.ack).toHaveBeenCalledOnce();
  });

  it('does not fail the run for a user who will not take DMs', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(json({ id: DM_CHANNEL }))
      .mockResolvedValueOnce(json({ message: 'Cannot send messages to this user', code: 50007 }, 403));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = makeMessage({ target: { userId: USER }, message: { content: 'psst' } });

    await consume(makeBatch(message), makeEnv());
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('makes a queued edit with a PATCH and no nonce', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ id: '555555555555555555' }));
    const message = makeMessage({ ...channelJob, edit: '555555555555555555' });
    await consume(makeBatch(message), makeEnv());

    const [url, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://discord.com/api/v10/channels/111/messages/555555555555555555');
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual(channelJob.message);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('drops an edit to a message that has been deleted, without failing the run', async () => {
    vi.mocked(fetch).mockResolvedValue(json({ message: 'Unknown Message', code: 10008 }, 404));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const message = makeMessage({ ...channelJob, edit: '555555555555555555' });

    await expect(consume(makeBatch(message), makeEnv())).resolves.toBeUndefined();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it('handles each message in a batch on its own, with its own nonce', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(json({ id: '1' })).mockResolvedValueOnce(new Response('{}', { status: 500 }));
    const first = makeMessage(channelJob, '11111111-0000-0000-0000-000000000000');
    const second = makeMessage(channelJob, '22222222-0000-0000-0000-000000000000');
    await consume(makeBatch(first, second), makeEnv());

    expect(first.ack).toHaveBeenCalledOnce();
    expect(second.retry).toHaveBeenCalledOnce();
    const [a, b] = calls().map(([, body]) => body.nonce);
    expect(a).not.toBe(b);
  });
});
