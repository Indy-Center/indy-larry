import { discord, guildId, type GuildEnv } from './discord';

/**
 * Nicknames: what people are called in the server. applyNickname() sets one member's nickname, or says
 * why it won't; it doesn't know how a name is chosen.
 *
 * The bot needs Manage Nicknames, and its own role above the people it renames. Discord never lets a
 * bot rename the server's owner, and Larry also leaves administrators alone.
 */

/** Discord's limit on a server nickname. */
export const MAX_NICKNAME_LENGTH = 32;
const ADMINISTRATOR = 1n << 3n;

/** Who Larry won't rename, worked out from the server. */
export type NicknameGuard = { ownerId: string; meId: string; adminRoles: string[]; aboveLarry: string[] };

/**
 * The guard for a server: its owner, Larry itself, the roles that carry Administrator, and the roles at
 * or above Larry's highest (`larryTop`, a role position), whose holders Discord won't let Larry rename.
 */
export function nicknameGuard(ownerId: string, meId: string, roles: { id: string; permissions?: string; position?: number }[], larryTop = Infinity): NicknameGuard {
  return {
    ownerId,
    meId,
    adminRoles: roles.filter((role) => BigInt(role.permissions ?? '0') & ADMINISTRATOR).map((role) => role.id),
    aboveLarry: roles.filter((role) => (role.position ?? 0) >= larryTop).map((role) => role.id),
  };
}

/** What Larry will not rename, with the reason, so it is skipped quietly. Null when it may try. */
export function leaveAlone(member: { discordId: string; roleIds: string[] }, guard: NicknameGuard): string | null {
  if (member.discordId === guard.ownerId) return "the server's owner can't be renamed by a bot";
  if (member.discordId === guard.meId) return 'Larry does not rename itself';
  if (member.roleIds.some((id) => guard.adminRoles.includes(id))) return 'administrators are left alone';
  if (member.roleIds.some((id) => guard.aboveLarry.includes(id))) return "their highest role is at or above Larry's";
  return null;
}

export type NicknameOutcome =
  | { outcome: 'set' | 'would-set' | 'unchanged'; from: string | null; to: string }
  | { outcome: 'skipped'; from: string | null; to: string; reason: string };

/**
 * Set one member's nickname to `to`, from `nick`, which the caller has just read. Writes nothing when it
 * is already right, when `dryRun`, or when the member is left alone. Throws when Discord refuses.
 */
export async function applyNickname(
  env: GuildEnv,
  guard: NicknameGuard,
  member: { discordId: string; roleIds: string[]; nick: string | null },
  to: string,
  dryRun: boolean,
): Promise<NicknameOutcome> {
  const from = member.nick;
  const reason = leaveAlone(member, guard);
  if (reason) return { outcome: 'skipped', from, to, reason };
  if (from === to) return { outcome: 'unchanged', from, to };
  if (dryRun) return { outcome: 'would-set', from, to };
  await discord(env.DISCORD_TOKEN, 'PATCH', `/guilds/${guildId(env)}/members/${member.discordId}`, { nick: to }, 'Nickname sync');
  return { outcome: 'set', from, to };
}
