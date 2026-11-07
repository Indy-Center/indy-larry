const test = require('node:test');
const assert = require('node:assert/strict');
const { pointInGeometry, project, summarize, staffing, evaluateCongestion } = require('../src/congestion');
// Real ZID (VAT-Spy) and IND (SimAware) boundaries, trimmed to the geometry.
const B = require('./fixtures/boundaries.json');

const areas = [
  { key: 'ZID', name: 'ZID', kind: 'enroute', prefixes: ['ZID'], geometry: B.KZID },
  { key: 'IND', name: 'IND TRACON', kind: 'tracon', prefixes: ['IND'], geometry: B.IND },
];
const pilot = (callsign, latitude, longitude, over = {}) =>
  ({ callsign, latitude, longitude, altitude: 10000, groundspeed: 250, heading: 0, ...over });

test('pointInGeometry: real boundaries', () => {
  assert.equal(pointInGeometry(-86.29, 39.72, B.IND), true); // KIND
  assert.equal(pointInGeometry(-86.29, 39.72, B.KZID), true);
  assert.equal(pointInGeometry(-84.67, 39.05, B.IND), false); // KCVG: ZID but not IND TRACON
  assert.equal(pointInGeometry(-84.67, 39.05, B.KZID), true);
  assert.equal(pointInGeometry(-87.9, 41.98, B.KZID), false); // KORD
});

test('pointInGeometry: holes are outside', () => {
  const square = (a, b) => [[a, a], [b, a], [b, b], [a, b], [a, a]];
  const g = { type: 'Polygon', coordinates: [square(0, 10), square(4, 6)] };
  assert.equal(pointInGeometry(2, 2, g), true);
  assert.equal(pointInGeometry(5, 5, g), false);
});

test('project: 240 kt north for 15 min is 1 degree of latitude', () => {
  const q = project({ latitude: 39, longitude: -86, groundspeed: 240, heading: 0 }, 15);
  assert.ok(Math.abs(q.lat - 40) < 1e-9 && Math.abs(q.lon + 86) < 1e-9);
});

test('summarize: inside, entering, high/low, and ground traffic ignored', () => {
  const pilots = [
    pilot('IN1', 39.72, -86.29), // KIND, low
    pilot('HI1', 39.05, -84.67, { altitude: 35000 }), // over CVG, high, ZID only
    pilot('GND', 39.72, -86.29, { groundspeed: 0 }), // parked at IND
    pilot('ENT', 40.9, -86.29, { heading: 180, groundspeed: 300 }), // north of ZID, southbound: enters within 15
    pilot('OUT', 41.98, -87.9, { heading: 0 }), // ORD northbound, never
  ];
  const [zid, ind] = summarize(pilots, areas, { lookaheadMin: 15 });
  assert.deepEqual({ inside: zid.inside, high: zid.high, low: zid.low, entering: zid.entering }, { inside: 2, high: 1, low: 1, entering: 1 });
  assert.equal(ind.inside, 1);
});

test('staffing: centers for the ARTCC, matching approach for a TRACON, top-down otherwise', () => {
  const summary = summarize([], areas);
  const ctr = { callsign: 'IND_12_CTR', facilityType: 'Center', isActive: true };
  const app = { callsign: 'IND_E_APP', facilityType: 'ApproachDeparture', isActive: true };
  const other = { callsign: 'SDF_APP', facilityType: 'ApproachDeparture', isActive: true };
  let [zid, ind] = staffing(summary, [{ controllers: [ctr, other] }]);
  assert.equal(zid.staff, 1);
  assert.deepEqual([ind.staff, ind.topDown], [0, true]);
  [zid, ind] = staffing(summary, [{ controllers: [app, { ...ctr, isActive: false }] }]);
  assert.deepEqual([zid.staff, ind.staff, ind.topDown], [0, 1, false]);
});

const area = (over) => ({ key: 'ZID', name: 'ZID', kind: 'enroute', inside: 20, entering: 10, staff: 0, topDown: false, ...over });
const opts = (mode) => ({ mode, thresholds: { enroute: 25, tracon: 10 }, cooldownMs: 30 * 60_000, hysteresis: 3 });

test('evaluateCongestion: modes', () => {
  const uncovered = [area()];
  const busy = [area({ staff: 1 })];
  assert.equal(evaluateCongestion({}, uncovered, 0, opts('off')).fire.length, 0);
  assert.equal(evaluateCongestion({}, uncovered, 0, opts('uncovered')).fire[0].reason, 'uncovered');
  assert.equal(evaluateCongestion({}, uncovered, 0, opts('overloaded')).fire.length, 0);
  assert.equal(evaluateCongestion({}, busy, 0, opts('uncovered')).fire.length, 0);
  assert.equal(evaluateCongestion({}, busy, 0, opts('overloaded')).fire[0].reason, 'overloaded');
  assert.equal(evaluateCongestion({}, [area({ staff: 2 })], 0, opts('both')).fire.length, 0); // 15 per controller
  assert.equal(evaluateCongestion({}, [area({ kind: 'tracon', topDown: true })], 0, opts('both')).fire.length, 0);
});

test('evaluateCongestion: fires once, rearms below threshold minus hysteresis after the cooldown', () => {
  const memory = {};
  const o = opts('uncovered');
  assert.equal(evaluateCongestion(memory, [area()], 0, o).fire.length, 1);
  assert.equal(evaluateCongestion(memory, [area()], 60_000, o).fire.length, 0); // still tripped
  evaluateCongestion(memory, [area({ inside: 15, entering: 8 })], 120_000, o); // 23: not below 22
  assert.equal(memory.ZID.tripped, true);
  evaluateCongestion(memory, [area({ inside: 10, entering: 5 })], 180_000, o); // 15: rearms
  assert.equal(memory.ZID.tripped, false);
  assert.equal(evaluateCongestion(memory, [area()], 240_000, o).fire.length, 0); // inside the cooldown
  assert.equal(evaluateCongestion(memory, [area()], 31 * 60_000, o).fire.length, 1);
});
