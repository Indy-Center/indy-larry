import type { GroupNotice, GroupPost, GroupPostResult } from './client/api';
import { effectiveMode, findSource, groupRecord, refreshSource } from './groups';
import { prepareChannelIdSend } from './managed-channels';
import { discordPlatform, type DiscordRef } from './platforms/discord';
import { accountFor, syncNow, type RoleSyncEnv } from './role-sync';

/** postToGroup(), which needs the role sync as well as the groups: it syncs who it mentions before posting. */

// Discord's embed limits.
const MAX_TITLE = 256;
const MAX_BODY = 4096;
const MAX_FIELDS = 25;
const MAX_FIELD_NAME = 256;
const MAX_FIELD_VALUE = 1024;

/**
 * Plain text as Discord shows it literally: its formatting characters and mentions escaped. Each
 * http(s):// URL, up to the next whitespace, is kept as it is so its link works.
 */
export function escapeText(text: string): string {
  // Splitting on a capturing group leaves the URLs at the odd indices.
  return text
    .split(/(https?:\/\/\S+)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(/[\\`*_~|>#[\]()<@-]/g, '\\$&')))
    .join('');
}

function checkText(label: string, value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be some text`);
  const escaped = escapeText(value);
  if (escaped.length > max) throw new Error(`${label} is too long for Discord (${max} characters, once escaped)`);
  return escaped;
}

function checkNotice(notice: GroupNotice) {
  if (!notice || typeof notice !== 'object') throw new Error('Expected a notice: { title, body, fields? }');
  const fields = notice.fields ?? [];
  if (!Array.isArray(fields) || fields.length > MAX_FIELDS) throw new Error(`fields must be a list of at most ${MAX_FIELDS}`);
  return {
    title: checkText('The title', notice.title, MAX_TITLE),
    description: checkText('The body', notice.body, MAX_BODY),
    ...(fields.length > 0
      ? { fields: fields.map((field, i) => ({ name: checkText(`Field ${i + 1}'s name`, field?.name, MAX_FIELD_NAME), value: checkText(`Field ${i + 1}'s value`, field?.value, MAX_FIELD_VALUE) })) }
      : {}),
  };
}

/**
 * RPC: post a notice in a group's room. Reads the source again (as syncMembers() does), syncs each
 * mentioned member's roles now, so someone just added can see the room, then queues the post mentioning
 * them. A CID with no Discord account is left unmentioned.
 */
export async function postToGroup(env: RoleSyncEnv, request: GroupPost): Promise<GroupPostResult> {
  if (!request || typeof request !== 'object') throw new Error('Expected { source, key, notice, mention? }');
  const config = findSource(request.source);
  if (typeof request.key !== 'string' || !request.key) throw new Error('key must be the group\'s key');
  const embed = checkNotice(request.notice);
  const mention = request.mention ?? [];
  if (!Array.isArray(mention) || mention.some((cid) => typeof cid !== 'string' || !/^\d{1,10}$/.test(cid))) throw new Error('mention must be a list of CIDs, as digit strings');

  // Under ROLE_SYNC_MODE dry-run the mentioned members' roles wouldn't change, so they couldn't see the post.
  if (effectiveMode(env, config) !== 'live') return 'not-live';
  const read = await refreshSource(env, config);
  // A group the source has just stopped giving a room has none, whatever its record still holds.
  if (read?.accepted && !read.groups.find((group) => group.key === request.key)?.room) return 'no-room';
  const channelId = (await groupRecord(env, config.source, request.key))?.channelId;
  if (!channelId) return 'no-room';

  const users: string[] = [];
  for (const cid of [...new Set(mention)].map(Number)) {
    const account = await accountFor<DiscordRef>(env, discordPlatform, cid);
    if (!account) continue;
    await syncNow(env, discordPlatform.messageFor(cid, account));
    users.push(account.id);
  }

  const job = await prepareChannelIdSend(env, {
    channelId,
    ...(users.length > 0 ? { content: users.map((id) => `<@${id}>`).join(' ') } : {}),
    embeds: [embed],
    allowedMentions: { users },
  });
  await env.LARRY_QUEUE.send(job);
  return 'posted';
}
