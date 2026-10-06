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

/** A message to a channel by ID. The channel must sit under a category in Larry's `CHANNEL_CATEGORIES`. */
export type ChannelIdSend = Message & {
  /** A channel ID, e.g. one syncChannels() returned. */
  channelId: string;
};

/** One role and who should hold it. */
export type RoleSync = {
  /** The caller's own name for this entry, echoed back in the result. */
  key: string;
  /** Found by `id` when given and still there, otherwise by exact `name`; created (with no permissions) if neither finds one. */
  id?: string | null;
  name: string;
  /**
   * True: a role found by `id` whose name has drifted from `name` is renamed to it. Leave it out and
   * Larry never renames a role.
   */
  rename?: boolean;
  /** Discord user IDs who should hold the role. Someone not in the server is reported and can be tried again later. */
  members: string[];
  /**
   * True: **everyone not listed loses the role**, however they got it. False: Larry only adds, and
   * never takes the role from anyone. Required, because one of those is destructive.
   */
  exclusive: boolean;
};

export type RolesSync = {
  roles: RoleSync[];
  /** Work out and report what would change, and change nothing. */
  dryRun?: boolean;
};

export type RoleSyncResult = {
  key: string;
  /** Null only when a dry run would create it, or the entry failed. */
  roleId: string | null;
  role: 'found' | 'created' | 'would-create';
  /** The name it had before Larry renamed it (or would, in a dry run). */
  renamedFrom?: string;
  /** User IDs given the role (or who would be, in a dry run). */
  added: string[];
  /** User IDs the role was taken from (or would be). Always empty unless `exclusive`. */
  removed: string[];
  /** Wanted members Discord does not have in the server. */
  notInServer: string[];
  /** Why this role could not be synced. The others are unaffected. */
  error?: string;
};

export type RolesResult = {
  dryRun: boolean;
  /**
   * False when Larry could not list the server's members, which needs the Server Members intent
   * switched on for the bot. Roles are still added, but **nobody is removed**, and `notInServer` is
   * only learned by trying.
   */
  canSeeMembers: boolean;
  roles: RoleSyncResult[];
};

/** One private text channel Larry should find or create. */
export type ManagedChannel = {
  /** The caller's own name for this entry, echoed back in the result. */
  key: string;
  /** A category name from Larry's `CHANNEL_CATEGORIES` setting, e.g. `'training'`. Any other name is rejected. */
  category: string;
  /**
   * Found by `id` when given and still in the category, otherwise by `name` there; created if neither
   * finds one. The name is lowercased and hyphenated the way Discord does it.
   */
  id?: string | null;
  name: string;
  /**
   * True: a channel found by `id` whose name has drifted from `name` is renamed to it. Nothing else
   * about a found channel is ever changed. Leave it out and Larry never renames a channel.
   */
  rename?: boolean;
  /**
   * Role IDs that can see and post in the channel **when Larry creates it**; nobody else can. A channel
   * Larry finds keeps its permissions exactly as they are.
   */
  visibleTo: string[];
};

export type ChannelsSync = {
  channels: ManagedChannel[];
  /** Work out and report what would change, and change nothing. */
  dryRun?: boolean;
};

export type ChannelSyncResult = {
  key: string;
  /** Null only when a dry run would create it, or the entry failed. */
  channelId: string | null;
  /** The channel's name as Discord has it, or would. */
  channelName: string;
  channel: 'found' | 'created' | 'would-create';
  /** The name it had before Larry renamed it (or would, in a dry run). */
  renamedFrom?: string;
  /** Why this channel could not be synced. The others are unaffected. */
  error?: string;
};

export type ChannelsResult = {
  dryRun: boolean;
  channels: ChannelSyncResult[];
};

/** What happened to one role or channel a caller asked Larry to delete. */
export type Deletion = {
  id: string;
  /** `gone`: Discord no longer had it, which is the state the caller wanted. */
  outcome: 'deleted' | 'would-delete' | 'gone';
  /** Why it was not deleted. The others are unaffected. */
  error?: string;
};

export type DeleteRequest = {
  /** Role IDs for deleteRoles(), channel IDs for deleteChannels(). */
  ids: string[];
  /** Report what would be deleted, and delete nothing. */
  dryRun?: boolean;
};

export type DeleteResult = { dryRun: boolean; deleted: Deletion[] };

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
   * Make each role's membership match what is asked for, and report what changed. One role failing
   * does not stop the rest. Refuses roles that carry moderation permissions. Throws if `GUILD_ID` isn't set.
   */
  syncRoles(request: RolesSync): Promise<RolesResult>;
  /** Find each channel or create it under its category, and report which. Never changes a channel it finds. */
  syncChannels(request: ChannelsSync): Promise<ChannelsResult>;
  /**
   * Delete roles outright, for everyone who holds them. **Cannot be undone.** Under the same guard as
   * syncRoles(): Larry refuses a role with moderation permissions, a bot's role and @everyone.
   */
  deleteRoles(request: DeleteRequest): Promise<DeleteResult>;
  /**
   * Delete channels and every message in them. **Cannot be undone.** Only text channels under a
   * category in `CHANNEL_CATEGORIES`; anything else is refused.
   */
  deleteChannels(request: DeleteRequest): Promise<DeleteResult>;
  /** Post now to a channel by ID. Throws unless it is under a category in `CHANNEL_CATEGORIES`. */
  sendToChannel(request: ChannelIdSend): Promise<Sent>;
  /** Queue a post to a channel by ID, like enqueue(). The channel is checked before it is queued. */
  enqueueToChannel(request: ChannelIdSend): Promise<void>;
}

/** The binding's type in a caller's `Env`: `LARRY: LarryBinding`. */
export type LarryBinding = Service<LarryRpc>;
