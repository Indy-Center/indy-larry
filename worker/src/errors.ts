import type { SendEnv } from './send';

/**
 * The Worker reports its errors to Discord, in ERROR_CHANNEL_ID (#larry-errors), the channel the VPS bot reports to.
 * With it unset, nothing is sent.
 *
 * index.ts gives every RPC call and queue batch an ErrorReport: what went wrong during it is added, and the lot is
 * sent as one message once the call is over (in waitUntil, so the caller never waits on it). Sending never throws,
 * and a report Discord won't take is only logged: a report about a failed report could loop.
 */

const DISCORD_API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_CONTENT = 2000;
const SEND_TIMEOUT_MS = 10_000;
// A rate limit this short is waited out once; a longer one drops the report.
const MAX_WAIT_SECONDS = 5;
// The same error is reported once per window per isolate, so a caller stuck in a loop can't flood the channel.
// Repeats are counted and shown with the next report of it. Isolates are reused, so this catches most floods.
const REPEAT_WINDOW_MS = 10 * 60_000;
// Messages per isolate per window, whatever they say.
const MAX_MESSAGES_PER_WINDOW = 20;
const MAX_TRACKED = 200;

export type ErrorEnv = Pick<SendEnv, 'DISCORD_TOKEN' | 'ERROR_CHANNEL_ID' | 'RELEASE'>;

const seen = new Map<string, { at: number; repeats: number }>();
const sentAt: number[] = [];
let skipped = 0;

/** The text of an error with its stack, or of anything else thrown. Never throws. */
export function describeError(error: unknown): string {
  try {
    if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`;
    return typeof error === 'string' ? error : JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}

/** What makes two reports "the same error": numbers (IDs, counts) ignored. */
export function keyOf(text: string): string {
  return text.replace(/\d+/g, '#').slice(0, 300);
}

/** A report in a code block, cut to fit in `room` characters. Backtick runs are broken up so they can't close the block. */
function block(text: string, room: number): string {
  const safe = text.replace(/```/g, '`​``');
  const fence = 8;
  const body = safe.length + fence <= room ? safe : `${safe.slice(0, Math.max(0, room - fence - 2))}\n…`;
  return `\`\`\`\n${body}\n\`\`\``;
}

/** For the tests: forget what this isolate has reported. */
export function resetErrorMemory(): void {
  seen.clear();
  sentAt.length = 0;
  skipped = 0;
}

export class ErrorReport {
  private readonly lines: { text: string; repeats: number }[] = [];

  constructor(
    private readonly env: ErrorEnv,
    private readonly now: () => number = Date.now,
  ) {}

  private get channelId(): string | undefined {
    const id = this.env.ERROR_CHANNEL_ID?.trim();
    return id && SNOWFLAKE.test(id) ? id : undefined;
  }

  /** Note something that went wrong. Never throws. */
  add(text: string): void {
    try {
      if (!this.channelId) return;
      const key = keyOf(text);
      const entry = seen.get(key);
      if (entry && this.now() - entry.at < REPEAT_WINDOW_MS) {
        entry.repeats++;
        return;
      }
      seen.set(key, { at: this.now(), repeats: 0 });
      if (seen.size > MAX_TRACKED) seen.delete(seen.keys().next().value!);
      if (this.lines.length < 10) this.lines.push({ text, repeats: entry?.repeats ?? 0 });
      else skipped++;
    } catch {}
  }

  /** The message to post, or null when there's nothing to say. */
  compose(): string | null {
    if (!this.lines.length) return null;
    const release = this.env.RELEASE ? ` · \`${this.env.RELEASE.slice(0, 7)}\`` : '';
    let content = `⚠️ **Larry worker**${release}`;
    if (skipped) {
      content += `\n_${skipped} more error report(s) were skipped to stay under the limit; see the Worker's logs._`;
      skipped = 0;
    }
    for (const { text, repeats } of this.lines) {
      const note = repeats ? `\n_Also happened ${repeats} more time(s) in the last ${REPEAT_WINDOW_MS / 60_000} minutes._` : '';
      const room = MAX_CONTENT - content.length - note.length - 1;
      if (room < 100) break;
      content += `\n${block(text, room)}${note}`;
    }
    return content;
  }

  /** Post what was noted, if anything. Resolves once tried; never rejects. */
  async flush(): Promise<void> {
    try {
      const channelId = this.channelId;
      const content = this.compose();
      this.lines.length = 0;
      if (!channelId || !content) return;

      const windowStart = this.now() - REPEAT_WINDOW_MS;
      while (sentAt.length && sentAt[0]! < windowStart) sentAt.shift();
      if (sentAt.length >= MAX_MESSAGES_PER_WINDOW) {
        skipped++;
        return;
      }
      sentAt.push(this.now());

      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${this.env.DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
          // An error's text can contain @everyone or a role mention; a report never pings anyone.
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.ok) return;
        const body = (await res.json().catch(() => ({}))) as { message?: string; code?: number; retry_after?: number };
        const wait = res.status === 429 ? body.retry_after : res.status >= 500 ? 1 : undefined;
        if (attempt === 0 && wait != null && wait <= MAX_WAIT_SECONDS) {
          await new Promise((resolve) => setTimeout(resolve, Math.ceil(wait * 1000)));
          continue;
        }
        console.warn(`Discord refused an error report: ${res.status}${body.code ? ` (${body.code})` : ''} ${body.message ?? ''}`);
        return;
      }
    } catch (error) {
      console.warn(`Could not post an error report: ${describeError(error)}`);
    }
  }
}
