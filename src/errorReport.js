// Larry reports his own errors to a Discord channel (ERROR_CHANNEL_ID, #larry-errors). With it blank, nothing is sent.
//
// Required by bot.js before anything else, so a failure while starting up is reported too. Reports go straight to
// Discord's REST API with the bot token rather than through the discord.js client, so they still go out before login
// and while the gateway is down. Every console.error is reported, as are uncaught exceptions and unhandled rejections
// (which then stop the bot, as Node would have; Docker restarts it).
//
// It also says when Larry goes down and comes back, like a status monitor: "🔴 Larry is down: stopped for a deploy or
// restart", then "🟢 Larry is back up after 2 min". A heartbeat in uptime.json covers the times Larry is killed without
// warning (out of memory, the VPS losing power): the next start says so and counts the downtime from the last beat.
//
// Nothing in here may throw into the code it watches, or report its own failures (that could loop): when Discord
// won't take a report, the reason goes to the container log and the report is dropped.
const fs = require('fs');
const util = require('util');
const { saveStateFile } = require('./stateFile');

const DISCORD_API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
const MAX_CONTENT = 2000;
// A burst of errors (one bad refresh can log several) goes out as one message.
const FLUSH_DELAY_MS = 3000;
// The same error is reported once per window; the repeats are counted and shown with the next report of it.
const REPEAT_WINDOW_MS = 15 * 60_000;
// At most this many messages an hour; the rest are counted and the count is posted when there's room again.
const MAX_MESSAGES_PER_HOUR = 30;
// Reports waiting to be sent; past this, new ones are counted and dropped.
const MAX_PENDING = 50;
const MAX_TRACKED = 500;
const SEND_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 4;
const MAX_RATE_LIMIT_WAIT_S = 60;
// How long a crash waits for its report to go out before the process exits.
const EXIT_FLUSH_MS = 5000;
// How often uptime.json is touched while Larry runs, so a hard kill's downtime is known to within this much.
const HEARTBEAT_MS = 60_000;

// A plain timer, not unref'd: an unref'd one can leave a waiting retry with nothing holding the process open (the
// test runner then fails the test). Every exit path calls process.exit right after its wait, so none is held up.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The text of an error with its stack, or of anything else thrown. Never throws. */
function describe(value) {
  try {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
    return typeof value === 'string' ? value : util.inspect(value, { depth: 3 });
  } catch {
    return '(an error that could not be described)';
  }
}

/** What makes two reports "the same error": the text without its timestamp prefix, with numbers (IDs, counts) ignored. */
function keyOf(text) {
  return text
    .replace(/^\[\d{4}-\d\d-\d\dT[\d:.]+Z\]\s*/, '')
    .replace(/\d+/g, '#')
    .slice(0, 300);
}

/** A report in a code block, cut to fit in `room` characters. Backtick runs are broken up so they can't close the block. */
function block(text, room) {
  const safe = text.replace(/```/g, '`​``');
  const fence = 8; // ```\n + \n```
  const body = safe.length + fence <= room ? safe : `${safe.slice(0, Math.max(0, room - fence - 2))}\n…`;
  return `\`\`\`\n${body}\n\`\`\``;
}

/**
 * The part that queues, groups, throttles and sends reports. Exported for the tests; installErrorReporting() wires
 * it to console.error and the process. `log` is where its own problems go: the real console.error, never the hooked one.
 */
function createReporter({ token, channelId, source = 'bot', release, fetchImpl = (...args) => fetch(...args), log = console.error, now = Date.now, flushDelayMs = FLUSH_DELAY_MS }) {
  const enabled = Boolean(token && channelId);
  const seen = new Map(); // key -> { at, repeats }
  const pending = []; // { text, repeats, fatal }
  const sentAt = []; // when each recent message went out, for the hourly cap
  let dropped = 0; // reports that didn't fit in the queue or under the cap
  let timer = null;
  let sending = Promise.resolve();

  const name = `**Larry ${source}**`;
  const label = `${name}${release ? ` · \`${String(release).slice(0, 7)}\`` : ''}`;

  function forget() {
    if (seen.size <= MAX_TRACKED) return;
    const cutoff = now() - REPEAT_WINDOW_MS;
    for (const [key, entry] of seen) if (entry.at < cutoff) seen.delete(key);
    // Still too many distinct errors: drop the oldest; the worst case is reporting one of them again.
    for (const key of seen.keys()) {
      if (seen.size <= MAX_TRACKED) break;
      seen.delete(key);
    }
  }

  /** Queue a report. A fatal one skips the repeat check, since it's the last thing this process will say. */
  function report(text, { fatal = false } = {}) {
    if (!enabled) return;
    try {
      text = String(text ?? '').trim() || '(empty error)';
      const key = keyOf(text);
      const entry = seen.get(key);
      if (!fatal && entry && now() - entry.at < REPEAT_WINDOW_MS) {
        entry.repeats++;
        return;
      }
      seen.set(key, { at: now(), repeats: 0 });
      forget();
      if (pending.length >= MAX_PENDING && !fatal) {
        dropped++;
        return;
      }
      pending.push({ text, repeats: entry?.repeats ?? 0, fatal });
      if (fatal) return; // the caller flushes right away
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          flush();
        }, flushDelayMs);
        timer.unref?.();
      }
    } catch (err) {
      log('Error reporting failed:', describe(err));
    }
  }

  /** Pack the pending reports into as few messages as fit, oldest first. */
  function compose() {
    const messages = [];
    while (pending.length) {
      const fatal = pending.some((p) => p.fatal);
      let content = fatal ? `🔴 ${name} is down: crashed` : `⚠️ ${label}`;
      if (dropped) {
        content += `\n_${dropped} more error report(s) were skipped to stay under the limit; see the container log._`;
        dropped = 0;
      }
      let added = 0;
      while (pending.length) {
        const { text, repeats } = pending[0];
        const note = repeats ? `\n_Also happened ${repeats} more time(s) in the last ${REPEAT_WINDOW_MS / 60_000} minutes._` : '';
        const room = MAX_CONTENT - content.length - note.length - 1;
        // Start a new message rather than cut a report short, unless it wouldn't fit in an empty one either.
        if (added > 0 && room < Math.min(text.length + 8, 600)) break;
        content += `\n${block(text, room)}${note}`;
        pending.shift();
        added++;
      }
      messages.push(content);
    }
    return messages;
  }

  /** Send one message, waiting out rate limits and retrying outages. Returns whether it went out. Never throws. */
  async function post(content) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${DISCORD_API}/channels/${channelId}/messages`, {
          method: 'POST',
          headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
          // An error's text can contain @everyone or a role mention; a report never pings anyone.
          body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
      } catch (err) {
        if (attempt === MAX_ATTEMPTS) {
          log(`Could not post an error report to Discord: ${describe(err)}`);
          return false;
        }
        await sleep(2 ** attempt * 1000);
        continue;
      }
      if (res.ok) return true;

      let body = {};
      try {
        body = await res.json();
      } catch {}
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === MAX_ATTEMPTS) {
        // 403/404 mean ERROR_CHANNEL_ID is wrong or Larry can't post there; nothing to retry.
        log(`Discord refused an error report: ${res.status}${body.code ? ` (${body.code})` : ''} ${body.message ?? ''}`.trim());
        return false;
      }
      const wait = res.status === 429 ? Math.min(Number(body.retry_after) || 5, MAX_RATE_LIMIT_WAIT_S) : 2 ** attempt;
      await sleep(Math.ceil(wait * 1000));
    }
    return false;
  }

  /** Send everything pending. Resolves once done; never rejects. Calls run one after another, never overlapping. */
  function flush() {
    if (!enabled) return Promise.resolve();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    sending = sending.then(async () => {
      try {
        for (const content of compose()) {
          const hourAgo = now() - 60 * 60_000;
          while (sentAt.length && sentAt[0] < hourAgo) sentAt.shift();
          if (sentAt.length >= MAX_MESSAGES_PER_HOUR && !content.startsWith('🔴')) {
            dropped += 1;
            continue;
          }
          sentAt.push(now());
          await post(content);
        }
      } catch (err) {
        log('Error reporting failed:', describe(err));
      }
    });
    return sending;
  }

  /** Post a status line (up/down) as it is: no grouping, repeat check or hourly cap. Resolves once tried; never rejects. */
  function say(content) {
    if (!enabled) return Promise.resolve();
    sending = sending.then(() => post(content)).catch((err) => log('Error reporting failed:', describe(err)));
    return sending;
  }

  return { enabled, name, report, flush, say, get pending() { return pending.length; } };
}

/** "12 s", "5 min", "3 h 20 min", "2 days": how long Larry was down. */
function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

/** The "back up" line for a start, from what uptime.json said about the last run. */
function upMessage(name, last, now) {
  if (!last || typeof last.at !== 'number' || last.at > now) return `🟢 ${name} is up.`;
  const after = formatDuration(now - last.at);
  if (last.state === 'down') return `🟢 ${name} is back up after ${after}.`;
  // The last run never said it was stopping: the heartbeat is the last sign of life.
  return `🟢 ${name} is back up after about ${after}. It went down without warning (killed, out of memory, or the VPS restarted).`;
}

/**
 * Turn reporting on for this process: hooks console.error, uncaught exceptions, unhandled rejections, SIGTERM and SIGINT.
 * Returns the reporter; fatal(), which reports, waits briefly for the report to go out and exits with 1; and
 * announceUp(), for bot.js to call once logged in, which posts the "back up" line and starts the heartbeat.
 */
function installErrorReporting(env = process.env, { uptimeFile } = {}) {
  const log = console.error.bind(console);
  let channelId = env.ERROR_CHANNEL_ID?.trim();
  if (channelId && !SNOWFLAKE.test(channelId)) {
    log(`ERROR_CHANNEL_ID "${channelId}" isn't a Discord channel ID; error reports are off.`);
    channelId = undefined;
  }
  if (channelId && channelId === env.CHANNEL_ID?.trim()) {
    // The status loop deletes every other message the bot has in CHANNEL_ID.
    log('ERROR_CHANNEL_ID must be different from CHANNEL_ID; error reports are off.');
    channelId = undefined;
  }

  const reporter = createReporter({ token: env.DISCORD_TOKEN?.trim(), channelId, release: env.RELEASE, log });

  let inHook = false;
  console.error = (...args) => {
    log(...args);
    if (inHook) return;
    inHook = true;
    try {
      reporter.report(util.format(...args));
    } catch {
      // never let reporting break the caller
    } finally {
      inHook = false;
    }
  };

  /** Record the bot's state in uptime.json. Never throws: losing it only makes the next "back up" line vaguer. */
  function mark(state, extra) {
    if (!uptimeFile) return;
    try {
      saveStateFile(uptimeFile, JSON.stringify({ state, at: Date.now(), ...extra }));
    } catch (err) {
      log(`Could not save ${uptimeFile}:`, err.message);
    }
  }

  function readLast() {
    try {
      return uptimeFile ? JSON.parse(fs.readFileSync(uptimeFile, 'utf8')) : null;
    } catch {
      return null; // first start, or an unreadable file
    }
  }

  let exiting = false;
  async function fatal(error) {
    const text = describe(error);
    log(text);
    if (exiting) return;
    exiting = true;
    // A crash on every start (Docker restarts it each time) is posted once per window, not once per restart.
    const last = readLast();
    const crash = keyOf(text);
    const repeat = last?.state === 'down' && last.crash === crash && Date.now() - last.at < REPEAT_WINDOW_MS;
    mark('down', { reason: 'crashed', crash, at: repeat ? last.at : Date.now() });
    if (repeat) process.exit(1);
    reporter.report(text, { fatal: true });
    await Promise.race([reporter.flush(), sleep(EXIT_FLUSH_MS)]);
    process.exit(1);
  }

  /** A requested stop (docker compose stop/restart, a deploy, Ctrl+C): send what's waiting, say so, and exit. */
  async function stop(signal) {
    if (exiting) return;
    exiting = true;
    mark('down', { reason: signal });
    const why = signal === 'SIGINT' ? 'stopped by hand' : 'stopped for a deploy or restart';
    await Promise.race([reporter.flush().then(() => reporter.say(`🔴 ${reporter.name} is down: ${why}.`)), sleep(EXIT_FLUSH_MS)]);
    process.exit(0);
  }

  let announced = false;
  /** Post the "back up" line, once per process, and keep uptime.json's heartbeat going. */
  function announceUp() {
    if (announced) return;
    announced = true;
    const last = readLast();
    mark('up');
    setInterval(() => mark('up'), HEARTBEAT_MS).unref();
    // Logged either way; the line has "error" in it so the deploy's log shows it.
    reporter.say(upMessage(reporter.name, last, Date.now())).then((ok) => {
      if (ok) console.log('Posted the up notice in the error channel.');
    });
  }

  process.on('uncaughtException', (err) => fatal(err));
  process.on('unhandledRejection', (reason) => fatal(reason));
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));

  if (reporter.enabled) log(`Error reports go to channel ${channelId}.`);
  return { reporter, fatal, announceUp };
}

module.exports = { installErrorReporting, createReporter, describe, keyOf, formatDuration, upMessage };
