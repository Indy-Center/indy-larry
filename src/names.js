// Position labels from the Indy Center CMS catalogue, resolved the way Centerline does it
// (https://centerline.flyindycenter.com/helpers/positions and /helpers/aviation, resolvePosition), so the bot
// and the Indy Center apps name a position the same way. Pure lookup logic plus one fetch, so it can be tested
// offline. Callsigns stay the identity everywhere else; these are only labels, and anything the CMS doesn't
// know keeps its callsign.

const CMS_POSITIONS_URL = 'https://cms.flyindycenter.com/api/public/v1/positions';

async function fetchCmsPositions(url = CMS_POSITIONS_URL) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vnas-discord-bot' } });
  if (!res.ok) throw new Error(`CMS positions request failed: HTTP ${res.status}`);
  return res.json();
}

/**
 * @param {object[]} cmsPositions  The CMS /positions array
 * @returns {{ size: number, byId: Map<string, object>, byCallsign: Map<string, object> }}
 *   byId holds every position (a vNAS id still finds a retired one); byCallsign leaves retired ones out,
 *   so a login never resolves to a position vNAS no longer lists.
 */
function buildNameIndex(cmsPositions) {
  const byId = new Map();
  const byCallsign = new Map();
  for (const p of cmsPositions ?? []) {
    if (!p?.callsign) continue;
    if (p.id) byId.set(p.id, p);
    if (!p.retired) byCallsign.set(p.callsign.toUpperCase(), p);
  }
  return { size: byCallsign.size, byId, byCallsign };
}

// PREFIX_MIDDLE_SUFFIX, e.g. IND_E_APP or IND_831_CTR.
const THREE_PART = /^([A-Z0-9]+)_([A-Z0-9]+)_([A-Z]+)$/;

/**
 * Centerline's resolvePosition: the vNAS position id if there is one, else the callsign as given, else the
 * relief rule: one trailing digit dropped from the middle part (IND_831_CTR -> IND_83_CTR, IND_E1_APP ->
 * IND_E_APP), else an all-digit middle dropped (IND_1_GND -> IND_GND). A login whose prefix changed stays unknown.
 * @returns {object|null} the CMS position
 */
function resolvePosition(index, callsign, positionId) {
  if (!index?.size) return null;
  if (positionId) return index.byId.get(positionId) ?? null; // the person is online and vNAS knows; the callsign isn't read
  if (!callsign) return null;
  const cs = callsign.toUpperCase();
  if (index.byCallsign.has(cs)) return index.byCallsign.get(cs);

  const m = THREE_PART.exec(cs);
  if (!m) return null;
  const [, prefix, middle, suffix] = m;
  if (middle.length > 1 && /\d$/.test(middle)) {
    const hit = index.byCallsign.get(`${prefix}_${middle.slice(0, -1)}_${suffix}`);
    if (hit) return hit;
  }
  if (/^\d+$/.test(middle)) return index.byCallsign.get(`${prefix}_${suffix}`) ?? null;
  return null;
}

/**
 * The airport a position is at, for Centerline's pilots preset. vNAS and the CMS don't carry one ("the app
 * supplies it"), so it comes from the position's facility: a cab's own airport, or an approach's primary
 * airport, as the ICAO code (IND -> KIND). A center, or a facility id that isn't a three-letter FAA id, has none.
 */
function airportOf(position) {
  const id = position?.facility?.id;
  return id && /^[A-Z]{3}$/.test(id) && position.callsign && !/_CTR$/.test(position.callsign) ? `K${id}` : null;
}

/**
 * Names for a login, trying each (callsign, positionId) in turn: the login callsign then the position's vNAS default.
 * @returns {{ shortName: string|null, radioName: string|null, airport: string|null, frequency: number|null } | null}
 */
function namesFor(index, ...candidates) {
  for (const { callsign, positionId } of candidates) {
    const p = resolvePosition(index, callsign, positionId);
    if (p) return { shortName: p.shortName || null, radioName: p.radioName || null, airport: airportOf(p), frequency: p.frequency || null };
  }
  return null;
}

/**
 * Adds `shortName`, `radioName`, `airport` and `displayFrequency` (the catalogue's, which can change; `frequency` stays vNAS's live one) to every controller, covered position and booking, in place.
 * Missing names are left undefined, so the embeds fall back to the callsign.
 */
function applyNames(index, facilities, bookings = []) {
  if (!index?.size) return;
  const label = (obj, ...candidates) => {
    const n = namesFor(index, ...candidates);
    obj.shortName = n?.shortName ?? undefined;
    obj.radioName = n?.radioName ?? undefined;
    obj.airport = n?.airport ?? undefined;
    obj.displayFrequency = n?.frequency ?? undefined;
  };
  for (const f of facilities) {
    for (const c of f.controllers) {
      // The vNAS id is the primary position's, and is what tells a relief login which position it covers.
      label(c, { callsign: c.callsign, positionId: c.positionId }, { callsign: c.defaultCallsign });
      for (const p of c.extraPositions ?? []) label(p, { callsign: p.callsign, positionId: p.positionId });
    }
  }
  for (const b of bookings) label(b, { callsign: b.callsign });
}

module.exports = { CMS_POSITIONS_URL, fetchCmsPositions, buildNameIndex, resolvePosition, airportOf, applyNames };
