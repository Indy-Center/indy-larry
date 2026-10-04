const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePositions, statsUrl, readStats, newCompetition, formatDuration, competitionEmbeds } = require('../src/ironmic');

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

test('parsePositions reads names and aliases, in a fixed order', () => {
  assert.deepEqual(parsePositions('local, approach'), ['approach', 'local']);
  assert.deepEqual(parsePositions('twr APP'), ['approach', 'local']);
  assert.deepEqual(parsePositions('local and approach and local'), ['approach', 'local']);
  assert.deepEqual(parsePositions('del/gnd + tower, ctr'), ['center', 'local', 'ground', 'delivery']);
  assert.throws(() => parsePositions('local, oceanic'), /"oceanic" isn't a position/);
  assert.throws(() => parsePositions('  '), /at least one/);
});

test('statsUrl sends whole-second UTC times', () => {
  assert.equal(
    statsUrl(T0 + 123, T0 + 2 * HOUR),
    'https://api.vnas-stats.com/v1/callsigns/top?start=2026-10-01T00%3A00%3A00Z&end=2026-10-01T02%3A00%3A00Z',
  );
});

test('readStats picks out the facility, and an unlisted position is under the cut-off', () => {
  const r = readStats(stats([['SAN', 'GND', 20], ['LEX', 'TWR', 10], ['LEX', 'GND', 4], ['SDF', 'APP', 3], ['HSV', 'APP', 2]]), 'LEX', ['local', 'approach']);
  assert.deepEqual(r.positions, {
    local: { ms: 10 * HOUR, rank: 2, ahead: { callsign: 'SAN_GND', gapMs: 10 * HOUR } },
    approach: { underMs: 2 * HOUR },
  });
  assert.equal(r.ranked, 5);
  const first = readStats(stats([['SDF', 'APP', 3], ['LEX', 'TWR', 4.5]]), 'LEX', ['local']).positions.local;
  assert.deepEqual(first, { ms: 4.5 * HOUR, rank: 1, lead: { callsign: 'SDF_APP', gapMs: 1.5 * HOUR } });
  assert.equal(r.elapsedMs, 72 * HOUR);
  assert.equal(r.fetchedAt, Date.parse('2026-10-04T00:00:00.123Z'));
  assert.deepEqual(readStats(stats([]), 'LEX', ['local']).positions, { local: { ms: 0 } });
});

test('one embed per position, top-down, with totals, percentages and network rank', () => {
  const comp = newCompetition({ facilityId: 'LEX', facilityName: 'Lexington ATCT/TRACON', positions: ['approach', 'local'], channelId: 'c', startedAt: T0 });
  assert.match(competitionEmbeds(comp)[0].description, /Waiting for the first totals/);

  comp.totals = readStats(stats([['BOS', 'TWR', 19.25], ['LEX', 'TWR', 18], ['HSV', 'APP', 2]]), 'LEX', comp.positions);
  const [app, twr] = competitionEmbeds(comp);
  assert.equal(app.title, '🎙️ Lexington ATCT/TRACON Iron Mic · Approach (LEX_APP)');
  assert.equal(app.description, "**Under 2h 00m** staffed · outside the network's top 3");
  assert.equal(app.footer, undefined);
  assert.equal(twr.title, '🎙️ Lexington ATCT/TRACON Iron Mic · Local (LEX_TWR)');
  assert.equal(twr.description, '**18h 00m** staffed · 25%\n🏆 **#2** on the network · 1h 15m behind BOS_TWR');
  assert.equal(twr.timestamp, new Date(T0).toISOString());
  assert.equal(twr.color, 0xf1c40f);
});

test('an ended competition says so until its final totals are in', () => {
  const comp = newCompetition({ facilityId: 'LEX', positions: ['local'], channelId: 'c', startedAt: T0 });
  comp.endedAt = T0 + 72 * HOUR;
  comp.totals = readStats(stats([['LEX', 'TWR', 36]]), 'LEX', comp.positions);
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
