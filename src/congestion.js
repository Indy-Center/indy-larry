// Airspace congestion: how many aircraft are in the ARTCC and each TRACON, how many are about to enter,
// and whether an area is busy with nobody (or too few people) working it. Pure data logic plus the fetches,
// no Discord code, so it can be tested offline.
//
// Aircraft come from the VATSIM v3 data feed (every connected pilot, tuned to anyone or not). Boundaries come
// from the VAT-Spy Data Project (ARTCCs, e.g. KZID) and the SimAware TRACON Project (IND, SDF, CVG, ...).

const PILOTS_URL = 'https://data.vatsim.net/v3/vatsim-data.json';
const ARTCC_BOUNDARIES_URL = 'https://raw.githubusercontent.com/vatsimnetwork/vatspy-data-project/master/Boundaries.geojson';
const traconBoundaryUrl = (id) =>
  `https://raw.githubusercontent.com/vatsimnetwork/simaware-tracon-project/main/Boundaries/${id}/${id}.json`;

const HIGH_FT = 24000; // FL240: the low/high split shown for the ARTCC
const MIN_GROUNDSPEED_KT = 50; // slower than this is on the ground (parked, taxiing) and isn't counted
const ALERT_MODES = ['off', 'uncovered', 'overloaded', 'both'];

const UA = { headers: { 'User-Agent': 'vnas-discord-bot' } };

async function fetchPilots(url = PILOTS_URL) {
  const res = await fetch(url, UA);
  if (!res.ok) throw new Error(`VATSIM data request failed: HTTP ${res.status}`);
  return (await res.json()).pilots ?? [];
}

/**
 * The areas to watch: each ARTCC (VAT-Spy id K + ARTCC id, e.g. ZID -> KZID) and each TRACON that SimAware has.
 * A TRACON SimAware doesn't know (HTTP 404) is skipped; any other failure throws, so the caller keeps its last copy.
 * @returns {Promise<{key: string, name: string, kind: 'enroute'|'tracon', prefixes: string[], geometry: object}[]>}
 */
async function fetchAreas(artccIds, traconIds) {
  const areas = [];

  const res = await fetch(ARTCC_BOUNDARIES_URL, UA);
  if (!res.ok) throw new Error(`ARTCC boundaries request failed: HTTP ${res.status}`);
  const { features = [] } = await res.json();
  for (const artccId of artccIds) {
    const f = features.find((x) => x.properties?.id === `K${artccId}` || x.properties?.id === artccId);
    if (f) areas.push({ key: artccId, name: artccId, kind: 'enroute', prefixes: [artccId], geometry: f.geometry });
    else console.warn(`No boundary for ${artccId} in the VAT-Spy data.`);
  }

  for (const id of traconIds) {
    const r = await fetch(traconBoundaryUrl(id), UA);
    if (r.status === 404) continue;
    if (!r.ok) throw new Error(`TRACON boundary request for ${id} failed: HTTP ${r.status}`);
    const data = await r.json();
    const list = data.type === 'FeatureCollection' ? data.features : [data];
    // A folder can hold extra files (e.g. a DEP-only area); the <id>.json feature is the TRACON itself.
    const f = list.find((x) => x.geometry && !x.properties?.suffix) ?? list[0];
    if (!f?.geometry) continue;
    areas.push({ key: id, name: `${id} TRACON`, kind: 'tracon', prefixes: f.properties?.prefix ?? [id], geometry: f.geometry });
  }
  return areas;
}

/** Ray casting on one ring of [lon, lat] points. */
function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True if the point is inside a GeoJSON Polygon or MultiPolygon (holes respected). */
function pointInGeometry(lon, lat, geometry) {
  if (!geometry) return false;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  return polygons.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((h) => inRing(lon, lat, h)));
}

/** Where an aircraft will be after `minutes` on its current heading and groundspeed (flat-earth, fine for 15 minutes). */
function project(p, minutes) {
  const nm = (p.groundspeed * minutes) / 60;
  const rad = (p.heading * Math.PI) / 180;
  const lat = p.latitude + (nm * Math.cos(rad)) / 60;
  const lon = p.longitude + (nm * Math.sin(rad)) / (60 * Math.cos((p.latitude * Math.PI) / 180));
  return { lat, lon };
}

/**
 * Counts airborne aircraft in each area, plus those projected to enter it within `lookaheadMin`.
 * @returns {{ key, name, kind, prefixes, inside: number, entering: number, high?: number, low?: number }[]}
 */
function summarize(pilots, areas, { lookaheadMin = 15 } = {}) {
  const airborne = pilots.filter(
    (p) => Number.isFinite(p.latitude) && Number.isFinite(p.longitude) && p.groundspeed >= MIN_GROUNDSPEED_KT,
  );
  const steps = [];
  for (let m = 5; m < lookaheadMin; m += 5) steps.push(m);
  if (lookaheadMin > 0) steps.push(lookaheadMin);

  return areas.map((area) => {
    let inside = 0;
    let entering = 0;
    let high = 0;
    for (const p of airborne) {
      if (pointInGeometry(p.longitude, p.latitude, area.geometry)) {
        inside++;
        if (p.altitude >= HIGH_FT) high++;
      } else if (steps.some((m) => { const q = project(p, m); return pointInGeometry(q.lon, q.lat, area.geometry); })) {
        entering++;
      }
    }
    const out = { key: area.key, name: area.name, kind: area.kind, prefixes: area.prefixes, inside, entering };
    if (area.kind === 'enroute') Object.assign(out, { high, low: inside - high });
    return out;
  });
}

/**
 * Who is working each area right now, from groupByFacility() output (active controllers only).
 * ARTCC: its centers. TRACON: approach/departure controllers whose callsign prefix the boundary lists.
 * `topDown` marks a TRACON with no approach controller but a center above it.
 */
function staffing(summary, facilities) {
  const active = facilities.flatMap((f) => f.controllers).filter((c) => c.isActive !== false);
  const centers = active.filter((c) => c.facilityType === 'Center').length;
  return summary.map((a) => {
    if (a.kind === 'enroute') return { ...a, staff: centers, topDown: false };
    const staff = active.filter(
      (c) => c.facilityType === 'ApproachDeparture' && a.prefixes.includes(String(c.callsign).split('_')[0]),
    ).length;
    return { ...a, staff, topDown: staff === 0 && centers > 0 };
  });
}

/**
 * Decides which areas should alert, and updates the per-area memory (same shape and rules as the busy-frequency alert).
 *   uncovered:  nobody on it (no center above a TRACON either) and inside + entering >= threshold
 *   overloaded: someone on it, and (inside + entering) per controller >= threshold
 * @param {Record<string, {tripped: boolean, firedAt: number}>} memory  area key -> state; updated in place
 * @param {object[]} staffed  staffing() output
 * @param {{mode: string, thresholds: {enroute?: number, tracon?: number}, cooldownMs: number, hysteresis: number}} opts
 * @returns {{ fire: object[], changed: boolean }}  fired areas carry `reason` ('uncovered' | 'overloaded') and `total`
 */
function evaluateCongestion(memory, staffed, now, { mode = 'off', thresholds = {}, cooldownMs = 0, hysteresis = 0 } = {}) {
  const fire = [];
  let changed = false;
  if (mode === 'off') return { fire, changed };

  for (const a of staffed) {
    const threshold = thresholds[a.kind];
    if (!threshold) continue;
    const total = a.inside + a.entering;
    let reason = null;
    let load = 0;
    if (a.staff === 0 && !a.topDown) {
      if (mode === 'uncovered' || mode === 'both') ({ reason, load } = { reason: 'uncovered', load: total });
    } else if (a.staff > 0 && (mode === 'overloaded' || mode === 'both')) {
      ({ reason, load } = { reason: 'overloaded', load: total / a.staff });
    }

    const m = memory[a.key];
    if (reason && load >= threshold) {
      if (m?.tripped || (m && now - m.firedAt < cooldownMs)) continue;
      memory[a.key] = { tripped: true, firedAt: now };
      fire.push({ ...a, reason, total });
      changed = true;
    } else if (m?.tripped && (!reason || load < threshold - hysteresis)) {
      m.tripped = false;
      changed = true;
    }
  }
  return { fire, changed };
}

module.exports = {
  PILOTS_URL, ALERT_MODES, fetchPilots, fetchAreas, pointInGeometry, project, summarize, staffing, evaluateCongestion,
};
