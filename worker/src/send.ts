import { ButtonStyle, ComponentType, Routes, type APIAllowedMentions, type RESTPostAPIChannelMessageJSONBody } from 'discord-api-types/v10';
import { parseChannels } from './channels';
import { applyMemberRole } from './roles';
import type { ChannelEdit, ChannelSend, DirectSend, LinkButton, Sent } from './client/api';

const DISCORD_API = 'https://discord.com/api/v10';
const MAX_CONTENT_LENGTH = 2000;
const MAX_EMBEDS = 10;
const MAX_BUTTONS = 5;
const MAX_BUTTON_LABEL_LENGTH = 80;
const MAX_BUTTON_URL_LENGTH = 512;
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_NONCE_LENGTH = 25;
// send() waits out a rate limit this short once instead of failing the call.
const MAX_RPC_WAIT_SECONDS = 5;
// Discord error code for "Cannot send messages to this user".
const CANNOT_DM = 50007;
// Discord error code for "Unknown Message": the one an edit was for has been deleted.
const UNKNOWN_MESSAGE = 10008;

export type SendEnv = {
  DISCORD_TOKEN: string;
  SEND_CHANNELS?: string;
  LARRY_QUEUE: Queue<QueueJob>;
  /** The server whose roles and channels Larry manages (roles.ts, managed-channels.ts). */
  GUILD_ID?: string;
  /** Categories callers may create channels under and post into by ID, as name:categoryId like SEND_CHANNELS. */
  CHANNEL_CATEGORIES?: string;
};

/** Where a message goes, once its channel name is resolved. */
export type Target = { channelId: string } | { userId: string };

/**
 * A checked message, ready for Discord. Also the body of a message on larry-messages. With `edit`, it
 * changes the message with that ID instead of posting a new one.
 */
export type Job = { target: Target; message: RESTPostAPIChannelMessageJSONBody; edit?: string };

/** A checked role change for one person (roles.ts). The other thing larry-messages carries. */
export type RoleJob = { memberRole: { guildId: string; userId: string; roleId: string; has: boolean } };

/** Anything on larry-messages. A body with no `memberRole` is a message, as every body was before 1.1.0. */
export type QueueJob = Job | RoleJob;

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

  return { target, message: checkMessage(request) };
}

/** Check a message's content and embeds, and shape it for Discord. Throws on anything Discord would refuse. */
export function checkMessage(request: Pick<ChannelSend, 'content' | 'embeds' | 'allowedMentions' | 'buttons'>): Job['message'] {
  const { content, embeds } = request;
  if (content != null && typeof content !== 'string') throw new Error('content must be a string');
  if (embeds != null && !Array.isArray(embeds)) throw new Error('embeds must be an array');
  if (!content && !embeds?.length) throw new Error('A message needs content or at least one embed');
  if (content && content.length > MAX_CONTENT_LENGTH) throw new Error(`Message content is limited to ${MAX_CONTENT_LENGTH} characters`);
  if (embeds && embeds.length > MAX_EMBEDS) throw new Error(`Messages are limited to ${MAX_EMBEDS} embeds`);

  const message: Job['message'] = {
    content: content || undefined,
    embeds: embeds?.length ? embeds : undefined,
    // Pinging the users named in the content is the point of mentioning them; anything wider is opt-in.
    allowed_mentions: (request.allowedMentions ?? { parse: ['users'] }) as APIAllowedMentions,
  };
  // Left out entirely when no buttons were asked for, so an edit keeps the ones the message has.
  if (request.buttons !== undefined) message.components = linkButtons(request.buttons);
  return message;
}

/**
 * Buttons as one row of Discord link buttons, or no rows for an empty list. Only link buttons: one that
 * does something when pressed needs something listening for the press, and this Worker has no such thing.
 */
function linkButtons(buttons: LinkButton[]): NonNullable<Job['message']['components']> {
  if (!Array.isArray(buttons)) throw new Error('buttons must be an array');
  if (buttons.length > MAX_BUTTONS) throw new Error(`Messages are limited to ${MAX_BUTTONS} buttons`);
  if (buttons.length === 0) return [];

  return [
    {
      type: ComponentType.ActionRow,
      components: buttons.map((button) => {
        const label = typeof button?.label === 'string' ? button.label.trim() : '';
        if (!label || label.length > MAX_BUTTON_LABEL_LENGTH) throw new Error(`A button needs a label of up to ${MAX_BUTTON_LABEL_LENGTH} characters`);
        if (typeof button.url !== 'string' || !/^https?:\/\/\S+$/.test(button.url) || button.url.length > MAX_BUTTON_URL_LENGTH) {
          throw new Error(`Button "${label}" needs an http(s) address of up to ${MAX_BUTTON_URL_LENGTH} characters`);
        }
        return { type: ComponentType.Button, style: ButtonStyle.Link, label, url: button.url };
      }),
    },
  ];
}

/** Check an edit and turn it into a Job for the message it changes. Throws like prepare(). */
export function prepareEdit(env: Pick<SendEnv, 'SEND_CHANNELS'>, request: ChannelEdit): Job {
  const job = prepare(env, 'channel', request);
  if (typeof request.messageId !== 'string' || !SNOWFLAKE.test(request.messageId)) {
    throw new Error(`"${request.messageId}" isn't a Discord message ID`);
  }
  // An edit is never a reason to ping: whoever the first post named has already been told.
  return { ...job, message: { ...job.message, allowed_mentions: { parse: [] } }, edit: request.messageId };
}

/** POST (or PATCH) to Discord as Larry. Network errors throw. */
async function post(token: string, route: string, body: unknown, method: 'POST' | 'PATCH' = 'POST'): Promise<Response> {
  return fetch(`${DISCORD_API}${route}`, {
    method,
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
 * An edit needs no nonce: making the same change twice leaves the message as it is.
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

  if (job.edit) {
    const res = await post(token, Routes.channelMessage(channelId, job.edit), job.message, 'PATCH');
    if (!res.ok) return failure(res);
    return { ok: true, sent: { channelId, messageId: job.edit } };
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

/**
 * Whether Discord refused a message because of how Larry is set up, rather than because of the message:
 * a channel in SEND_CHANNELS that Larry can't see or post in (403), one that no longer exists (404), or a
 * bad token (401). A DM a user won't accept is theirs to change, not ours.
 */
function isSetupFault(job: Job, outcome: Outcome & { ok: false }): boolean {
  if (outcome.status === 401) return true;
  // The message an edit was for has been deleted: nobody's setup, and nothing left to change.
  if (job.edit && outcome.code === UNKNOWN_MESSAGE) return false;
  return 'channelId' in job.target && (outcome.status === 403 || outcome.status === 404);
}

/** RPC: send now and return where it went. Throws with Discord's reason if it's refused. */
export async function sendNow(env: SendEnv, kind: Kind, request: ChannelSend | DirectSend): Promise<Sent> {
  return sendJob(env, prepare(env, kind, request));
}

/** Send a checked Job now, waiting out one short rate limit. */
export async function sendJob(env: Pick<SendEnv, 'DISCORD_TOKEN'>, job: Job): Promise<Sent> {
  let outcome = await deliver(env.DISCORD_TOKEN, job);
  const wait = !outcome.ok && outcome.status === 429 ? outcome.retryAfter : undefined;
  if (wait != null && wait <= MAX_RPC_WAIT_SECONDS) {
    await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait * 1000)));
    outcome = await deliver(env.DISCORD_TOKEN, job);
  }
  if (!outcome.ok) throw new Error(describe(job, outcome));
  return outcome.sent;
}

/** RPC: change a message now and return it. Throws with Discord's reason if it's refused. */
export async function editNow(env: SendEnv, request: ChannelEdit): Promise<Sent> {
  return sendJob(env, prepareEdit(env, request));
}

/** RPC: check and queue an edit. Resolves once queued, not once made. */
export async function enqueueEdit(env: SendEnv, request: ChannelEdit): Promise<void> {
  await env.LARRY_QUEUE.send(prepareEdit(env, request));
}

/** RPC: check and queue. Resolves once queued, not once sent. */
export async function enqueue(env: SendEnv, kind: Kind, request: ChannelSend | DirectSend): Promise<void> {
  await env.LARRY_QUEUE.send(prepare(env, kind, request));
}

/**
 * Queue consumer: send each message, retrying rate limits, Discord outages and network errors.
 *
 * A message Discord refuses is dropped, since retrying can't help. When the refusal is Larry's own setup
 * (isSetupFault), the run also throws once the whole batch has been handled, so it shows as a failed
 * invocation instead of a log line nobody reads. Every message is acked or retried by then, and Queues
 * honours those whether or not the handler throws, so nothing is redelivered because of it.
 */
export async function consume(batch: MessageBatch<QueueJob>, env: Pick<SendEnv, 'DISCORD_TOKEN'>): Promise<void> {
  const setupFaults: string[] = [];

  for (const message of batch.messages) {
    if ('memberRole' in message.body) {
      const fault = await consumeRoleJob(message as Message<RoleJob>, env.DISCORD_TOKEN);
      if (fault) setupFaults.push(fault);
      continue;
    }

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
      const reason = `${describe(job, outcome)}; dropping message to ${JSON.stringify(job.target)}`;
      console.error(reason);
      message.ack();
      if (isSetupFault(job, outcome)) setupFaults.push(reason);
    }
  }

  if (setupFaults.length > 0) {
    throw new Error(`Larry can't do what it was asked to. Check the bot's permissions, its role's position and SEND_CHANNELS. ${setupFaults.join(' | ')}`);
  }
}

/**
 * One queued role change, by the same rules as a message: retry what might pass, drop what won't.
 * Returns the reason when the refusal is Larry's own setup, for consume() to fail the run with.
 */
async function consumeRoleJob(message: Message<RoleJob>, token: string): Promise<string | null> {
  const { memberRole } = message.body;
  const what = `${memberRole.has ? 'Giving' : 'Taking'} role ${memberRole.roleId} ${memberRole.has ? 'to' : 'from'} user ${memberRole.userId}`;

  let outcome: Awaited<ReturnType<typeof applyMemberRole>>;
  try {
    outcome = await applyMemberRole(token, memberRole);
  } catch (error) {
    console.warn(`${what} failed, retrying: ${String(error)}`);
    message.retry({ delaySeconds: 10 * message.attempts });
    return null;
  }

  if (outcome.ok) {
    message.ack();
    return null;
  }
  if (outcome.status === 429 || outcome.status >= 500) {
    message.retry({ delaySeconds: 10 * message.attempts });
    return null;
  }

  const reason = `${what} was refused: ${outcome.error}; dropping it`;
  console.error(reason);
  message.ack();
  // Someone who isn't in the server is nobody's fault. Anything else here is permissions, the
  // role's position or a role that has gone: Larry's setup, or the caller's stale ID.
  return outcome.notInServer ? null : reason;
}
