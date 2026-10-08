// Decides each facility's status (online / closing / planned / offline) from the
// live controllers plus ATC bookings. Keeps a little memory of recently closed
// facilities so they can show as "offline" for a while before disappearing.

const TYPE_ORDER = { Artcc: 0, Tracon: 1, Atct: 2 };
const MINUTE = 60_000;

class StatusBoard {
  constructor({ plannedHours = 3, closingMinutes = 15, offlineMinutes = 30 } = {}) {
    this.plannedMs = plannedHours * 60 * MINUTE;
    this.closingMs = closingMinutes * MINUTE;
    this.offlineMs = offlineMinutes * MINUTE;
    this.lastOnline = new Map(); // key -> { facility, lastSeen }
  }

  /**
   * @param {object[]} facilities  Output of groupByFacility()
   * @param {object[]} bookings    Output of fetchBookings() (may be empty)
   * @param {Date} now
   * @returns {object[]} entries: { key, status, facilityName, positionType, facility?, bookings?, closingAt?, closedAt? }
   */
  update(facilities, bookings, now = new Date(), facilityTree = null) {
    const entries = [];
    const online = new Map(facilities.map((f) => [f.key, f]));
    const onlineKeys = new Set(online.keys());

    for (const f of facilities) {
      this.lastOnline.set(f.key, { facility: f, lastSeen: now });

      // Each controller can be closing on their own (from their info text or their booking).
      // The whole facility only goes yellow when everyone on it is closing.
      for (const c of f.controllers) c.closing = this.controllerClosing(c, f.key, bookings, now);
      const closing = f.controllers.every((c) => c.closing);
      const times = f.controllers.map((c) => c.closing?.at).filter(Boolean);

      entries.push({
        key: f.key,
        status: closing ? 'closing' : 'online',
        facilityName: f.facilityName,
        positionType: f.positionType,
        facility: f,
        closingAt: closing && times.length ? new Date(Math.max(...times)) : null,
        topDown: topDownCoverage(f, online, facilityTree),
      });
    }

    // Planned = not online, but a booking is running or starts within the window.
    const planned = new Map();
    for (const b of bookings) {
      if (onlineKeys.has(b.key)) continue;
      if (b.end <= now || b.start - now > this.plannedMs) continue;
      if (!planned.has(b.key)) {
        planned.set(b.key, { key: b.key, status: 'planned', facilityName: b.facilityName, positionType: b.positionType, bookings: [] });
      }
      planned.get(b.key).bookings.push(b);
    }
    for (const p of planned.values()) {
      p.bookings.sort((a, b) => a.start - b.start || a.callsign.localeCompare(b.callsign));
      entries.push(p);
    }

    // Offline = was online recently (and nothing is planned there).
    for (const [key, { facility, lastSeen }] of this.lastOnline) {
      if (onlineKeys.has(key)) continue;
      if (now - lastSeen > this.offlineMs) {
        this.lastOnline.delete(key);
        continue;
      }
      if (planned.has(key)) continue;
      entries.push({
        key,
        status: 'offline',
        facilityName: facility.facilityName,
        positionType: facility.positionType,
        facility,
        closedAt: lastSeen,
      });
    }

    return this.sort(entries);
  }

  /** Returns { at: Date|null, source: 'info'|'booking' } if this controller is closing soon, else null. */
  controllerClosing(c, key, bookings, now) {
    const announced = parseClosing(c.info, now);
    if (announced && (!announced.at || announced.at - now <= this.closingMs)) return { ...announced, source: 'info' };

    const end = currentBookingEnd(bookings, key, c.cid, now);
    if (end && end - now <= this.closingMs) return { at: end, source: 'booking' };
    return null;
  }

  sort(entries) {
    return entries.sort(
      (a, b) =>
        a.key.split(':')[0].localeCompare(b.key.split(':')[0]) ||
        (TYPE_ORDER[a.positionType] ?? 9) - (TYPE_ORDER[b.positionType] ?? 9) ||
        a.facilityName.localeCompare(b.facilityName),
    );
  }
}

/**
 * TRACONs a center covers top-down: every TRACON under it in the ARTCC's tree without an active
 * radar (approach/departure) controller. A TRACON with only its tower, ground or delivery on
 * still counts, since center is working its radar. Only an active center covers anything, and
 * only centers get this list; towers are never listed.
 * @param {object} facility  An online facility from groupByFacility()
 * @param {Map} online       Online facilities by key
 * @returns {{ id: string, name: string }[]}
 */
function topDownCoverage(facility, online, facilityTree) {
  const node = facilityTree?.get(facility.key);
  if (!node || facility.positionType !== 'Artcc') return [];
  if (!facility.controllers.some((c) => c.isActive)) return [];

  const hasActiveRadar = (key) =>
    online.get(key)?.controllers.some((c) => c.isActive && c.facilityType === 'ApproachDeparture') ?? false;

  const tracons = [];
  const walk = (key) => {
    const f = facilityTree.get(key);
    if (!f) return;
    if (f.positionType === 'Tracon' && !hasActiveRadar(key)) tracons.push({ id: f.id, name: f.name });
    f.childKeys.forEach(walk);
  };
  node.childKeys.forEach(walk);
  return tracons.sort((a, b) => a.id.localeCompare(b.id));
}

/** End time of the booking this controller is currently working at this facility, if any. */
function currentBookingEnd(bookings, key, cid, now) {
  const mine = bookings.filter(
    (b) => b.key === key && b.cid === String(cid) && b.start - now <= 30 * MINUTE && now - b.end <= 60 * MINUTE,
  );
  if (!mine.length) return null;
  return new Date(Math.max(...mine.map((b) => b.end)));
}

// Phrases that mean the controller is leaving. Deliberately strict: controller info
// is full of things like "RWY 27 closed" or "solo cert valid until 11/10".
// SOP format is "Online until 8pm ET (2400z)"; the older "Closing at 0200z" style still works.
const CLOSING_PHRASE =
  /\b(online until|on until|closing|close at|signing off|logging off|going offline|offline at|off at|leaving at)\b/i;

/**
 * Looks for a closing announcement in controller info text.
 *   "Online until 8pm ET (2400z)" -> 0000z (the zulu time wins when both are given)
 *   "Online until 8:30pm ET"      -> converted from the zone given (ET, CT, MT or PT)
 *   "Closing at 0200z"            -> 0200z
 *   "Closing in 15 min"           -> now + 15 min
 * Anything without a readable time ("Closing soon", "Closing at ???") returns null.
 * Times that have passed today are read as tomorrow, unless they're under an hour ago
 * (the controller is running over).
 * @returns {{ at: Date } | null}
 */
function parseClosing(info, now = new Date()) {
  if (!info) return null;
  for (const line of info.split(/\r?\n/)) {
    const phrase = line.match(CLOSING_PHRASE);
    if (!phrase) continue;
    const rest = line.slice(phrase.index);

    // 0000-2400, with optional colon, followed by z/zulu/utc
    const zulu = rest.match(/\b([01]\d|2[0-4]):?([0-5]\d)\s*(z|zulu|utc)\b/i);
    if (zulu) return { at: nextOccurrence(Number(zulu[1]) % 24, Number(zulu[2]), 0, now) };

    // 8pm ET / 8:30 pm CST / 20:00 PDT
    const local = rest.match(
      /\b(\d{1,2})(?::([0-5]\d))?\s*(am|pm)?\s*(et|ct|mt|pt|[ecmp][sd]t|eastern|central|mountain|pacific)\b/i,
    );
    if (local) {
      let hour = Number(local[1]);
      const ampm = local[3]?.toLowerCase();
      if (ampm === 'pm' && hour < 12) hour += 12;
      if (ampm === 'am' && hour === 12) hour = 0;
      if (hour <= 24) return { at: nextOccurrence(hour % 24, Number(local[2] ?? 0), zoneOffsetHours(local[4], now), now) };
    }

    const rel = rest.match(/\bin\s+(\d{1,3})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\b/i);
    if (rel) {
      const mins = Number(rel[1]) * (/^h/i.test(rel[2]) ? 60 : 1);
      return { at: new Date(+now + mins * MINUTE) };
    }

    // No usable time (e.g. "Closing at ???"): don't treat the controller as closing.
  }
  return null;
}

/** Next time the clock reads hour:minute in a zone offsetHours from UTC (e.g. -4 for EDT). */
function nextOccurrence(hour, minute, offsetHours, now) {
  const at = new Date(now);
  at.setUTCHours(hour - offsetHours, minute, 0, 0);
  while (now - at > 60 * MINUTE) at.setUTCDate(at.getUTCDate() + 1);
  while (at - now > 23 * 60 * MINUTE) at.setUTCDate(at.getUTCDate() - 1);
  return at;
}

const US_ZONES = {
  e: 'America/New_York',
  c: 'America/Chicago',
  m: 'America/Denver',
  p: 'America/Los_Angeles',
};

/** Current offset from UTC for a US zone abbreviation or name (ET, CST, Pacific...); follows daylight saving. */
function zoneOffsetHours(zone, now) {
  const timeZone = US_ZONES[zone[0].toLowerCase()];
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' })
    .formatToParts(now)
    .find((p) => p.type === 'timeZoneName').value; // e.g. "GMT-4"
  return Number(name.replace('GMT', '')) || 0;
}

module.exports = { StatusBoard, parseClosing };
