const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePositions, resolveCallsigns, statsUrl, readStats, newCompetition, formatDuration, competitionEmbeds } = require('../src/ironmic');

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-01T00:00:00Z');

/** A vNAS Stats /v1/callsigns/top response. */
const stats = (callsigns, elapsedHours = 72) => ({
  requestedAt: '2026-10-04T00:00:00.123456789Z',
  start: '2026-10-01T00:00:00Z',
  end: '2026-10-04T00:00:00Z',
  actualElapsedDurationSeconds: elapsedHours * 3600,
  callsigns: callsigns.map(([prefix, suffix, hours]) => ({ prefix, suffix, durationSeconds: hours * 3600, isActive: false })),
});

/** A fetchFacilityIndex() result shaped like a slice of ZID. */
function zid() {
  const tree = {
    ZID: { type: 'Artcc', children: ['CMH', 'LEX', 'PKB'], positions: ['IND_83_CTR', 'IND_EM_CTR', 'ZID_TMU'] },
    CMH: { type: 'Tracon', children: ['DAY'], positions: ['CMH_N_APP', 'DAY_M_APP', 'DAY_U_APP', 'CMH_E_TWR', 'CMH_W_TWR', 'CMH_GND', 'CMH_DEL'] },
    DAY: { type: 'Atct', children: [], positions: ['DAY_TWR', 'DAY_GND', 'DAY_DEL'] },
    LEX: { type: 'Tracon', children: [], positions: ['LEX_E_APP', 'LEX_TWR', 'LEX_GND', 'LEX_DEL'] },
    PKB: { type: 'Atct', children: [], positions: ['PKB_TWR', 'PKB_GND', 'PKB_EM_TWR'] },
  };
  const facilities = new Map();
  const positions = new Map();
  for (const [id, f] of Object.entries(tree)) {
    const key = `ZID:${id}`;
    facilities.set(key, { key, id, name: id, positionType: f.type, childKeys: f.children.map((c) => `ZID:${c}`) });
    for (const callsign of f.positions) positions.set(callsign, { key, facilityId: id });
  }
  return { facilities, positions };
}

test('parsePositions reads names and aliases, top-down', () => {
  assert.deepEqual(parsePositions('local, approach'), ['approach', 'local']);
  assert.deepEqual(parsePositions('twr APP'), ['approach', 'local']);
  assert.deepEqual(parsePositions('local and approach and local'), ['approach', 'local']);
  assert.deepEqual(parsePositions('del/gnd + tower, ctr'), ['center', 'local', 'ground', 'delivery']);
  assert.throws(() => parsePositions('local, oceanic'), /"oceanic" isn't a position/);
  assert.throws(() => parsePositions('  '), /at least one/);
});

test('resolveCallsigns: center from the ARTCC, approach from the TRACON over it, the rest its own', () => {
  const all = ['center', 'approach', 'local', 'ground', 'delivery'];
  assert.deepEqual(resolveCallsigns(zid(), 'LEX', all), {
    center: ['IND_CTR'],
    approach: ['LEX_APP'],
    local: ['LEX_TWR'],
    ground: ['LEX_GND'],
    delivery: ['LEX_DEL'],
  });
  // A TRACON's approach covers every prefix it owns; its split towers are one callsign.
  assert.deepEqual(resolveCallsigns(zid(), 'CMH', ['approach', 'local']), { approach: ['CMH_APP', 'DAY_APP'], local: ['CMH_TWR'] });
  // A tower under a TRACON gets the TRACON's approach.
  assert.deepEqual(resolveCallsigns(zid(), 'DAY', ['approach', 'local']), { approach: ['CMH_APP', 'DAY_APP'], local: ['DAY_TWR'] });
  // A tower straight under the ARTCC has no approach.
  assert.deepEqual(resolveCallsigns(zid(), 'PKB', ['approach', 'local', 'delivery']), { approach: [], local: ['PKB_TWR'], delivery: [] });
  // Without the vNAS data, it's just the facility ID.
  assert.deepEqual(resolveCallsigns(null, 'LEX', ['center', 'approach']), { center: ['LEX_CTR'], approach: ['LEX_APP'] });
});

test('statsUrl sends whole-second UTC times', () => {
  assert.equal(
    statsUrl(T0 + 123, T0 + 2 * HOUR),
    'https://api.vnas-stats.com/v1/callsigns/top?start=2026-10-01T00%3A00%3A00Z&end=2026-10-01T02%3A00%3A00Z',
  );
});

test('readStats picks out the callsigns, and an unlisted position is under the cut-off', () => {
  const r = readStats(stats([['SAN', 'GND', 20], ['LEX', 'TWR', 10], ['LEX', 'GND', 4], ['SDF', 'APP', 3], ['HSV', 'APP', 2]]), {
    local: ['LEX_TWR'],
    approach: ['LEX_APP'],
  });
  assert.deepEqual(r.positions, {
    local: { ms: 10 * HOUR, rank: 2, ahead: { callsign: 'SAN_GND', gapMs: 10 * HOUR } },
    approach: { underMs: 2 * HOUR },
  });
  assert.equal(r.ranked, 5);
  const first = readStats(stats([['SDF', 'APP', 3], ['LEX', 'TWR', 4.5]]), { local: ['LEX_TWR'] }).positions.local;
  assert.deepEqual(first, { ms: 4.5 * HOUR, rank: 1, lead: { callsign: 'SDF_APP', gapMs: 1.5 * HOUR } });
  assert.equal(r.elapsedMs, 72 * HOUR);
  assert.equal(r.fetchedAt, Date.parse('2026-10-04T00:00:00.123Z'));
  assert.deepEqual(readStats(stats([]), { local: ['LEX_TWR'] }).positions, { local: { ms: 0 } });
});

test('readStats adds up a position with several callsigns and ranks the total against the rest', () => {
  const r = readStats(stats([['BOS', 'TWR', 12], ['CMH', 'APP', 8], ['SDF', 'APP', 7], ['DAY', 'APP', 3]]), { approach: ['CMH_APP', 'DAY_APP'] });
  assert.deepEqual(r.positions.approach, { ms: 11 * HOUR, rank: 2, ahead: { callsign: 'BOS_TWR', gapMs: 1 * HOUR } });
});

test('callsigns with the same time are tied, and a tie for #1 has no lead', () => {
  const r = readStats(stats([['SEA', 'CTR', 0.5], ['ATL', 'APP', 0.5], ['LEX', 'TWR', 0.5], ['BOS', 'GND', 0.4], ['LEX', 'GND', 0.4], ['MIA', 'TWR', 0.3]]), {
    local: ['LEX_TWR'],
    ground: ['LEX_GND'],
  });
  assert.deepEqual(r.positions.local, { ms: 0.5 * HOUR, rank: 1, tied: 2 });
  assert.deepEqual(r.positions.ground, { ms: 0.4 * HOUR, rank: 4, tied: 1, ahead: { callsign: 'LEX_TWR', gapMs: 0.1 * HOUR } });

  const comp = newCompetition({ facilityId: 'LEX', positions: ['local', 'ground'], callsigns: { local: ['LEX_TWR'], ground: ['LEX_GND'] }, channelId: 'c', startedAt: T0 });
  comp.totals = r;
  const [twr, gnd] = competitionEmbeds(comp);
  assert.equal(twr.description.split('\n')[1], '🏆 **#1** on the network · tied with 2 others');
  assert.equal(gnd.description.split('\n')[1], '🏆 **#4** on the network · tied with 1 other · 6m behind LEX_TWR');
});

test('one embed per position, top-down, with totals, percentages and network rank', () => {
  const comp = newCompetition({
    facilityId: 'LEX',
    facilityName: 'Lexington ATCT/TRACON',
    positions: ['approach', 'local'],
    callsigns: { approach: ['LEX_APP'], local: ['LEX_TWR'] },
    channelId: 'c',
    startedAt: T0,
  });
  assert.match(competitionEmbeds(comp)[0].description, /Waiting for the first totals/);

  comp.totals = readStats(stats([['BOS', 'TWR', 19.25], ['LEX', 'TWR', 18], ['HSV', 'APP', 2]]), comp.callsigns);
  const [app, twr] = competitionEmbeds(comp);
  assert.equal(app.title, '🎙️ Lexington ATCT/TRACON Iron Mic · Approach (LEX_APP)');
  assert.equal(app.description, "**Under 2h 00m** staffed · outside the network's top 3");
  assert.equal(app.footer, undefined);
  assert.equal(twr.title, '🎙️ Lexington ATCT/TRACON Iron Mic · Local (LEX_TWR)');
  assert.equal(twr.description, '**18h 00m** staffed · 25%\n🏆 **#2** on the network · 1h 15m behind BOS_TWR');
  assert.equal(twr.timestamp, new Date(T0).toISOString());
  assert.equal(twr.color, 0xf1c40f);

  const cmh = newCompetition({ facilityId: 'DAY', positions: ['approach'], callsigns: { approach: ['CMH_APP', 'DAY_APP'] }, channelId: 'c', startedAt: T0 });
  assert.equal(competitionEmbeds(cmh)[0].title, '🎙️ DAY Iron Mic · Approach (CMH_APP, DAY_APP)');
});

test('an ended competition says so until its final totals are in', () => {
  const comp = newCompetition({ facilityId: 'LEX', positions: ['local'], callsigns: { local: ['LEX_TWR'] }, channelId: 'c', startedAt: T0 });
  comp.endedAt = T0 + 72 * HOUR;
  comp.totals = readStats(stats([['LEX', 'TWR', 36]]), comp.callsigns);
  let [e] = competitionEmbeds(comp);
  assert.equal(e.title, '🏁 LEX Iron Mic · Local (LEX_TWR): final');
  assert.equal(e.description, '**36h 00m** staffed · 50%\n🏆 **#1** on the network\n*Fetching the final totals…*');
  assert.match(e.footer.text, /ended/);

  comp.final = true;
  [e] = competitionEmbeds(comp);
  assert.equal(e.description, '**36h 00m** staffed · 50%\n🏆 **#1** on the network');
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(35 * MIN + 59_000), '35m');
  assert.equal(formatDuration((42 * 60 + 5) * MIN), '42h 05m');
});
