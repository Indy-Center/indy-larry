// Iron Mic: how long a facility's positions were staffed while a competition runs.
// Pure data logic only (no Discord code), so it can be tested offline. ironmicCommand.js does the Discord side.
//
// Totals come from vNAS Stats (https://vnas-stats.com, source at https://github.com/kengreim/vnas-stats).
// It groups time by callsign prefix and suffix, ignoring the middle part, so LEX_APP and LEX_N_APP are both
// "LEX APP" and two approach controllers on at once count once. Only active controllers count.

const STATS_URL = 'https://api.vnas-stats.com/v1/callsigns/top';
const MINUTE = 60_000;

// Position names staff type in /ironmic, in display order (top-down). suffixes are the callsign suffixes
// vNAS Stats groups by.
const POSITIONS = {
  center: { label: 'Center', suffixes: ['CTR'], aliases: ['ctr', 'enroute'] },
  approach: { label: 'Approach', suffixes: ['APP', 'DEP'], aliases: ['app', 'radar', 'tracon'] },
  local: { label: 'Local', suffixes: ['TWR'], aliases: ['tower', 'twr', 'lc'] },
  ground: { label: 'Ground', suffixes: ['GND'], aliases: ['gnd', 'gc'] },
  delivery: { label: 'Delivery', suffixes: ['DEL'], aliases: ['del', 'clearance', 'cd'] },
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
 * The vNAS Stats callsigns each position covers for a facility, worked out from the vNAS ARTCC data
 * (fetchFacilityIndex() in feed.js):
 *   center              the ARTCC's center positions, so LEX's center is IND_CTR
 *   approach            the TRACON over the facility: itself, or the parent of a tower under one, so
 *                       DAY's approach is CMH's (CMH_APP and DAY_APP). A tower with no TRACON has none.
 *   local/ground/delivery  the facility's own positions
 * Callsigns are cut to prefix and suffix the way vNAS Stats groups them, so IND_E_TWR and IND_W_TWR are
 * both IND_TWR. Without the data, each position is just <facility>_<suffix>.
 * @returns {Record<string, string[]>} position -> callsigns like 'CMH_APP', empty if the facility has none
 */
function resolveCallsigns(index, facilityId, keys) {
  const facilities = [...(index?.facilities?.values() ?? [])];
  const facility = facilities.find((f) => f.id === facilityId);
  if (!facility) return Object.fromEntries(keys.map((k) => [k, POSITIONS[k].suffixes.slice(0, 1).map((s) => `${facilityId}_${s}`)]));

  const parentOf = (f) => facilities.find((p) => p.childKeys.includes(f.key));
  let artcc = facility;
  while (artcc && artcc.positionType !== 'Artcc') artcc = parentOf(artcc);
  const tracon = [facility, parentOf(facility)].find((f) => f?.positionType === 'Tracon');
  const owner = { center: artcc, approach: tracon };

  const callsignsOf = new Map(); // facility key -> its position callsigns
  for (const [callsign, p] of index.positions ?? []) {
    if (!callsignsOf.has(p.key)) callsignsOf.set(p.key, []);
    callsignsOf.get(p.key).push(callsign);
  }

  return Object.fromEntries(
    keys.map((key) => {
      const source = key in owner ? owner[key] : facility;
      const names = new Set();
      for (const callsign of callsignsOf.get(source?.key) ?? []) {
        const parts = callsign.split('_');
        const suffix = parts[parts.length - 1];
        if (parts.length > 1 && POSITIONS[key].suffixes.includes(suffix)) names.add(`${parts[0]}_${suffix}`);
      }
      return [key, [...names].sort()];
    }),
  );
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
 * A position's time is the sum of its callsigns (CMH approach = CMH_APP + DAY_APP). The response ranks
 * the network's top callsigns by time, so a listed position gets its rank among the other callsigns and
 * the gap to the one just above it (or, at #1, its lead over #2). Callsigns with the same time share a
 * rank and count as tied; a tie for #1 has no lead. A position with none of its callsigns
 * listed had less time than the last one listed; that's kept as "under", rather than shown as zero.
 * @param {Record<string, string[]>} callsigns  resolveCallsigns() output
 * @returns {{ elapsedMs: number, fetchedAt: number, ranked: number,
 *   positions: Record<string, {ms: number, rank?: number, tied?: number, ahead?: {callsign: string, gapMs: number}, lead?: {callsign: string, gapMs: number}}|{underMs: number}> }}
 */
function readStats(stats, callsigns) {
  const list = [...(stats.callsigns ?? [])].sort((a, b) => b.durationSeconds - a.durationSeconds);
  const floor = list.length ? list[list.length - 1].durationSeconds * 1000 : 0;
  const name = (c) => `${c.prefix}_${c.suffix}`;
  const positions = {};
  for (const [key, names] of Object.entries(callsigns)) {
    const mine = list.filter((c) => names.includes(name(c)));
    if (!mine.length) {
      positions[key] = list.length ? { underMs: floor } : { ms: 0 };
      continue;
    }
    const seconds = mine.reduce((sum, c) => sum + c.durationSeconds, 0);
    const others = list.filter((c) => !mine.includes(c));
    const above = others.filter((c) => c.durationSeconds > seconds);
    const tied = others.filter((c) => c.durationSeconds === seconds).length;
    const t = { ms: seconds * 1000, rank: above.length + 1 };
    if (tied) t.tied = tied; // everyone on since the start has the same time, so early on most are tied
    const next = above[above.length - 1];
    if (next) t.ahead = { callsign: name(next), gapMs: (next.durationSeconds - seconds) * 1000 };
    else if (others[0] && !tied) t.lead = { callsign: name(others[0]), gapMs: (seconds - others[0].durationSeconds) * 1000 };
    positions[key] = t;
  }
  return {
    elapsedMs: (stats.actualElapsedDurationSeconds ?? 0) * 1000,
    ranked: list.length,
    fetchedAt: Date.parse(stats.requestedAt) || Date.now(),
    positions,
  };
}

/** Midnight UTC on the 1st of the month `ms` falls in. An Iron Mic always counts from there. */
function monthStart(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

/** A fresh competition, saved as-is to ironmic.json. */
function newCompetition({ facilityId, facilityName = null, positions, callsigns, channelId, startedAt }) {
  return {
    facilityId,
    facilityName,
    positions,
    callsigns, // resolveCallsigns() output, fixed for the whole run
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
      if (t.tied) rank += ` · tied with ${t.tied} other${t.tied === 1 ? '' : 's'}`;
      if (t.ahead) rank += ` · ${formatDuration(t.ahead.gapMs)} behind ${t.ahead.callsign}`;
      else if (t.lead) rank += ` · ${formatDuration(t.lead.gapMs)} ahead of ${t.lead.callsign}`;
      lines.push(rank);
    }
    if (ended && !comp.final) lines.push('*Fetching the final totals…*');

    const position = `${POSITIONS[key].label} (${comp.callsigns[key].join(', ')})`;
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
  resolveCallsigns,
  statsUrl,
  fetchStats,
  readStats,
  monthStart,
  newCompetition,
  formatDuration,
  competitionEmbeds,
};
