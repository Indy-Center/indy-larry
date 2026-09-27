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
  update(facilities, bookings, now = new Date()) {
    const entries = [];
    const onlineKeys = new Set();

    for (const f of facilities) {
      onlineKeys.add(f.key);
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
const CLOSING_PHRASE =
  /\b(closing|close at|signing off|signing out|logging off|logging out|log(ging)? ?off|going offline|offline (at|in)|off at|leaving (at|in))\b/i;

/**
 * Looks for a closing announcement in controller info text.
 *   "Closing at 0200z" / "closing 02:00Z" -> that time (today, or tomorrow if it has passed)
 *   "Closing in 15 min"                   -> now + 15 min
 *   "Closing soon" / "Closing shortly"    -> { at: null }
 * @returns {{ at: Date|null } | null}
 */
function parseClosing(info, now = new Date()) {
  if (!info) return null;
  for (const line of info.split(/\r?\n/)) {
    const phrase = line.match(CLOSING_PHRASE);
    if (!phrase) continue;
    const rest = line.slice(phrase.index);

    const zulu = rest.match(/\b([01]\d|2[0-3]):?([0-5]\d)\s*(z|zulu|utc)\b/i);
    if (zulu) {
      const at = new Date(now);
      at.setUTCHours(Number(zulu[1]), Number(zulu[2]), 0, 0);
      // "0200z" said at 2330z means tomorrow; a time up to an hour ago means they're running over.
      if (now - at > 60 * MINUTE) at.setUTCDate(at.getUTCDate() + 1);
      return { at };
    }

    const rel = rest.match(/\bin\s+(\d{1,3})\s*(m|min|mins|minutes?|h|hr|hrs|hours?)\b/i);
    if (rel) {
      const mins = Number(rel[1]) * (/^h/i.test(rel[2]) ? 60 : 1);
      return { at: new Date(+now + mins * MINUTE) };
    }

    return { at: null };
  }
  return null;
}

module.exports = { StatusBoard, parseClosing };
