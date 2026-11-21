import { sendNow, type SendEnv } from './send';

/** Where the role sync and group sync tell the tech team something needs a person: a `SEND_CHANNELS` name. */
export const ALERT_CHANNEL = 'tech-team-alerts';

/** What posting an alert to the tech team needs. */
export type AlertEnv = Pick<SendEnv, 'DISCORD_TOKEN' | 'SEND_CHANNELS' | 'LARRY_QUEUE'> & { KV: KVNamespace };

/** Post to the tech team unless `key` says this alert already stands; set `key` once it is posted. A failed post is tried again next time. */
export async function postOnce(env: AlertEnv, key: string, content: string): Promise<void> {
  if (await env.KV.get(key)) return;
  try {
    await sendNow(env as SendEnv, 'channel', { channel: ALERT_CHANNEL, content, allowedMentions: { parse: [] } });
    await env.KV.put(key, new Date().toISOString());
  } catch (error) {
    console.error(`Couldn't post an alert to ${ALERT_CHANNEL}: ${String(error)}`);
  }
}

/** Forget an alert, so the next occurrence posts again. Reads first: a KV read is cheaper than a write. */
export async function clearAlert(env: Pick<AlertEnv, 'KV'>, key: string): Promise<void> {
  if (await env.KV.get(key)) await env.KV.delete(key);
}
