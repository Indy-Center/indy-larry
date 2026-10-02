import { Routes, type APIAllowedMentions, type RESTPostAPIChannelMessageJSONBody } from 'discord-api-types/v10';
import { parseChannels } from './channels';
import type { ChannelSend, DirectSend, Sent } from './client/api';

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_CONTENT_LENGTH = 2000;
const MAX_EMBEDS = 10;
const MAX_NONCE_LENGTH = 25;
// send() waits out a rate limit this short once instead of failing the call.
const MAX_RPC_WAIT_SECONDS = 5;
// Discord error code for "Cannot send messages to this user".
const CANNOT_DM = 50007;

export type SendEnv = {
  DISCORD_TOKEN: string;
  SEND_CHANNELS?: string;
  LARRY_QUEUE: Queue<Job>;
};

/** Where a message goes, once its channel name is resolved. */
export type Target = { channelId: string } | { userId: string };

/** A checked message, ready for Discord. Also the body of a message on larry-messages. */
export type Job = { target: Target; message: RESTPostAPIChannelMessageJSONBody };

/** What Discord said to one attempt. */
type Outcome =
  | { ok: true; sent: Sent }
  | { ok: false; status: number; code?: number; error: string; retryAfter?: number };

/** Which RPC a request came in on: send()/enqueue() name a channel, the Direct ones a user. */
export type Kind = 'channel' | 'direct';

/** Check a request and turn it into a Job. Throws on anything Discord would refuse or we don't allow. */
export function prepare(env: Pick<SendEnv, 'SEND_CHANNELS'>, kind: Kind, request: ChannelSend | DirectSend): Job {
  if (!request || typeof request !== 'object') throw new Error('Expected a message object');
  let target: Target;
  if (kind === 'channel') {
    request = request as ChannelSend;
    const channels = parseChannels(env.SEND_CHANNELS);
    const channelId = channels.get(request.channel);
    if (!channelId) {
      throw new Error(`Unknown channel "${request.channel}". Known channels: ${[...channels.keys()].join(', ') || 'none'}`);
    }
    target = { channelId };
  } else {
    request = request as DirectSend;
    if (typeof request.userId !== 'string' || !/^\d{17,20}$/.test(request.userId)) {
      throw new Error(`"${request.userId}" isn't a Discord user ID`);
    }
    target = { userId: request.userId };
  }

  const { content, embeds } = request;
  if (content != null && typeof content !== 'string') throw new Error('content must be a string');
  if (embeds != null && !Array.isArray(embeds)) throw new Error('embeds must be an array');
  if (!content && !embeds?.length) throw new Error('A message needs content or at least one embed');
  if (content && content.length > MAX_CONTENT_LENGTH) throw new Error(`Message content is limited to ${MAX_CONTENT_LENGTH} characters`);
  if (embeds && embeds.length > MAX_EMBEDS) throw new Error(`Messages are limited to ${MAX_EMBEDS} embeds`);

  return {
    target,
    message: {
      content: content || undefined,
      embeds: embeds?.length ? embeds : undefined,
      // Pinging the users named in the content is the point of mentioning them; anything wider is opt-in.
      allowed_mentions: (request.allowedMentions ?? { parse: ['users'] }) as APIAllowedMentions,
    },
  };
}

/** POST to Discord as Larry. Network errors throw. */
async function post(token: string, route: string, body: unknown): Promise<Response> {
  return fetch(`${DISCORD_API}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function failure(res: Response): Promise<Outcome & { ok: false }> {
  const text = await res.text();
  let body: { message?: string; code?: number; retry_after?: number } = {};
  try {
    body = JSON.parse(text);
  } catch {}
  return { ok: false, status: res.status, code: body.code, error: body.message ?? text, retryAfter: body.retry_after };
}

/**
 * Make one attempt at sending a Job. A DM opens (or reuses) the user's DM channel first.
 * With a nonce, Discord drops a repeat of the same message, so a retry after a lost response can't double-post.
 */
export async function deliver(token: string, job: Job, nonce?: string): Promise<Outcome> {
  let channelId: string;
  if ('channelId' in job.target) {
    channelId = job.target.channelId;
  } else {
    const res = await post(token, Routes.userChannels(), { recipient_id: job.target.userId });
    if (!res.ok) return failure(res);
    channelId = ((await res.json()) as { id: string }).id;
  }

  const body: RESTPostAPIChannelMessageJSONBody = nonce ? { ...job.message, nonce, enforce_nonce: true } : job.message;
  const res = await post(token, Routes.channelMessages(channelId), body);
  if (!res.ok) return failure(res);
  const message = (await res.json()) as { id: string };
  return { ok: true, sent: { channelId, messageId: message.id } };
}

function describe(job: Job, outcome: Outcome & { ok: false }): string {
  if (outcome.code === CANNOT_DM && 'userId' in job.target) {
    return `Can't DM user ${job.target.userId}: they don't share a server with Larry or don't accept DMs`;
  }
  return `Discord refused the message: ${outcome.status}${outcome.code ? ` (${outcome.code})` : ''} ${outcome.error}`;
}

/** RPC: send now and return where it went. Throws with Discord's reason if it's refused. */
export async function sendNow(env: SendEnv, kind: Kind, request: ChannelSend | DirectSend): Promise<Sent> {
  const job = prepare(env, kind, request);
  let outcome = await deliver(env.DISCORD_TOKEN, job);
  const wait = !outcome.ok && outcome.status === 429 ? outcome.retryAfter : undefined;
  if (wait != null && wait <= MAX_RPC_WAIT_SECONDS) {
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait * 1000)));
    outcome = await deliver(env.DISCORD_TOKEN, job);
  }
  if (!outcome.ok) throw new Error(describe(job, outcome));
  return outcome.sent;
}

/** RPC: check and queue. Resolves once queued, not once sent. */
export async function enqueue(env: SendEnv, kind: Kind, request: ChannelSend | DirectSend): Promise<void> {
  await env.LARRY_QUEUE.send(prepare(env, kind, request));
}

/** Queue consumer: send each message, retrying rate limits, Discord outages and network errors. */
export async function consume(batch: MessageBatch<Job>, env: Pick<SendEnv, 'DISCORD_TOKEN'>): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    // Same nonce on every attempt of this queue message.
    const nonce = message.id.replace(/-/g, '').slice(0, MAX_NONCE_LENGTH);

    let outcome: Outcome;
    try {
      outcome = await deliver(env.DISCORD_TOKEN, job, nonce);
    } catch (error) {
      console.warn(`Send to ${JSON.stringify(job.target)} failed, retrying: ${String(error)}`);
      message.retry({ delaySeconds: 10 * message.attempts });
      continue;
    }

    if (outcome.ok) {
      message.ack();
    } else if (outcome.status === 429) {
      message.retry({ delaySeconds: Math.max(1, Math.ceil(outcome.retryAfter ?? 5)) });
    } else if (outcome.status >= 500) {
      message.retry({ delaySeconds: 10 * message.attempts });
    } else {
      // A 4xx is about the message itself (missing permissions, closed DMs, bad embed), so retrying won't help.
      console.error(`${describe(job, outcome)}; dropping message to ${JSON.stringify(job.target)}`);
      message.ack();
    }
  }
}
