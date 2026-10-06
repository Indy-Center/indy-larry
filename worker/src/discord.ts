import type { SendEnv } from './send';

/**
 * Shared by the role and channel code: one way to call Discord's REST API as Larry, and the server
 * those calls are about. Everything here uses the bot token, so the bot on the VPS isn't involved.
 */

export const DISCORD_API = 'https://discord.com/api/v10';
export const SNOWFLAKE = /^\d{17,20}$/;
export const MAX_NAME_LENGTH = 100;
// A rate limit this short is waited out once; a longer one fails the call.
const MAX_WAIT_SECONDS = 5;

export type GuildEnv = Pick<SendEnv, 'DISCORD_TOKEN' | 'GUILD_ID' | 'CHANNEL_CATEGORIES'>;

export class DiscordError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`Discord refused: ${status}${code ? ` (${code})` : ''} ${message}`);
  }
}

/** One Discord call. Waits out a short rate limit once. Throws DiscordError on anything else that isn't 2xx. */
export async function discord<T>(token: string, method: string, route: string, body?: unknown, reason?: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${DISCORD_API}${route}`, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(reason ? { 'X-Audit-Log-Reason': encodeURIComponent(reason) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.ok) return (res.status === 204 ? undefined : await res.json()) as T;

    const text = await res.text();
    let parsed: { message?: string; code?: number; retry_after?: number } = {};
    try {
      parsed = JSON.parse(text);
    } catch {}
    const wait = parsed.retry_after;
    if (res.status === 429 && attempt === 0 && wait != null && wait <= MAX_WAIT_SECONDS) {
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait * 1000)));
      continue;
    }
    throw new DiscordError(res.status, parsed.code, parsed.message ?? text);
  }
}

/** Check a delete request's IDs. Throws on anything that isn't a list of distinct Discord IDs. */
export function checkIds(request: { ids?: unknown }): string[] {
  if (!request || !Array.isArray(request.ids)) throw new Error('Expected { ids: [...] }');
  for (const id of request.ids) {
    if (typeof id !== 'string' || !SNOWFLAKE.test(id)) throw new Error(`"${id}" isn't a Discord ID`);
  }
  return [...new Set(request.ids as string[])];
}

/** The server roles and channels are managed in. Throws if GUILD_ID isn't set. */
export function guildId(env: Pick<SendEnv, 'GUILD_ID'>): string {
  if (!env.GUILD_ID || !SNOWFLAKE.test(env.GUILD_ID)) throw new Error("Larry isn't set up to manage roles or channels: GUILD_ID is missing or isn't a Discord ID");
  return env.GUILD_ID;
}
