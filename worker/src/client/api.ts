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

/** A button that opens a web address. */
export type LinkButton = {
  /** Up to 80 characters. */
  label: string;
  /** An http(s) address, up to 512 characters. */
  url: string;
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
  /**
   * Up to 5 buttons under the message, each opening a web address. Larry offers no buttons that do
   * something when pressed. On editMessage()/enqueueEdit(), leave it out to keep the buttons the message
   * has, or pass `[]` to remove them.
   */
  buttons?: LinkButton[];
};

/** A message to a channel. */
export type ChannelSend = Message & {
  /**
   * A channel name from Larry's `SEND_CHANNELS` setting, e.g. `'events'`. Names, not IDs, so a channel
   * can move without a change to the caller. Any other name is rejected.
   */
  channel: string;
};

/**
 * A change to a message Larry posted in a channel from `SEND_CHANNELS`. What is given replaces what the
 * message had; `content` or `embeds` left out stays as it was. An edit pings nobody.
 */
export type ChannelEdit = ChannelSend & {
  /** The message's ID, as send() returned it. */
  messageId: string;
};

/** A message Larry posted in a channel from `SEND_CHANNELS`, to delete. */
export type MessageRef = {
  /** The channel name it was sent to, as in ChannelSend. */
  channel: string;
  /** The message's ID, as send() returned it. */
  messageId: string;
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
  /**
   * The colour of a role Larry **creates**, as hex (`'#e67e22'` or `'e67e22'`). Not applied to a role
   * that already exists, so a colour chosen in Discord is never overwritten. Leave it out for no colour.
   */
  color?: string;
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

/** One person and one role: whether they should hold it. */
export type MemberRole = {
  /** The person's Discord user ID. */
  userId: string;
  roleId: string;
  /** True to give them the role, false to take it away. Saying it again changes nothing. */
  has: boolean;
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
 * Larry's RPC surface, version 1.3.0. Every method checks the message first and throws for an unknown
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
   * Change a message Larry posted, now, and return it. Throws if Discord refuses, including when the
   * message has been deleted or was not Larry's.
   */
  editMessage(request: ChannelEdit): Promise<Sent>;
  /** Queue the same change, like enqueue(). An edit to a message that has since been deleted is dropped. */
  enqueueEdit(request: ChannelEdit): Promise<void>;
  /**
   * Delete a message Larry posted, now. **Cannot be undone.** A message that is already gone counts as
   * deleted. Throws if Discord refuses, e.g. for someone else's message without Manage Messages.
   */
  deleteMessage(request: MessageRef): Promise<void>;
  /** Queue the same deletion and return once it's queued. Delivery retries rate limits and Discord outages. */
  enqueueDelete(request: MessageRef): Promise<void>;
  /**
   * Make each role's membership match what is asked for, and report what changed. One role failing
   * does not stop the rest. Refuses roles that carry moderation permissions. Throws if `GUILD_ID` isn't set.
   */
  syncRoles(request: RolesSync): Promise<RolesResult>;
  /** Find each channel or create it under its category, and report which. Never changes a channel it finds. */
  syncChannels(request: ChannelsSync): Promise<ChannelsResult>;
  /**
   * Give one person a role, or take it away, now. For a single change made on the spot (a button
   * press); to keep a whole role's membership in step, use syncRoles(). Under the same guard as
   * syncRoles(). Throws if Discord refuses, including when the person isn't in the server.
   */
  setMemberRole(request: MemberRole): Promise<void>;
  /**
   * Queue the same change and return once it's queued. Delivery retries rate limits and Discord
   * outages, so the caller needs no retry of its own. The role is checked before it is queued; a
   * change for someone not in the server is logged and dropped.
   */
  enqueueMemberRole(request: MemberRole): Promise<void>;
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
  /**
   * Link a member's own Discord account, which the caller has already proven they hold, and queue
   * their role sync. Throws "That Discord account is linked to another member." when someone else has
   * it, and "Sign in to flyindycenter.com once before linking." when identity has no user for the CID.
   *
   * With `accessToken`, the member's one-time Discord access token from a sign-in that asked for
   * `guilds.join`, larry also adds them to the Indy Center server if they aren't in it: `joined` is true
   * when it did. The token is used for that one call and kept nowhere. If the join fails, the link and
   * the sync still happen, and it throws "Your Discord account is linked, but we couldn't add you to the
   * Indy Center Discord. Ask a staff member for an invite." Without a token, or while larry's join bot
   * isn't set up, nobody is added and `joined` is false.
   */
  linkDiscord(cid: number, discordId: string, accessToken?: string): Promise<{ joined: boolean }>;
  /**
   * Clear a member's link and queue their role sync, which falls back to the Discord ID VATUSA holds.
   * `'teamspeak'` throws "TeamSpeak links aren't available yet." for now.
   */
  unlink(cid: number, service: 'discord' | 'teamspeak'): Promise<void>;
  /** Which Discord account the role sync uses for a member, and whether it is their link or VATUSA's. */
  getLinks(cid: number): Promise<Links>;
  /**
   * Sync these members now, instead of waiting for the next run: for an app that has just changed
   * something about them (a credential granted, a student assigned). larry reads every group source
   * again, then queues each CID's role sync. Each CID is declined, with a reason to show, when nothing is
   * known to sync or it was synced in the last 2 minutes. At most 100 CIDs a call.
   */
  syncMembers(cids: number[]): Promise<SyncMembersResult>;
  /**
   * Post a notice in a group's room, mentioning `mention` (CIDs). Each mentioned member's roles are
   * synced first, so someone just added to the group can see the room. `'no-room'` when the group has
   * no room (yet), `'not-live'` when the source's group sync isn't `live`.
   */
  postToGroup(request: GroupPost): Promise<GroupPostResult>;
  /** What the last cron run did with a source's groups. */
  getGroupStatus(source: string): Promise<GroupStatus>;
}

/** One group an app serves: who is in it, and whether it has a private room. */
export type Group = {
  /** Stable within the source; renaming a key makes a new group. */
  key: string;
  /** The group's name, as people should see it: the Discord role's name. */
  name: string;
  /** VATSIM CIDs, digit strings, no duplicates. The whole truth: anyone else loses the role. */
  members: string[];
  room?: {
    /** The room's name, as people should see it. */
    name: string;
    /** Used instead when two rooms' names collide in Discord. */
    fallbackName: string;
  };
  /** Keep this group exactly as it is: don't manage its members, rename or delete it. */
  hold?: true;
};

/** What a group source's `getGroups()` answers. */
export type GroupsAnswer = { groups: Group[] };

/** What an app implements, on the entrypoint larry's binding names, to serve groups. */
export type GroupSource = { getGroups(): Promise<GroupsAnswer> };

/** A notice for a group's room. Plain text: larry escapes Discord's formatting, leaving each http(s):// URL as it is. */
export type GroupNotice = { title: string; body: string; fields?: { name: string; value: string }[] };

export type GroupPost = {
  /** The source's name in larry's config, e.g. `'training'`. */
  source: string;
  /** The group's key in that source. */
  key: string;
  notice: GroupNotice;
  /** CIDs to mention. One with no Discord account is left unmentioned. */
  mention?: string[];
};

/** `'posted'` means queued. */
export type GroupPostResult = 'posted' | 'no-room' | 'not-live';

/** What happened to a role or room in the last run (or would, in `dry-run`). */
export type GroupState = 'found' | 'created' | 'renamed' | 'held' | 'missing' | 'deleted' | 'failed';

export type GroupStatus = {
  mode: 'off' | 'dry-run' | 'live';
  /** When the last run read the source; null before the first. */
  at: string | null;
  /** Why the source's answer was refused that run. */
  refused?: string;
  groups: { key: string; name: string; role: GroupState; room?: GroupState; error?: string }[];
};

/** What `syncMembers` answers, one entry per CID asked for. */
export type SyncMembersResult = ({ cid: number } & SyncMemberResult)[];

/** What `getLinks` reports for a member. */
export type Links = {
  /** The account the sync uses: `linked` when they linked it, `vatusa` when it is the one VATUSA holds. */
  discord: { id: string; source: 'linked' | 'vatusa' } | null;
  /** Always null until TeamSpeak links arrive. */
  teamspeak: { uid: string } | null;
};

/** What `syncMembers` answers for one CID. */
export type SyncMemberResult = { queued: true } | { queued: false; reason: string };

/** The binding's type in a caller's `Env`: `LARRY: LarryBinding`. */
export type LarryBinding = Service<LarryRpc>;
