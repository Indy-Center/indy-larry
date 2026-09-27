const test = require('node:test');
const assert = require('node:assert/strict');
const { parseClosing, StatusBoard } = require('../src/status');
const { groupByFacility, trackActivations } = require('../src/feed');

const at = (info, now) => parseClosing(info, new Date(now))?.at?.toISOString() ?? null;

test('parseClosing reads the SOP format, preferring zulu', () => {
  assert.equal(at('Online until 8pm ET (2400z)', '2026-09-27T22:00:00Z'), '2026-09-28T00:00:00.000Z');
  assert.equal(at('Online until 9:30 pm EDT (0130z)', '2026-09-27T22:00:00Z'), '2026-09-28T01:30:00.000Z');
  assert.equal(at('Welcome!\r\nOnline until 11pm ET (0300z)\r\nFeedback', '2026-09-27T22:00:00Z'), '2026-09-28T03:00:00.000Z');
});

test('parseClosing converts ET-only times with daylight saving', () => {
  assert.equal(at('Online until 8pm ET', '2026-09-27T22:00:00Z'), '2026-09-28T00:00:00.000Z'); // EDT
  assert.equal(at('Online until 8pm ET', '2026-12-01T22:00:00Z'), '2026-12-02T01:00:00.000Z'); // EST
});

test('parseClosing keeps a time up to an hour past (running over)', () => {
  assert.equal(at('Online until 8pm ET (2400z)', '2026-09-28T00:20:00Z'), '2026-09-28T00:00:00.000Z');
});

test('parseClosing still accepts the older styles', () => {
  assert.equal(at('Closing at 0200z', '2026-09-27T22:00:00Z'), '2026-09-28T02:00:00.000Z');
  assert.equal(at('Closing in 20 min', '2026-09-27T22:00:00Z'), '2026-09-27T22:20:00.000Z');
  assert.deepEqual(parseClosing('Closing soon', new Date()), { at: null });
});

test('parseClosing ignores lines that only look like closing', () => {
  for (const info of [
    'Solo endorsement valid until 11/10',
    'RWY 27 closed',
    'Student Solo Valid Until 9/27',
    'Online since 6pm ET',
    'Close attention to readbacks',
    '/// OTS IN PROGRESS ///',
  ]) {
    assert.equal(parseClosing(info, new Date('2026-09-27T22:00:00Z')), null, info);
  }
});

function controller(cid, callsign, facilityType, { active = true, info = '', facilityId = 'IND' } = {}) {
  return {
    artccId: 'ZID',
    isActive: active,
    isObserver: false,
    loginTime: '2026-09-27T20:00:00Z',
    positions: [
      {
        isPrimary: true,
        facilityId,
        facilityName: `${facilityId} ATCT/TRACON`,
        positionType: 'Tracon',
        positionName: callsign,
        defaultCallsign: callsign,
        frequency: 124650000,
      },
    ],
    vatsimData: { cid, callsign, facilityType, controllerInfo: info, requestedRating: 'Controller1' },
  };
}

test('groupByFacility puts positions in one embed, TRACON first and Clearance last', () => {
  const feed = {
    controllers: [
      controller('1', 'IND_DEL', 'ClearanceDelivery'),
      controller('2', 'IND_GND', 'Ground'),
      controller('3', 'IND_S_APP', 'ApproachDeparture'),
      controller('4', 'IND_E_TWR', 'Tower'),
      controller('5', 'IND_N_APP', 'ApproachDeparture'),
    ],
  };
  const facilities = groupByFacility(feed);
  assert.equal(facilities.length, 1);
  assert.deepEqual(
    facilities[0].controllers.map((c) => c.callsign),
    ['IND_N_APP', 'IND_S_APP', 'IND_E_TWR', 'IND_GND', 'IND_DEL'],
  );
});

test('facility only turns yellow when every controller is closing', () => {
  const now = new Date('2026-09-27T23:50:00Z');
  const feed = {
    controllers: [
      controller('1', 'IND_N_APP', 'ApproachDeparture', { info: 'Online until 8pm ET (2400z)' }),
      controller('2', 'IND_E_TWR', 'Tower'),
    ],
  };
  const [entry] = new StatusBoard().update(groupByFacility(feed), [], now);
  assert.equal(entry.status, 'online');
  assert.ok(entry.facility.controllers.find((c) => c.callsign === 'IND_N_APP').closing);

  feed.controllers[1].vatsimData.controllerInfo = 'Online until 8pm ET (2400z)';
  const [closing] = new StatusBoard().update(groupByFacility(feed), [], now);
  assert.equal(closing.status, 'closing');
});

test('a closed facility shows offline, then drops off', () => {
  const board = new StatusBoard({ offlineMinutes: 30 });
  const feed = { controllers: [controller('1', 'EVV_TWR', 'Tower', { facilityId: 'EVV' })] };
  board.update(groupByFacility(feed), [], new Date('2026-09-27T20:00:00Z'));
  const [offline] = board.update([], [], new Date('2026-09-27T20:05:00Z'));
  assert.equal(offline.status, 'offline');
  assert.deepEqual(board.update([], [], new Date('2026-09-27T20:40:00Z')), []);
});

test('trackActivations records activation, resets when inactive, and scopes to ARTCCs', () => {
  const seen = new Map();
  const a = controller('A', 'IND_N_APP', 'ApproachDeparture');
  const b = controller('B', 'IND_GND', 'Ground', { active: false });
  const other = { ...controller('C', 'CHI_APP', 'ApproachDeparture'), artccId: 'ZAU' };
  const feed = { controllers: [a, b, other] };

  trackActivations(feed, seen, new Date('2026-09-27T21:00:00Z'), true, ['ZID']);
  assert.equal(seen.get('A|2026-09-27T20:00:00Z'), '2026-09-27T20:00:00Z'); // already active at startup: connect time
  assert.equal(seen.size, 1); // B inactive, C outside ZID

  b.isActive = true;
  trackActivations(feed, seen, new Date('2026-09-27T21:05:00Z'), false, ['ZID']);
  assert.equal(seen.get('B|2026-09-27T20:00:00Z'), '2026-09-27T21:05:00.000Z');

  b.isActive = false;
  trackActivations(feed, seen, new Date('2026-09-27T21:10:00Z'), false, ['ZID']);
  assert.equal(seen.has('B|2026-09-27T20:00:00Z'), false);
});
