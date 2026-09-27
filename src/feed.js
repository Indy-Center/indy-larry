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
function groupByFacility(feed, { artccIds = [], includeInactive = false } = {}) {
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
      // Any extra positions this controller is covering (e.g. IND_DRE also working IND_DRW)
      extraPositions: c.positions
        .filter((p) => p !== primary)
        .map((p) => ({ callsign: p.defaultCallsign, positionName: p.positionName, frequency: p.frequency })),
      loginTime: new Date(c.loginTime),
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

/** 127350000 -> "127.350" */
function formatFrequency(hz) {
  if (!hz || hz === 199998000) return null;
  return (hz / 1_000_000).toFixed(3);
}

const ARTCC_DATA_URL = 'https://data-api.vnas.vatsim.net/api/artccs/';
const BOOKINGS_URL = 'https://atc-bookings.vatsim.net/api/booking';

/**
 * Builds a callsign -> facility lookup from the vNAS ARTCC data, so bookings
 * (which only carry a callsign) can be tied to a facility, e.g. DAY_M_APP -> CMH.
 */
async function fetchFacilityIndex(artccIds) {
  const index = new Map();
  for (const artccId of artccIds) {
    const res = await fetch(ARTCC_DATA_URL + artccId, { headers: { 'User-Agent': 'vnas-discord-bot' } });
    if (!res.ok) throw new Error(`ARTCC data request for ${artccId} failed: HTTP ${res.status}`);
    const data = await res.json();

    const walk = (facility) => {
      // Data API uses "AtctTracon"; the controller feed calls the same thing "Tracon".
      const positionType = facility.type === 'AtctTracon' ? 'Tracon' : facility.type;
      for (const p of facility.positions ?? []) {
        index.set(p.callsign, {
          key: `${artccId}:${facility.id}`,
          artccId,
          facilityId: facility.id,
          facilityName: facility.name,
          positionType,
          positionName: p.name,
        });
      }
      (facility.childFacilities ?? []).forEach(walk);
    };
    walk(data.facility);
  }
  return index;
}

/** Returns bookings for positions in the facility index, with parsed UTC dates. */
async function fetchBookings(index) {
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
  FEED_URL, fetchFeed, groupByFacility, formatFrequency, fetchFacilityIndex, fetchBookings, CONTROLLER_ORDER,
};
