// Display names from the Indy Center CMS: IND_E_APP -> "IND E" (short name) and "Indianapolis Approach" (radio name).
// Pure lookup logic plus one fetch, so it can be tested offline. Callsigns stay the identity everywhere else;
// these are only labels, and anything the CMS doesn't know keeps its callsign and vNAS position name.

const CMS_POSITIONS_URL = 'https://cms.flyindycenter.com/api/public/v1/positions';

async function fetchCmsPositions(url = CMS_POSITIONS_URL) {
  const res = await fetch(url, { headers: { 'User-Agent': 'vnas-discord-bot' } });
  if (!res.ok) throw new Error(`CMS positions request failed: HTTP ${res.status}`);
  return res.json();
}

// PREFIX_MIDDLE_SUFFIX, e.g. IND_E_APP or IND_E1_APP.
const THREE_PART = /^([A-Z0-9]+)_([A-Z0-9]+)_([A-Z]+)$/;

/**
 * @param {object[]} cmsPositions  The CMS /positions array
 * @returns {Map<string, { shortName: string|null, radioName: string|null }>} callsign -> names, retired positions left out
 */
function buildNameIndex(cmsPositions) {
  const index = new Map();
  for (const p of cmsPositions ?? []) {
    if (!p?.callsign || p.retired) continue;
    index.set(p.callsign.toUpperCase(), { shortName: p.shortName || null, radioName: p.radioName || null });
  }
  return index;
}

/**
 * Names for a callsign. An exact match wins; otherwise successive positions match their base with a
 * wildcard, IND_E*_APP: IND_E1_APP and IND_E2_APP get IND_E_APP's names. When several bases fit, the
 * longest wins (IND_EM1_APP -> IND_EM_APP, not IND_E_APP).
 * @returns {{ shortName: string|null, radioName: string|null } | null}
 */
function lookupNames(index, callsign) {
  if (!index?.size || !callsign) return null;
  const cs = callsign.toUpperCase();
  if (index.has(cs)) return index.get(cs);

  const m = THREE_PART.exec(cs);
  if (!m) return null;
  const [, prefix, middle, suffix] = m;
  let best = null;
  let bestLen = 0;
  for (const [candidate, names] of index) {
    const c = THREE_PART.exec(candidate);
    if (!c || c[1] !== prefix || c[3] !== suffix) continue;
    if (middle.startsWith(c[2]) && c[2].length > bestLen) {
      best = names;
      bestLen = c[2].length;
    }
  }
  return best;
}

/** First match among the callsigns given, e.g. the login callsign then the position's vNAS default. */
const namesFor = (index, ...callsigns) => {
  for (const cs of callsigns) {
    const n = lookupNames(index, cs);
    if (n) return n;
  }
  return null;
};

/**
 * Adds `shortName` and `radioName` to every controller, covered position and booking, in place.
 * Missing names are left undefined, so the embeds fall back to the callsign and vNAS position name.
 */
function applyNames(index, facilities, bookings = []) {
  if (!index?.size) return;
  const label = (obj, ...callsigns) => {
    const n = namesFor(index, ...callsigns);
    obj.shortName = n?.shortName ?? undefined;
    obj.radioName = n?.radioName ?? undefined;
  };
  for (const f of facilities) {
    for (const c of f.controllers) {
      label(c, c.callsign, c.defaultCallsign);
      for (const p of c.extraPositions ?? []) label(p, p.callsign);
    }
  }
  for (const b of bookings) label(b, b.callsign);
}

module.exports = { CMS_POSITIONS_URL, fetchCmsPositions, buildNameIndex, lookupNames, applyNames };
