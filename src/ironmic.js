// Iron Mic: how long a facility's positions were staffed while a competition runs.
// Pure data logic only (no Discord code), so it can be tested offline. ironmicCommand.js does the Discord side.
//
// Totals come from vNAS Stats (https://vnas-stats.com, source at https://github.com/kengreim/vnas-stats).
// It groups time by callsign prefix and suffix, ignoring the middle part, so LEX_APP and LEX_N_APP are both
// "LEX APP" and two approach controllers on at once count once. Only active controllers count.

const STATS_URL = 'https://api.vnas-stats.com/v1/callsigns/top';
const MINUTE = 60_000;

// Position names staff type in /ironmic, in display order (top-down). suffix is the callsign suffix vNAS Stats groups by.
const POSITIONS = {
  center: { label: 'Center', suffix: 'CTR', aliases: ['ctr', 'enroute'] },
  approach: { label: 'Approach', suffix: 'APP', aliases: ['app', 'radar', 'tracon'] },
  local: { label: 'Local', suffix: 'TWR', aliases: ['tower', 'twr', 'lc'] },
  ground: { label: 'Ground', suffix: 'GND', aliases: ['gnd', 'gc'] },
  delivery: { label: 'Delivery', suffix: 'DEL', aliases: ['del', 'clearance', 'cd'] },
};

/**
 * "local, approach" -> ['local', 'approach'], in POSITIONS order with repeats dropped.
 * Accepts the aliases too ("twr app"). Throws with a message staff can read on anything else.
 */
function parsePositions(text) {
  const words = String(text ?? '')
    .toLowerCase()
    .split(/[\s,+/&]+|\band\b/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) throw new Error('Pick at least one position, e.g. `local, approach`.');

  const picked = new Set();
  for (const word of words) {
    const key = Object.keys(POSITIONS).find((k) => k === word || POSITIONS[k].aliases.includes(word));
    if (!key) throw new Error(`"${word}" isn't a position. Use ${Object.keys(POSITIONS).join(', ')}.`);
    picked.add(key);
  }
  return Object.keys(POSITIONS).filter((k) => picked.has(k));
}

function statsUrl(start, end) {
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return `${STATS_URL}?start=${encodeURIComponent(iso(start))}&end=${encodeURIComponent(iso(end))}`;
}

async function fetchStats(start, end) {
  const res = await fetch(statsUrl(start, end), { headers: { 'User-Agent': 'indy-larry (Indy Center Discord bot)' } });
  if (!res.ok) throw new Error(`vNAS Stats request failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Picks the tracked positions out of a vNAS Stats response, with each one's network rank.
 * The response ranks the network's top callsigns by time, so a listed position gets its rank and the
 * gap to the callsign ranked just above it (or, at #1, its lead over #2). A position that isn't listed
 * had less time than the last one listed; that's kept as "under", rather than shown as zero.
 * @returns {{ elapsedMs: number, fetchedAt: number, ranked: number,
 *   positions: Record<string, {ms: number, rank?: number, ahead?: {callsign: string, gapMs: number}, lead?: {callsign: string, gapMs: number}}|{underMs: number}> }}
 */
function readStats(stats, facilityId, keys) {
  const list = [...(stats.callsigns ?? [])].sort((a, b) => b.durationSeconds - a.durationSeconds);
  const floor = list.length ? list[list.length - 1].durationSeconds * 1000 : 0;
  const name = (c) => `${c.prefix}_${c.suffix}`;
  const positions = {};
  for (const key of keys) {
    const i = list.findIndex((c) => c.prefix === facilityId && c.suffix === POSITIONS[key].suffix);
    if (i < 0) {
      positions[key] = list.length ? { underMs: floor } : { ms: 0 };
      continue;
    }
    const entry = list[i];
    const t = { ms: entry.durationSeconds * 1000, rank: i + 1 };
    if (i > 0) t.ahead = { callsign: name(list[i - 1]), gapMs: (list[i - 1].durationSeconds - entry.durationSeconds) * 1000 };
    else if (list[1]) t.lead = { callsign: name(list[1]), gapMs: (entry.durationSeconds - list[1].durationSeconds) * 1000 };
    positions[key] = t;
  }
  return {
    elapsedMs: (stats.actualElapsedDurationSeconds ?? 0) * 1000,
    ranked: list.length,
    fetchedAt: Date.parse(stats.requestedAt) || Date.now(),
    positions,
  };
}

/** A fresh competition, saved as-is to ironmic.json. */
function newCompetition({ facilityId, facilityName = null, positions, channelId, startedAt }) {
  return {
    facilityId,
    facilityName,
    positions,
    channelId,
    messageId: null,
    startedAt,
    endedAt: null,
    totals: null, // readStats() output, refreshed every few minutes
    final: false, // true once totals have been fetched for the whole run after it ended
  };
}

/** 151_800_000 -> "42h 10m"; under an hour -> "35m". */
function formatDuration(ms) {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`;
}

function percent(ms, elapsed) {
  if (elapsed <= 0) return 0;
  return Math.min(100, Math.round((ms / elapsed) * 100));
}

/**
 * One embed per tracked position, in POSITIONS order (Center first), as plain JSON (discord.js accepts it
 * as-is). They go out together in one message. The last one's footer says when it started or ended.
 */
function competitionEmbeds(comp) {
  const ended = Boolean(comp.endedAt);
  const totals = comp.totals;
  const name = comp.facilityName ?? comp.facilityId;

  const embeds = comp.positions.map((key) => {
    const t = totals?.positions[key];
    let line;
    if (!t) line = '*Waiting for the first totals…*';
    else if (t.underMs != null) line = `**Under ${formatDuration(t.underMs)}** staffed · outside the network's top ${totals.ranked}`;
    else line = `**${formatDuration(t.ms)}** staffed · ${percent(t.ms, totals.elapsedMs)}%`;

    const lines = [line];
    if (t?.rank) {
      let rank = `🏆 **#${t.rank}** on the network`;
      if (t.ahead) rank += ` · ${formatDuration(t.ahead.gapMs)} behind ${t.ahead.callsign}`;
      else if (t.lead) rank += ` · ${formatDuration(t.lead.gapMs)} ahead of ${t.lead.callsign}`;
      lines.push(rank);
    }
    if (ended && !comp.final) lines.push('*Fetching the final totals…*');

    const position = `${POSITIONS[key].label} (${comp.facilityId}_${POSITIONS[key].suffix})`;
    return {
      color: 0xf1c40f,
      title: ended ? `🏁 ${name} Iron Mic · ${position}: final` : `🎙️ ${name} Iron Mic · ${position}`,
      description: lines.join('\n'),
    };
  });

  const last = embeds[embeds.length - 1];
  if (last) {
    last.footer = { text: `Totals from vnas-stats.com · Iron Mic ${ended ? 'ended' : 'started'}` };
    last.timestamp = new Date(comp.endedAt ?? comp.startedAt).toISOString();
  }
  return embeds;
}

module.exports = {
  STATS_URL,
  POSITIONS,
  parsePositions,
  statsUrl,
  fetchStats,
  readStats,
  newCompetition,
  formatDuration,
  competitionEmbeds,
};
