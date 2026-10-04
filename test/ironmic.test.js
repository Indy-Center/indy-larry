const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePositions, staffedPositions, statsUrl, readStats, newCompetition, formatDuration, competitionEmbed } = require('../src/ironmic');

const MIN = 60_000;
const HOUR = 60 * MIN;
const T0 = Date.parse('2026-10-01T00:00:00Z');

/** A vNAS feed controller. */
function controller({ cid, callsign, facilityId = 'LEX', type, active = true, primaryActive = true, extra = [] }) {
  return {
    artccId: 'ZID',
    isActive: active,
    isObserver: false,
    vatsimData: { cid, realName: `Controller ${cid}`, callsign, facilityType: type },
    positions: [
      { isPrimary: true, isActive: primaryActive, facilityId, defaultCallsign: callsign },
      ...extra.map((e) => ({ isPrimary: false, isActive: true, ...e })),
    ],
  };
}

/** A vNAS Stats /v1/callsigns/top response. */
const stats = (callsigns, elapsedHours = 72) => ({
  requestedAt: '2026-10-04T00:00:00.123456789Z',
  start: '2026-10-01T00:00:00Z',
  end: '2026-10-04T00:00:00Z',
  actualElapsedDurationSeconds: elapsedHours * 3600,
  callsigns: callsigns.map(([prefix, suffix, hours]) => ({ prefix, suffix, durationSeconds: hours * 3600, isActive: false })),
});

test('parsePositions reads names and aliases, in a fixed order', () => {
  assert.deepEqual(parsePositions('local, approach'), ['local', 'approach']);
  assert.deepEqual(parsePositions('APP twr'), ['local', 'approach']);
  assert.deepEqual(parsePositions('approach and local and local'), ['local', 'approach']);
  assert.deepEqual(parsePositions('del/gnd + tower'), ['delivery', 'ground', 'local']);
  assert.throws(() => parsePositions('local, oceanic'), /"oceanic" isn't a position/);
  assert.throws(() => parsePositions('  '), /at least one/);
});

test("staffedPositions lists who's on each position's primary, active position", () => {
  const feed = {
    controllers: [
      controller({ cid: 1, callsign: 'LEX_TWR', type: 'Tower' }),
      controller({ cid: 2, callsign: 'LEX_N_APP', type: 'ApproachDeparture' }),
      controller({ cid: 3, callsign: 'LEX_APP', type: 'ApproachDeparture' }),
      controller({ cid: 4, callsign: 'LEX_GND', type: 'Ground' }), // not tracked
      controller({ cid: 5, callsign: 'SDF_TWR', facilityId: 'SDF', type: 'Tower' }),
      controller({ cid: 6, callsign: 'LEX_1_TWR', type: 'Tower', active: false }),
      controller({ cid: 7, callsign: 'LEX_2_TWR', type: 'Tower', primaryActive: false }),
      controller({ cid: 8, callsign: 'IND_CTR', facilityId: 'ZID', type: 'Center', extra: [{ facilityId: 'LEX', defaultCallsign: 'LEX_APP' }] }),
    ],
  };
  const staffed = staffedPositions(feed, 'LEX', ['local', 'approach']);
  assert.deepEqual(staffed.local.map((p) => p.callsign), ['LEX_TWR']);
  assert.deepEqual(staffed.approach.map((p) => p.callsign), ['LEX_APP', 'LEX_N_APP']);
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

test('the embed shows totals, percentages and who is on', () => {
  const comp = newCompetition({ facilityId: 'LEX', facilityName: 'Lexington ATCT/TRACON', positions: ['local', 'approach'], channelId: 'c', startedAt: T0 });
  assert.match(competitionEmbed(comp).fields[0].value, /Waiting for the first totals/);

  comp.totals = readStats(stats([['BOS', 'TWR', 19.25], ['LEX', 'TWR', 18], ['HSV', 'APP', 2]]), 'LEX', comp.positions);
  comp.live.local = [{ cid: '1', name: 'Controller 1', callsign: 'LEX_TWR' }];
  const e = competitionEmbed(comp);
  assert.equal(e.title, '🎙️ Lexington ATCT/TRACON Iron Mic');
  assert.equal(e.fields[0].name, 'Local (LEX_TWR)');
  assert.equal(e.fields[0].value, '**18h 00m** staffed · 25%\n🏆 **#2** on the network · 1h 15m behind BOS_TWR\n🟢 **LEX_TWR** Controller 1');
  assert.equal(e.fields[1].value, "**Under 2h 00m** staffed · outside the network's top 3\n🔴 Unstaffed");
  assert.equal(e.color, 0x2ecc71);
  assert.equal(competitionEmbed(comp, { showNames: false }).fields[0].value.split('\n')[2], '🟢 **LEX_TWR** 1');
});

test('an ended competition says so until its final totals are in', () => {
  const comp = newCompetition({ facilityId: 'LEX', positions: ['local'], channelId: 'c', startedAt: T0 });
  comp.endedAt = T0 + 72 * HOUR;
  comp.totals = readStats(stats([['LEX', 'TWR', 36]]), 'LEX', comp.positions);
  let e = competitionEmbed(comp);
  assert.equal(e.title, '🏁 LEX Iron Mic: final results');
  assert.match(e.description, /Fetching the final totals/);
  assert.equal(e.fields[0].value, '**36h 00m** staffed · 50%\n🏆 **#1** on the network'); // no live line once ended

  comp.final = true;
  e = competitionEmbed(comp);
  assert.doesNotMatch(e.description, /Fetching/);
  assert.equal(e.color, 0xf1c40f);
});

test('formatDuration', () => {
  assert.equal(formatDuration(0), '0m');
  assert.equal(formatDuration(35 * MIN + 59_000), '35m');
  assert.equal(formatDuration((42 * 60 + 5) * MIN), '42h 05m');
});
