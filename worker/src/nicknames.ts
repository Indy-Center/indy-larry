import type { NicknameChange, NicknameResult, NicknamesResult, NicknamesSync } from './client/api';
import { discord, DiscordError, guildId, SNOWFLAKE, type GuildEnv } from './discord';

/**
 * Nicknames: what people are called in the server. syncNicknames() sets each listed person's nickname
 * and reports what it did; setNickname() does one now. Neither knows how a caller chooses a name.
 *
 * The bot needs Manage Nicknames, and its own role above the people it renames. Discord never lets a
 * bot rename the server's owner, and Larry also leaves administrators alone.
 */

/** Discord's limit on a server nickname. */
export const MAX_NICKNAME_LENGTH = 32;
const ADMINISTRATOR = 1n << 3n;
const UNKNOWN_MEMBER = 10007;

type DiscordRole = { id: string; permissions?: string };
type DiscordGuildMember = { nick?: string | null; roles: string[] };

/** Check a request before anything is asked of Discord. Throws on the first thing wrong. */
export function checkNicknames(request: NicknamesSync): NicknameChange[] {
  if (!request || !Array.isArray(request.nicknames)) throw new Error('Expected { nicknames: [...] }');
  const seen = new Set<string>();
  for (const change of request.nicknames) checkNickname(change, seen);
  return request.nicknames;
}

function checkNickname(change: NicknameChange, seen?: Set<string>): void {
  if (!change || typeof change.userId !== 'string' || !SNOWFLAKE.test(change.userId)) {
    throw new Error(`"${change?.userId}" isn't a Discord user ID`);
  }
  // Two entries for one person would each undo the other.
  if (seen?.has(change.userId)) throw new Error(`User ${change.userId} is listed twice`);
  seen?.add(change.userId);

  if (change.nickname === null) return;
  if (typeof change.nickname !== 'string') throw new Error(`User ${change.userId}: nickname must be a string, or null to remove it`);
  const nickname = change.nickname.trim();
  if (!nickname || nickname.length > MAX_NICKNAME_LENGTH) {
    throw new Error(`User ${change.userId}: a nickname is 1 to ${MAX_NICKNAME_LENGTH} characters (use null to remove it)`);
  }
}

/** What Larry will not rename, with the reason, so it is skipped quietly. Null when it may try. */
function leaveAlone(userId: string, member: DiscordGuildMember, ctx: { ownerId: string; meId: string; adminRoles: Set<string> }): string | null {
  if (userId === ctx.ownerId) return "the server's owner can't be renamed by a bot";
  if (userId === ctx.meId) return 'Larry does not rename itself';
  if (member.roles.some((id) => ctx.adminRoles.has(id))) return 'administrators are left alone';
  return null;
}

/** RPC: set each person's nickname (null removes it), and say what happened to each. */
export async function syncNicknames(env: GuildEnv, request: NicknamesSync): Promise<NicknamesResult> {
  const guild = guildId(env);
  const wanted = checkNicknames(request);
  const dryRun = request.dryRun === true;
  const token = env.DISCORD_TOKEN;

  const results: NicknameResult[] = [];
  if (wanted.length === 0) return { dryRun, nicknames: results };

  const [guildInfo, roles, me] = await Promise.all([
    discord<{ owner_id: string }>(token, 'GET', `/guilds/${guild}`),
    discord<DiscordRole[]>(token, 'GET', `/guilds/${guild}/roles`),
    discord<{ id: string }>(token, 'GET', '/users/@me'),
  ]);
  const ctx = {
    ownerId: guildInfo.owner_id,
    meId: me.id,
    adminRoles: new Set(roles.filter((role) => BigInt(role.permissions ?? '0') & ADMINISTRATOR).map((role) => role.id)),
  };

  for (const { userId, nickname } of wanted) {
    const to = nickname === null ? null : nickname.trim();
    const result: NicknameResult = { userId, outcome: 'unchanged', from: null, to };
    results.push(result);

    try {
      const member = await discord<DiscordGuildMember>(token, 'GET', `/guilds/${guild}/members/${userId}`).catch((error) => {
        if (error instanceof DiscordError && error.status === 404 && error.code === UNKNOWN_MEMBER) return null;
        throw error;
      });
      if (!member) {
        result.outcome = 'not-in-server';
        continue;
      }

      result.from = member.nick ?? null;
      const reason = leaveAlone(userId, member, ctx);
      if (reason) {
        result.outcome = 'skipped';
        result.reason = reason;
      } else if (result.from === to) {
        result.outcome = 'unchanged';
      } else if (dryRun) {
        result.outcome = 'would-set';
      } else {
        await discord(token, 'PATCH', `/guilds/${guild}/members/${userId}`, { nick: to }, 'Nickname sync');
        result.outcome = 'set';
      }
    } catch (error) {
      // Typically the member's top role is above Larry's: reported, and the rest carry on.
      result.outcome = 'failed';
      result.error = error instanceof Error ? error.message : String(error);
      console.error(`Nickname for ${userId} could not be set: ${result.error}`);
    }
  }

  return { dryRun, nicknames: results };
}

/** RPC: set one person's nickname now. Throws with the reason when it is skipped or refused. */
export async function setNickname(env: GuildEnv, request: NicknameChange): Promise<void> {
  checkNickname(request);
  const { nicknames } = await syncNicknames(env, { nicknames: [request] });
  const [result] = nicknames;
  if (!result || result.outcome === 'set' || result.outcome === 'unchanged') return;
  if (result.outcome === 'not-in-server') throw new Error(`User ${request.userId} isn't in the server`);
  throw new Error(result.error ?? `Not renamed: ${result.reason}`);
}
