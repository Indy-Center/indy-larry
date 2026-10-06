import { parseChannels } from './channels';
import type { ChannelIdSend, ChannelSyncResult, ChannelsResult, ChannelsSync, ManagedChannel } from './client/api';
import { discord, guildId, MAX_NAME_LENGTH, SNOWFLAKE, type GuildEnv } from './discord';
import { checkMessage, type Job } from './send';

/**
 * Channels Larry looks after: private text channels under a category named in CHANNEL_CATEGORIES.
 * syncChannels() finds each one or creates it; sendToChannel()/enqueueToChannel() post to one by ID.
 * It knows nothing about what a channel is for.
 *
 * The bot needs Manage Channels. A caller can only reach categories in the setting, so this isn't a
 * way to create or post in channels anywhere else on the server.
 */

const GUILD_TEXT = 0;
const VIEW_CHANNEL = 1n << 10n;
// What the roles a channel is visible to can do in one Larry creates.
const MEMBER_PERMISSIONS =
  VIEW_CHANNEL |
  (1n << 11n) | // Send Messages
  (1n << 16n) | // Read Message History
  (1n << 14n) | // Embed Links
  (1n << 15n) | // Attach Files
  (1n << 6n); // Add Reactions

type DiscordChannel = { id: string; name: string; type: number; parent_id?: string | null; guild_id?: string };

/** A channel name the way Discord stores it: lowercase, accents dropped, anything else a hyphen. */
export function channelName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME_LENGTH);
}

/** CHANNEL_CATEGORIES, "training:111, events:222", as name -> category ID. Same format as SEND_CHANNELS. */
function categories(env: Pick<GuildEnv, 'CHANNEL_CATEGORIES'>): Map<string, string> {
  return parseChannels(env.CHANNEL_CATEGORIES);
}

/** Check a request before anything is asked of Discord. Throws on the first thing wrong. */
export function checkChannels(env: Pick<GuildEnv, 'CHANNEL_CATEGORIES'>, request: ChannelsSync): ManagedChannel[] {
  if (!request || !Array.isArray(request.channels)) throw new Error('Expected { channels: [...] }');
  const known = categories(env);
  const keys = new Set<string>();
  const names = new Set<string>();

  for (const channel of request.channels) {
    if (!channel?.key || typeof channel.key !== 'string') throw new Error('Every channel needs a key');
    if (keys.has(channel.key)) throw new Error(`Channel "${channel.key}" is listed twice`);
    keys.add(channel.key);

    if (!known.has(channel.category)) {
      throw new Error(`Unknown category "${channel.category}". Known categories: ${[...known.keys()].join(', ') || 'none'}`);
    }
    const name = channelName(channel.name ?? '');
    if (!name) throw new Error(`Channel "${channel.key}" needs a name`);
    const place = `${channel.category}/${name}`;
    if (names.has(place)) throw new Error(`Two entries ask for the channel "${name}" in "${channel.category}"`);
    names.add(place);

    if (channel.id != null && !SNOWFLAKE.test(channel.id)) throw new Error(`Channel "${channel.key}": "${channel.id}" isn't a Discord ID`);
    // A channel nobody is allowed into is a mistake, not a request.
    if (!Array.isArray(channel.visibleTo) || channel.visibleTo.length === 0) throw new Error(`Channel "${channel.key}" must be visible to at least one role`);
    for (const id of channel.visibleTo) {
      if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new Error(`Channel "${channel.key}": "${id}" isn't a Discord role ID`);
    }
  }
  return request.channels;
}

/** RPC: find each channel or create it, and say which. */
export async function syncChannels(env: GuildEnv, request: ChannelsSync): Promise<ChannelsResult> {
  const guild = guildId(env);
  const wantedChannels = checkChannels(env, request);
  const known = categories(env);
  const dryRun = request.dryRun === true;
  const token = env.DISCORD_TOKEN;

  const [channels, me] = await Promise.all([
    discord<DiscordChannel[]>(token, 'GET', `/guilds/${guild}/channels`),
    discord<{ id: string }>(token, 'GET', '/users/@me'),
  ]);

  const results: ChannelSyncResult[] = [];

  for (const wanted of wantedChannels) {
    const categoryId = known.get(wanted.category)!;
    const name = channelName(wanted.name);
    const result: ChannelSyncResult = { key: wanted.key, channelId: null, channelName: name, channel: 'found' };
    results.push(result);

    try {
      // By ID, then by name under the category, then made there.
      const inCategory = channels.filter((channel) => channel.type === GUILD_TEXT && channel.parent_id === categoryId);
      const sameName = inCategory.filter((channel) => channel.name === name);
      const byId = inCategory.find((candidate) => candidate.id === wanted.id);
      const channel = byId ?? (sameName.length === 1 ? sameName[0] : undefined);
      if (!channel && sameName.length > 1) throw new Error(`${sameName.length} channels are named "${name}"; give the channel's ID`);

      if (channel) {
        // Found, so left as it is: its permissions were set by someone and are not Larry's to change.
        result.channelId = channel.id;
        result.channelName = channel.name;
      } else if (dryRun) {
        result.channel = 'would-create';
      } else {
        const allow = MEMBER_PERMISSIONS.toString();
        const created = await discord<DiscordChannel>(
          token,
          'POST',
          `/guilds/${guild}/channels`,
          {
            name,
            type: GUILD_TEXT,
            parent_id: categoryId,
            permission_overwrites: [
              { id: guild, type: 0, deny: VIEW_CHANNEL.toString() }, // @everyone
              ...[...new Set(wanted.visibleTo)].map((id) => ({ id, type: 0, allow })),
              { id: me.id, type: 1, allow }, // Larry itself, or it could not post here
            ],
          },
          'Channel sync',
        );
        channels.push(created);
        result.channelId = created.id;
        result.channelName = created.name;
        result.channel = 'created';
      }
    } catch (error) {
      result.error = error instanceof Error ? error.message : String(error);
      console.error(`Channel "${wanted.key}" could not be synced: ${result.error}`);
    }
  }

  return { dryRun, channels: results };
}

/**
 * Check a message for a channel named by ID and turn it into a Job. The channel is looked up, so a
 * caller can only reach channels under a category in CHANNEL_CATEGORIES.
 */
export async function prepareChannelIdSend(env: GuildEnv, request: ChannelIdSend): Promise<Job> {
  const guild = guildId(env);
  if (!request || typeof request !== 'object') throw new Error('Expected a message object');
  if (typeof request.channelId !== 'string' || !SNOWFLAKE.test(request.channelId)) throw new Error(`"${request.channelId}" isn't a Discord channel ID`);
  const message = checkMessage(request);
  const allowed = new Set(categories(env).values());

  let channel: DiscordChannel;
  try {
    channel = await discord<DiscordChannel>(env.DISCORD_TOKEN, 'GET', `/channels/${request.channelId}`);
  } catch (error) {
    throw new Error(`Larry can't see channel ${request.channelId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (channel.guild_id !== guild || channel.type !== GUILD_TEXT || !channel.parent_id || !allowed.has(channel.parent_id)) {
    throw new Error(`Channel ${request.channelId} isn't one Larry looks after: it is not a text channel under a category in CHANNEL_CATEGORIES`);
  }

  return { target: { channelId: channel.id }, message };
}
