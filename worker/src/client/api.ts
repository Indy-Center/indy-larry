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

/** A message to a room's channel, by ID. The channel must sit under Larry's room category. */
export type RoomSend = Message & {
  /** The channel ID syncRooms() returned for the room. */
  channelId: string;
};

/**
 * A room: a role, and a private channel only that role and the room admins can see. Used for a teacher
 * and their students, but nothing here knows that.
 */
export type Room = {
  /** The caller's own name for the room, echoed back in the result. */
  key: string;
  /**
   * The role. Found by `id` when given and still there, otherwise by exact name; created if neither
   * finds one. Two roles with the name is an error for this room, not a guess.
   */
  role: { id?: string | null; name: string };
  /**
   * The channel. Found by `id` when given and still there, otherwise by name under the room category;
   * created there if neither finds one. The name is lowercased and hyphenated the way Discord does it.
   * A channel Larry creates is visible to the role and the room admins only. One it finds is left
   * exactly as it is: its permissions are never changed.
   */
  channel: { id?: string | null; name: string };
  /**
   * Discord user IDs who should hold the role. **Everyone else holding it loses it**, however they
   * got it. Someone not in the server is reported in `notInServer` and tried again next time.
   */
  members: string[];
};

export type RoomsSync = {
  rooms: Room[];
  /** Work out and report what would change, and change nothing. */
  dryRun?: boolean;
};

export type RoomResult = {
  key: string;
  /** Null only when a dry run would create it, or the room failed. */
  roleId: string | null;
  role: 'found' | 'created' | 'would-create';
  channelId: string | null;
  /** The channel's name as Discord has it, or would. */
  channelName: string;
  channel: 'found' | 'created' | 'would-create';
  /** User IDs given the role (or who would be, in a dry run). */
  added: string[];
  /** User IDs the role was taken from (or would be). */
  removed: string[];
  /** Wanted members Discord does not have in the server. */
  notInServer: string[];
  /** Why the room could not be synced. Other rooms are unaffected. */
  error?: string;
};

export type RoomsResult = {
  dryRun: boolean;
  /**
   * False when Larry could not list the server's members, which needs the Server Members intent
   * switched on for the bot. Roles are still added, but nobody is removed, and `notInServer` is
   * only learned by trying.
   */
  canSeeMembers: boolean;
  rooms: RoomResult[];
};

/** Where a message was posted. */
export type Sent = { channelId: string; messageId: string };

/**
 * Larry's RPC surface, version 1.1.0. Every method checks the message first and throws for an unknown
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
  /**
   * Make each room's role, channel and membership match what is asked for, and report what changed.
   * One room failing does not stop the rest. Throws if rooms are not set up on Larry.
   */
  syncRooms(request: RoomsSync): Promise<RoomsResult>;
  /** Post now to a room's channel. Throws if the channel is not under the room category. */
  sendRoom(request: RoomSend): Promise<Sent>;
  /** Queue a post to a room's channel, like enqueue(). The channel is checked before it is queued. */
  enqueueRoom(request: RoomSend): Promise<void>;
}

/** The binding's type in a caller's `Env`: `LARRY: LarryBinding`. */
export type LarryBinding = Service<LarryRpc>;
