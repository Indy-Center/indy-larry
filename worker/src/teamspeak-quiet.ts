import { ALERT_CHANNEL, postOnce, type AlertEnv } from './alerts';
import { sendNow, type SendEnv } from './send';

/**
 * The quiet alert. larry keeps the time of the last result teamspeak-bot sent, of any kind (a heartbeat
 * comes every 5 minutes). The cron, finding none for 30 minutes, posts to `tech-team-alerts` once; the
 * next result posts the all-clear once. Both post in `dry-run` and `live`, as the other alerts do.
 */

/** When the last result of any kind arrived (ISO time). Written by results only: the cron only reads it, and with none kept it posts nothing. */
const LAST_RESULT_KEY = 'teamspeak-bot:last-result';
/** Set while the quiet alert stands, so it is posted once, not every 15 minutes. */
const QUIET_KEY = 'teamspeak-bot:quiet';
const QUIET_MINUTES = 30;

export const QUIET_TEXT = "teamspeak-bot hasn't reported in 30 minutes. TeamSpeak groups aren't syncing.";
export const BACK_TEXT = 'teamspeak-bot is back.';

/** A result arrived: keep its time, and if the quiet alert stands, post the all-clear and clear it. */
export async function noteResult(env: AlertEnv): Promise<void> {
  await env.KV.put(LAST_RESULT_KEY, new Date().toISOString());
  if (!(await env.KV.get(QUIET_KEY))) return;
  try {
    await sendNow(env as SendEnv, 'channel', { channel: ALERT_CHANNEL, content: BACK_TEXT, allowedMentions: { parse: [] } });
    await env.KV.delete(QUIET_KEY);
  } catch (error) {
    // The alert stands, so the next result tries again.
    console.error(`Couldn't post an all-clear to ${ALERT_CHANNEL}: ${String(error)}`);
  }
}

/** The cron's check: no result for 30 minutes posts the quiet alert, once. */
export async function checkQuiet(env: AlertEnv): Promise<void> {
  const last = await env.KV.get(LAST_RESULT_KEY);
  // No time kept: the bot has never reported (or isn't deployed yet), so there is nothing to call quiet.
  if (!last || Date.now() - Date.parse(last) < QUIET_MINUTES * 60_000) return;
  console.warn(`teamspeak-bot has sent no result since ${last}`);
  await postOnce(env, QUIET_KEY, QUIET_TEXT);
}
