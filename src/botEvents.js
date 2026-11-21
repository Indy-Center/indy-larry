// Tells larry's Worker about Discord gateway events it can't see itself: for now, a member joining
// the server, so the role sync gives them their roles straight away (README, Role sync).
// POST <WORKER_URL>/bot/events with Authorization: Bearer <BOT_EVENTS_SECRET>.

// No answer by then and the send is given up on.
const SEND_TIMEOUT_MS = 10_000;

/**
 * A guildMemberAdd handler that sends { type: 'sync-member', discordId } to the Worker. A send that
 * fails (network error, non-2xx, or no answer within the time limit) is logged and dropped: the
 * Worker's cron catches the member within 15 minutes. Never throws; resolves true once sent.
 */
function memberJoinHandler({ workerUrl, secret, fetch = globalThis.fetch, log = console, timeoutMs = SEND_TIMEOUT_MS }) {
  const url = `${workerUrl.replace(/\/+$/, '')}/bot/events`;
  return async (member) => {
    // A plain timer, not AbortSignal.timeout(): that one doesn't hold the event loop open, so a
    // process with nothing else running (a test, on Node 22) could exit before it fires.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'sync-member', discordId: member.id }),
        signal: controller.signal,
      });
      if (res.ok) return true;
      log.error(`Join sync for ${member.id} not sent: the Worker answered ${res.status}; the next role sync run catches them.`);
    } catch (err) {
      log.error(`Join sync for ${member.id} not sent: ${err?.message ?? err}; the next role sync run catches them.`);
    } finally {
      clearTimeout(timer);
    }
    return false;
  };
}

module.exports = { memberJoinHandler };
