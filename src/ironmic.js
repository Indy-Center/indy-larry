// Iron Mic: how long a facility's positions were staffed while a competition runs.
// Pure data logic only (no Discord code), so it can be tested offline. ironmicCommand.js does the Discord side.
//
// Totals come from vNAS Stats (https://vnas-stats.com, source at https://github.com/kengreim/vnas-stats).
// It groups time by callsign prefix and suffix, ignoring the middle part, so LEX_APP and LEX_N_APP are both
// "LEX APP" and two approach controllers on at once count once. Only active controllers count.

const STATS_URL = 'https://api.vnas-stats.com/v1/callsigns/top';
const MINUTE = 60_000;

// Position names staff type in /ironmic, in display order. suffix is the callsign suffix vNAS Stats groups by;
// facilityType is what the vNAS feed calls it, for the live "who's on" line.
const POSITIONS = {
  delivery: { label: 'Delivery', suffix: 'DEL', facilityType: 'ClearanceDelivery', aliases: ['del', 'clearance', 'cd'] },
  ground: { label: 'Ground', suffix: 'GND', facilityType: 'Ground', aliases: ['gnd', 'gc'] },
  local: { label: 'Local', suffix: 'TWR', facilityType: 'Tower', aliases: ['tower', 'twr', 'lc'] },
  approach: { label: 'Approach', suffix: 'APP', facilityType: 'ApproachDeparture', aliases: ['app', 'radar', 'tracon'] },
  center: { label: 'Center', suffix: 'CTR', facilityType: 'Center', aliases: ['ctr', 'enroute'] },
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

/**
 * Who is on each tracked position right now, from the vNAS feed Larry already polls.
 * Only a controller's primary position counts, and only while they're active on it.
 * @returns {Record<string, {cid: string, name: string, callsign: string}[]>}
 */
function staffedPositions(feed, facilityId, keys) {
  const result = Object.fromEntries(keys.map((k) => [k, []]));
  for (const c of feed.controllers ?? []) {
    if (c.isObserver || !c.isActive) continue;
    const primary = c.positions?.find((p) => p.isPrimary) ?? c.positions?.[0];
    if (!primary || primary.facilityId !== facilityId || primary.isActive === false) continue;
    const key = keys.find((k) => POSITIONS[k].facilityType === c.vatsimData?.facilityType);
    if (!key) continue;
    result[key].push({
      cid: String(c.vatsimData.cid),
      name: c.vatsimData.realName || String(c.vatsimData.cid),
      callsign: c.vatsimData.callsign || primary.defaultCallsign,
    });
  }
  for (const list of Object.values(result)) list.sort((a, b) => a.callsign.localeCompare(b.callsign));
  return result;
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
    live: Object.fromEntries(positions.map((k) => [k, []])),
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

const unix = (ms) => Math.floor(ms / 1000);

/** The leaderboard embed, as plain JSON (discord.js accepts it as-is). */
function competitionEmbed(comp, { showNames = true } = {}) {
  const ended = Boolean(comp.endedAt);
  const who = (p) => (showNames && p.name ? p.name : p.cid);
  const anyoneOn = comp.positions.some((k) => comp.live[k]?.length);
  const totals = comp.totals;

  const fields = comp.positions.map((key) => {
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
    if (!ended) {
      const on = comp.live[key] ?? [];
      lines.push(on.length ? `🟢 ${on.map((p) => `**${p.callsign}** ${who(p)}`).join(', ')}` : '🔴 Unstaffed');
    }
    return { name: `${POSITIONS[key].label} (${comp.facilityId}_${POSITIONS[key].suffix})`, value: lines.join('\n'), inline: false };
  });

  const name = comp.facilityName ?? comp.facilityId;
  let description = ended
    ? `<t:${unix(comp.startedAt)}:D> to <t:${unix(comp.endedAt)}:D>`
    : `Started <t:${unix(comp.startedAt)}:D> (<t:${unix(comp.startedAt)}:R>)`;
  if (ended && !comp.final) description += '\n*Fetching the final totals…*';
  else if (!ended && totals) description += ` · totals updated <t:${unix(totals.fetchedAt)}:R>`;

  return {
    color: ended ? 0xf1c40f : anyoneOn ? 0x2ecc71 : 0x4a5568,
    title: ended ? `🏁 ${name} Iron Mic: final results` : `🎙️ ${name} Iron Mic`,
    description,
    fields,
    footer: { text: 'Totals from vnas-stats.com. Several controllers on one position count once.' },
  };
}

module.exports = {
  STATS_URL,
  POSITIONS,
  parsePositions,
  staffedPositions,
  statsUrl,
  fetchStats,
  readStats,
  newCompetition,
  formatDuration,
  competitionEmbed,
};
