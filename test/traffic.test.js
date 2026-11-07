const test = require('node:test');
const assert = require('node:assert/strict');
const { haversineNm, listPositions, countAircraft, evaluateHelp } = require('../src/traffic');

const MIN = 60_000;

const tx = (frequency, latDeg, lonDeg) => ({ id: 0, frequency, latDeg, lonDeg });
const station = (callsign, ...transceivers) => ({ callsign, transceivers, shoutLineIds: [] });

// Indianapolis tower, and a pilot placed due north by `nm` nautical miles (1 degree of latitude = 60 nm).
const IND = { lat: 39.7173, lon: -86.2944 };
const north = (nm) => IND.lat + nm / 60;

const controller = (over = {}) => ({
  callsign: 'IND_TWR',
  facilityType: 'Tower',
  positionName: 'Indianapolis Tower',
  frequency: 118_500_000,
  extraPositions: [],
  ...over,
});
const facility = (...controllers) => [{ controllers }];

test('haversineNm: one degree of latitude is about 60 nm', () => {
  const d = haversineNm({ latDeg: 39, lonDeg: -86 }, { latDeg: 40, lonDeg: -86 });
  assert.ok(Math.abs(d - 60) < 0.2, `got ${d}`);
});

test('listPositions: primary and secondary frequencies, skipping guard and placeholders', () => {
  const list = listPositions(
    facility(
      controller({
        extraPositions: [
          { callsign: 'IND_GND', positionName: 'Ground', frequency: 121_900_000 },
          { callsign: 'IND_X', positionName: 'Guard', frequency: 121_500_000 },
          { callsign: 'IND_Y', positionName: 'None', frequency: 199_998_000 },
        ],
      }),
    ),
  );
  assert.deepEqual(list.map((p) => p.callsign), ['IND_TWR', 'IND_GND']);
  assert.equal(list[0].area, 'cab');
  assert.equal(list[1].controllerCallsign, 'IND_TWR');
});

test('listPositions: maps facility types to areas', () => {
  const areas = listPositions(
    facility(
      controller({ callsign: 'A', facilityType: 'ApproachDeparture' }),
      controller({ callsign: 'B', facilityType: 'Center' }),
      controller({ callsign: 'C', facilityType: 'FlightServiceStation' }),
    ),
  ).map((p) => p.area);
  assert.deepEqual(areas, ['tracon', 'enroute', null]);
});

test('countAircraft: counts aircraft on frequency inside the radius, not outside', () => {
  const positions = listPositions(facility(controller()));
  const feed = [
    station('IND_TWR', tx(118_500_000, IND.lat, IND.lon)),
    station('NEAR1', tx(118_500_000, north(5), IND.lon)),
    station('FAR1', tx(118_500_000, north(30), IND.lon)), // same frequency, but 30 nm away (default tower radius is 10)
    station('OTHER', tx(119_000_000, north(1), IND.lon)), // nearby, different frequency
  ];
  assert.equal(countAircraft(positions, feed, { atcCallsigns: new Set(['IND_TWR']) })[0].count, 1);
});

test('countAircraft: unset radius env vars (undefined) fall back to the defaults', () => {
  const positions = listPositions(facility(controller()));
  const feed = [station('IND_TWR', tx(118_500_000, IND.lat, IND.lon)), station('NEAR1', tx(118_500_000, north(5), IND.lon))];
  const radiusNm = { cab: undefined, tracon: undefined, enroute: undefined }; // what bot.js passes with blank .env values
  assert.equal(countAircraft(positions, feed, { atcCallsigns: new Set(['IND_TWR']), radiusNm })[0].count, 1);
});

test('countAircraft: guard-monitoring aircraft are not counted for another frequency', () => {
  const positions = listPositions(facility(controller()));
  const feed = [
    station('IND_TWR', tx(118_500_000, IND.lat, IND.lon)),
    station('MON1', tx(121_500_000, north(1), IND.lon), tx(118_500_000, north(1), IND.lon)),
    station('MON2', tx(121_500_000, north(1), IND.lon)),
  ];
  assert.equal(countAircraft(positions, feed)[0].count, 1);
});

test('countAircraft: two positions sharing a frequency at different airports count separately', () => {
  const positions = listPositions(
    facility(
      controller({ callsign: 'IND_GND', frequency: 121_900_000 }),
      controller({ callsign: 'CMH_GND', frequency: 121_900_000 }),
    ),
  );
  const feed = [
    station('IND_GND', tx(121_900_000, IND.lat, IND.lon)),
    station('CMH_GND', tx(121_900_000, 39.998, -82.892)),
    station('AAL1', tx(121_900_000, north(2), IND.lon)), // at Indianapolis
    station('AAL2', tx(121_900_000, 40.0, -82.89)), // at Columbus
    station('AAL3', tx(121_900_000, 40.0, -82.9)), // at Columbus
  ];
  const [ind, cmh] = countAircraft(positions, feed);
  assert.equal(ind.count, 1);
  assert.equal(cmh.count, 2);
});

test('countAircraft: COM1 and COM2 on the same frequency count the aircraft once', () => {
  const positions = listPositions(facility(controller()));
  const feed = [
    station('IND_TWR', tx(118_500_000, IND.lat, IND.lon)),
    station('DAL1', tx(118_500_000, north(2), IND.lon), tx(118_500_000, north(2), IND.lon)),
  ];
  assert.equal(countAircraft(positions, feed)[0].count, 1);
});

test('countAircraft: secondary frequencies are counted on their own', () => {
  const positions = listPositions(
    facility(controller({ extraPositions: [{ callsign: 'IND_GND', positionName: 'Ground', frequency: 121_900_000 }] })),
  );
  const feed = [
    station('IND_TWR', tx(118_500_000, IND.lat, IND.lon), tx(121_900_000, IND.lat, IND.lon)),
    station('A1', tx(118_500_000, north(1), IND.lon)),
    station('A2', tx(121_900_000, north(1), IND.lon)),
    station('A3', tx(121_900_000, north(2), IND.lon)),
  ];
  const [twr, gnd] = countAircraft(positions, feed);
  assert.equal(twr.count, 1);
  assert.equal(gnd.count, 2);
});

test('countAircraft: other controllers are not counted as aircraft', () => {
  const positions = listPositions(facility(controller()));
  const feed = [
    station('IND_TWR', tx(118_500_000, IND.lat, IND.lon)),
    station('IND_GND', tx(118_500_000, IND.lat, IND.lon)),
    station('SOMEONE', tx(118_500_000, IND.lat, IND.lon)), // named like an aircraft, but in the controller feed
  ];
  assert.equal(countAircraft(positions, feed, { atcCallsigns: new Set(['IND_TWR', 'SOMEONE']) })[0].count, 0);
});

test('countAircraft: radius is per area and can be overridden', () => {
  const positions = listPositions(facility(controller({ facilityType: 'ApproachDeparture' })));
  const feed = [
    station('IND_TWR', tx(118_500_000, IND.lat, IND.lon)),
    station('A1', tx(118_500_000, north(40), IND.lon)),
  ];
  assert.equal(countAircraft(positions, feed)[0].count, 1); // tracon default 60 nm
  assert.equal(countAircraft(positions, feed, { radiusNm: { tracon: 20 } })[0].count, 0);
});

const counted = (callsign, count, area = 'cab') => ({ callsign, count, area, frequency: 118_500_000 });
const OPTS = { thresholds: { cab: 5 }, cooldownMs: 15 * MIN, hysteresis: 2 };

test('evaluateHelp: fires once at the threshold, not again while it stays busy', () => {
  const memory = {};
  assert.equal(evaluateHelp(memory, [counted('A', 4)], 0, OPTS).fire.length, 0);
  assert.equal(evaluateHelp(memory, [counted('A', 5)], MIN, OPTS).fire.length, 1);
  assert.equal(evaluateHelp(memory, [counted('A', 9)], 2 * MIN, OPTS).fire.length, 0);
});

test('evaluateHelp: needs the count to drop below threshold minus hysteresis, and the cooldown, to fire again', () => {
  const memory = {};
  evaluateHelp(memory, [counted('A', 5)], 0, OPTS); // fires
  evaluateHelp(memory, [counted('A', 4)], MIN, OPTS); // 4 is not below 5 - 2, still tripped
  assert.equal(evaluateHelp(memory, [counted('A', 5)], 2 * MIN, OPTS).fire.length, 0);
  evaluateHelp(memory, [counted('A', 2)], 3 * MIN, OPTS); // re-armed
  assert.equal(evaluateHelp(memory, [counted('A', 6)], 5 * MIN, OPTS).fire.length, 0); // inside the cooldown
  assert.equal(evaluateHelp(memory, [counted('A', 6)], 16 * MIN, OPTS).fire.length, 1);
});

test('evaluateHelp: a threshold of 0 or none turns the alert off for that area', () => {
  const memory = {};
  assert.equal(evaluateHelp(memory, [counted('A', 50, 'tracon')], 0, OPTS).fire.length, 0);
  assert.equal(evaluateHelp(memory, [counted('A', 50)], 0, { ...OPTS, thresholds: { cab: 0 } }).fire.length, 0);
});

test('evaluateHelp: forgets offline positions once the cooldown is over', () => {
  const memory = {};
  evaluateHelp(memory, [counted('A', 5)], 0, OPTS);
  evaluateHelp(memory, [], MIN, OPTS);
  assert.ok(memory.A); // still cooling down
  evaluateHelp(memory, [], 16 * MIN, OPTS);
  assert.equal(memory.A, undefined);
});
