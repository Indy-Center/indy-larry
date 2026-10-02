import type { APIEmbed } from 'discord-api-types/v10';

/** Discord's `allowed_mentions`, with `parse` as plain strings. */
export type AllowedMentions = {
  /** Kinds of mention in the content that ping. */
  parse?: ('users' | 'roles' | 'everyone')[];
  /** User IDs that may ping (not with `parse: ['users']`). */
  users?: string[];
  /** Role IDs that may ping (not with `parse: ['roles']`). */
  roles?: string[];
};

/** A message to send as Larry. At least one of `content` or `embeds` is required. */
export type Message = {
  /** Up to 2000 characters. Mention a user with `<@userId>`, a role with `<@&roleId>`. */
  content?: string;
  /** Up to 10 embeds, in Discord's embed format. */
  embeds?: APIEmbed[];
  /**
   * Passed to Discord as `allowed_mentions`, unchanged. Leave it out to ping the users mentioned in
   * the content and nobody else; pass e.g. `{ parse: ['users', 'roles'] }` or `{ roles: ['123'] }` to
   * ping more, or `{ parse: [] }` to ping nobody.
   */
  allowedMentions?: AllowedMentions;
};

/** A message to a channel. */
export type ChannelSend = Message & {
  /**
   * A channel name from Larry's `SEND_CHANNELS` setting, e.g. `'events'`. Names, not IDs, so a channel
   * can move without a change to the caller. Any other name is rejected.
   */
  channel: string;
};

/** A private message to a user. */
export type DirectSend = Message & {
  /** The user's Discord ID. They must share a server with Larry and allow DMs from it. */
  userId: string;
};

/** Where a message was posted. */
export type Sent = { channelId: string; messageId: string };

/**
 * Larry's RPC surface, version 1.0.0. Every method checks the message first and throws for an unknown
 * channel, a bad user ID, an empty message or one over Discord's limits.
 */
export interface LarryRpc extends Rpc.WorkerEntrypointBranded {
  /** Post now and return the message. Throws if Discord refuses it (e.g. missing permissions). */
  send(request: ChannelSend): Promise<Sent>;
  /** DM a user now and return the message. Throws if the user can't be messaged. */
  sendDirect(request: DirectSend): Promise<Sent>;
  /**
   * Queue a post and return once it's queued. Delivery retries rate limits and Discord outages;
   * a message Discord refuses is logged and dropped.
   */
  enqueue(request: ChannelSend): Promise<void>;
  /** Queue a DM, like enqueue(). */
  enqueueDirect(request: DirectSend): Promise<void>;
}

/** The binding's type in a caller's `Env`: `LARRY: LarryBinding`. */
export type LarryBinding = Service<LarryRpc>;
