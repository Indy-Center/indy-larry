// Counts the aircraft tuned to each online controller position, and decides when a position
// is busy enough to ask for help. Pure data logic only — no Discord code here, so it can be tested offline.
//
// The VATSIM v3 pilot feed has no tuned frequency; the transceivers feed does. It lists every
// connection (pilots and ATC) with the frequency and location of each radio, so an aircraft counts
// for a position when one of its radios is on the position's frequency and close to one of the
// controller's radios. That keeps out-of-area aircraft and the other airport's ground/tower
// (same frequency, different place) out of the count without any airport or boundary data.

const TRANSCEIVERS_URL = 'https://data.vatsim.net/v3/transceivers-data.json';

const GUARD_KHZ = 121500;
const NO_FREQUENCY_HZ = 199998000; // vNAS placeholder for "no frequency"

// Controller facility type (from the controller feed) -> the area it belongs to for radius and threshold.
const AREA_BY_TYPE = {
  ClearanceDelivery: 'cab',
  Ground: 'cab',
  Tower: 'cab',
  ApproachDeparture: 'tracon',
  Center: 'enroute',
};

// How far from a controller's radio an aircraft can be and still count, in nautical miles.
const DEFAULT_RADIUS_NM = { cab: 10, tracon: 60, enroute: 250 };

// ATC and other non-aircraft connections in the transceivers feed.
const NON_AIRCRAFT = /_(OBS|ATIS|DEL|GND|RMP|TWR|APP|DEP|CTR|FSS|TMU|SUP)$/;

async function fetchTransceivers(url = TRANSCEIVERS_URL) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vnas-discord-bot' } });
  if (!res.ok) throw new Error(`Transceivers request failed: HTTP ${res.status}`);
  return res.json();
}

/** Great-circle distance in nautical miles. */
function haversineNm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.latDeg - a.latDeg);
  const dLon = rad(b.lonDeg - a.lonDeg);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latDeg)) * Math.cos(rad(b.latDeg)) * Math.sin(dLon / 2) ** 2;
  return 2 * 3440.065 * Math.asin(Math.sqrt(h));
}

const toKhz = (hz) => Math.round(hz / 1000);

/**
 * Every frequency being worked, one entry per frequency: a controller's primary position and each
 * secondary position they are actively covering.
 * @param {object[]} facilities  groupByFacility() output
 * @returns {{ callsign: string, controllerCallsign: string, positionName: string, facilityType: string, area: string|null, frequency: number }[]}
 */
function listPositions(facilities) {
  const out = [];
  for (const f of facilities) {
    for (const c of f.controllers) {
      const base = { controllerCallsign: c.callsign, facilityType: c.facilityType, area: AREA_BY_TYPE[c.facilityType] ?? null };
      const positions = [{ callsign: c.callsign, positionName: c.positionName, frequency: c.frequency }, ...c.extraPositions];
      for (const p of positions) {
        if (!p.frequency || p.frequency === NO_FREQUENCY_HZ || toKhz(p.frequency) === GUARD_KHZ) continue;
        out.push({ ...base, callsign: p.callsign ?? c.callsign, positionName: p.positionName, frequency: p.frequency });
      }
    }
  }
  return out;
}

/**
 * Adds `count` (aircraft tuned to the position and within range of it) to each position.
 * @param {object[]} positions       listPositions() output
 * @param {object[]} transceivers    Parsed transceivers-data.json
 * @param {object}   opts
 * @param {Set<string>} opts.atcCallsigns   Connections to leave out of the count (everyone controlling, per the controller feed)
 * @param {{cab?: number, tracon?: number, enroute?: number}} opts.radiusNm
 * @returns {object[]} the positions with `count`, same order
 */
function countAircraft(positions, transceivers, { atcCallsigns = new Set(), radiusNm = {} } = {}) {
  const radius = { ...DEFAULT_RADIUS_NM, ...radiusNm };

  const byCallsign = new Map(transceivers.map((t) => [t.callsign, t.transceivers ?? []]));
  const aircraft = transceivers.filter((t) => !atcCallsigns.has(t.callsign) && !NON_AIRCRAFT.test(t.callsign));

  return positions.map((p) => {
    // Where the controller is transmitting from on this frequency; if the feed doesn't say, any of their radios.
    const own = byCallsign.get(p.controllerCallsign) ?? [];
    const sites = own.filter((t) => toKhz(t.frequency) === toKhz(p.frequency));
    const origins = sites.length ? sites : own;
    const maxNm = radius[p.area] ?? radius.cab;

    const tuned = new Set();
    for (const a of aircraft) {
      const near = (a.transceivers ?? []).some(
        (t) => toKhz(t.frequency) === toKhz(p.frequency) && origins.some((o) => haversineNm(o, t) <= maxNm),
      );
      if (near) tuned.add(a.callsign); // once per aircraft, even with the same frequency on COM1 and COM2
    }
    return { ...p, count: tuned.size };
  });
}

/**
 * Decides which positions should ask for help right now, and updates the per-position memory.
 * A position fires once when its count reaches its threshold. It can't fire again until the count
 * has dropped below threshold - hysteresis (so a count bouncing around the line doesn't repeat)
 * and the cooldown has passed.
 * @param {Record<string, {tripped: boolean, firedAt: number}>} memory  callsign -> state; updated in place
 * @param {object[]} counted   countAircraft() output
 * @param {number} now         ms
 * @param {{thresholds: {cab?: number, tracon?: number, enroute?: number}, cooldownMs: number, hysteresis: number}} opts
 *   A missing or 0 threshold turns the alert off for that area.
 * @returns {{ fire: object[], changed: boolean }}
 */
function evaluateHelp(memory, counted, now, { thresholds = {}, cooldownMs = 0, hysteresis = 0 } = {}) {
  const fire = [];
  let changed = false;
  const online = new Set();

  for (const p of counted) {
    online.add(p.callsign);
    const threshold = thresholds[p.area];
    if (!threshold) continue;
    const m = memory[p.callsign];

    if (p.count >= threshold) {
      if (m?.tripped || (m && now - m.firedAt < cooldownMs)) continue;
      memory[p.callsign] = { tripped: true, firedAt: now };
      fire.push(p);
      changed = true;
    } else if (m?.tripped && p.count < threshold - hysteresis) {
      m.tripped = false;
      changed = true;
    }
  }

  // Forget positions that went offline once their cooldown is over, so the memory doesn't grow forever.
  for (const [callsign, m] of Object.entries(memory)) {
    if (!online.has(callsign) && now - m.firedAt >= cooldownMs) {
      delete memory[callsign];
      changed = true;
    }
  }
  return { fire, changed };
}

module.exports = {
  TRANSCEIVERS_URL, DEFAULT_RADIUS_NM, AREA_BY_TYPE, fetchTransceivers, haversineNm, listPositions, countAircraft, evaluateHelp,
};
