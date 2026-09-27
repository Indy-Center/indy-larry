// Fetches the vNAS controller feed and groups controllers by facility.
// Pure data logic only — no Discord code here, so it can be tested offline.

const FEED_URL = 'https://live.env.vnas.vatsim.net/data-feed/controllers.json';

// Display order for facility types: center first, then TRACONs, then towers.
const TYPE_ORDER = { Artcc: 0, Tracon: 1, Atct: 2 };

// Order of controllers inside an embed: radar first, clearance last.
const CONTROLLER_ORDER = {
  Center: 0, ApproachDeparture: 1, Tower: 2, Ground: 3, ClearanceDelivery: 4, FlightServiceStation: 5,
};

const RATING_SHORT = {
  Observer: 'OBS', Student1: 'S1', Student2: 'S2', Student3: 'S3',
  Controller1: 'C1', Controller2: 'C2', Controller3: 'C3',
  Instructor1: 'I1', Instructor2: 'I2', Instructor3: 'I3',
  Supervisor: 'SUP', Administrator: 'ADM',
};

async function fetchFeed(url = FEED_URL) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vnas-discord-bot' } });
  if (!res.ok) throw new Error(`Feed request failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * Turns the raw feed into a sorted list of facilities, each with its controllers.
 * @param {object} feed        Parsed controllers.json
 * @param {object} opts
 * @param {string[]} opts.artccIds      Only include these ARTCCs (empty = all)
 * @param {boolean}  opts.includeInactive Include controllers who are connected but not active
 */
function groupByFacility(feed, { artccIds = [], includeInactive = false, activeSince = new Map() } = {}) {
  const facilities = new Map();

  for (const c of feed.controllers ?? []) {
    if (c.isObserver) continue;
    if (!includeInactive && !c.isActive) continue;
    if (artccIds.length && !artccIds.includes(c.artccId)) continue;

    const primary = c.positions.find((p) => p.isPrimary) ?? c.positions[0];
    if (!primary) continue;

    const key = `${c.artccId}:${primary.facilityId}`;
    if (!facilities.has(key)) {
      facilities.set(key, {
        key,
        artccId: c.artccId,
        facilityId: primary.facilityId,
        facilityName: primary.facilityName,
        positionType: primary.positionType,
        controllers: [],
      });
    }

    facilities.get(key).controllers.push({
      cid: c.vatsimData.cid,
      name: c.vatsimData.realName,
      rating: RATING_SHORT[c.vatsimData.requestedRating] ?? c.vatsimData.requestedRating,
      callsign: c.vatsimData.callsign || primary.defaultCallsign,
      facilityType: c.vatsimData.facilityType,
      info: c.vatsimData.controllerInfo,
      positionName: primary.positionName,
      frequency: primary.frequency,
      isActive: c.isActive,
      // Secondary positions this controller is actually working. The feed also lists every
      // controlling display in their CRC profile (e.g. a center's STARS displays for each TRACON)
      // as a secondary position, marked inactive; those aren't coverage, so they're skipped.
      extraPositions: c.positions
        .filter((p) => p !== primary && p.isActive)
        .map((p) => ({ callsign: p.defaultCallsign, positionName: p.positionName, frequency: p.frequency })),
      loginTime: new Date(c.loginTime),
      activeSince: activeSince.has(sessionKey(c)) ? new Date(activeSince.get(sessionKey(c))) : null,
    });
  }

  const list = [...facilities.values()];
  for (const f of list) {
    f.controllers.sort(
      (a, b) =>
        (CONTROLLER_ORDER[a.facilityType] ?? 9) - (CONTROLLER_ORDER[b.facilityType] ?? 9) ||
        a.callsign.localeCompare(b.callsign),
    );
    f.onlineSince = new Date(Math.min(...f.controllers.map((c) => c.loginTime)));
  }
  list.sort(
    (a, b) =>
      a.artccId.localeCompare(b.artccId) ||
      (TYPE_ORDER[a.positionType] ?? 9) - (TYPE_ORDER[b.positionType] ?? 9) ||
      a.facilityName.localeCompare(b.facilityName),
  );
  return list;
}

/** One controller connection; a reconnect gets a new login time and so a new key. */
function sessionKey(c) {
  return `${c.vatsimData.cid}|${c.loginTime}`;
}

/**
 * Records when each controller went active. The feed only has connect time, so the
 * bot notes the first check where a controller shows as active. Going inactive clears
 * it, so re-activating starts the clock again.
 * On the first check after the bot starts, a controller who is already active with no
 * saved time gets their connect time, since the real activation time can't be known.
 * @param {Map<string,string>} activeSince  sessionKey -> ISO time; updated in place
 * @param {string[]} artccIds  Only track these ARTCCs (empty = all)
 * @returns {boolean} whether anything changed (so the caller can save it)
 */
function trackActivations(feed, activeSince, now, firstRefresh, artccIds = []) {
  let changed = false;
  const seen = new Set();
  for (const c of feed.controllers ?? []) {
    if (artccIds.length && !artccIds.includes(c.artccId)) continue;
    const key = sessionKey(c);
    seen.add(key);
    if (c.isActive && !activeSince.has(key)) {
      activeSince.set(key, firstRefresh ? c.loginTime : now.toISOString());
      changed = true;
    } else if (!c.isActive && activeSince.has(key)) {
      activeSince.delete(key);
      changed = true;
    }
  }
  for (const key of activeSince.keys()) {
    if (!seen.has(key)) {
      activeSince.delete(key);
      changed = true;
    }
  }
  return changed;
}

/** 127350000 -> "127.350" */
function formatFrequency(hz) {
  if (!hz || hz === 199998000) return null;
  return (hz / 1_000_000).toFixed(3);
}

const ARTCC_DATA_URL = 'https://data-api.vnas.vatsim.net/api/artccs/';
const BOOKINGS_URL = 'https://atc-bookings.vatsim.net/api/booking';

/**
 * Reads the vNAS ARTCC data into two lookups:
 *   positions:  callsign -> facility, so bookings (which only carry a callsign) can be tied
 *               to a facility, e.g. DAY_M_APP -> CMH.
 *   facilities: facility key -> { id, name, positionType, childKeys }, the ARTCC's tree of
 *               center -> TRACONs -> towers, used for top-down coverage.
 */
async function fetchFacilityIndex(artccIds) {
  const positions = new Map();
  const facilities = new Map();
  for (const artccId of artccIds) {
    const res = await fetch(ARTCC_DATA_URL + artccId, { headers: { 'User-Agent': 'vnas-discord-bot' } });
    if (!res.ok) throw new Error(`ARTCC data request for ${artccId} failed: HTTP ${res.status}`);
    const data = await res.json();

    const walk = (facility) => {
      const key = `${artccId}:${facility.id}`;
      // Data API uses "AtctTracon"; the controller feed calls the same thing "Tracon".
      const positionType = facility.type === 'AtctTracon' ? 'Tracon' : facility.type;
      const children = facility.childFacilities ?? [];
      facilities.set(key, {
        key,
        id: facility.id,
        name: facility.name,
        positionType,
        childKeys: children.map((c) => `${artccId}:${c.id}`),
      });
      for (const p of facility.positions ?? []) {
        positions.set(p.callsign, {
          key,
          artccId,
          facilityId: facility.id,
          facilityName: facility.name,
          positionType,
          positionName: p.name,
        });
      }
      children.forEach(walk);
    };
    walk(data.facility);
  }
  return { positions, facilities };
}

/** Returns bookings for positions in the facility index, with parsed UTC dates. */
async function fetchBookings({ positions: index }) {
  const res = await fetch(BOOKINGS_URL, { headers: { 'User-Agent': 'vnas-discord-bot' } });
  if (!res.ok) throw new Error(`Bookings request failed: HTTP ${res.status}`);
  const parseUtc = (s) => new Date(s.replace(' ', 'T') + 'Z');

  return (await res.json())
    .filter((b) => index.has(b.callsign))
    .map((b) => ({
      ...index.get(b.callsign),
      callsign: b.callsign,
      cid: String(b.cid),
      type: b.type,
      start: parseUtc(b.start),
      end: parseUtc(b.end),
    }));
}

module.exports = {
  FEED_URL, fetchFeed, groupByFacility, trackActivations, formatFrequency, fetchFacilityIndex, fetchBookings, CONTROLLER_ORDER,
};
