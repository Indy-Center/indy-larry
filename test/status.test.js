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

test('parseClosing understands Central, Mountain and Pacific', () => {
  assert.equal(at('Online until 8pm CT', '2026-09-27T22:00:00Z'), '2026-09-28T01:00:00.000Z'); // CDT
  assert.equal(at('Online until 8pm MST (0300z)', '2026-09-27T22:00:00Z'), '2026-09-28T03:00:00.000Z');
  assert.equal(at('Online until 8pm PT', '2026-09-27T22:00:00Z'), '2026-09-28T03:00:00.000Z'); // PDT
  assert.equal(at('Online until 8pm PT', '2026-12-01T22:00:00Z'), '2026-12-02T04:00:00.000Z'); // PST
});

test('parseClosing understands Central, Mountain and Pacific', () => {
  assert.equal(at('Online until 8pm CT', '2026-09-27T22:00:00Z'), '2026-09-28T01:00:00.000Z'); // CDT
  assert.equal(at('Online until 8pm MST (0300z)', '2026-09-27T22:00:00Z'), '2026-09-28T03:00:00.000Z');
  assert.equal(at('Online until 8pm PT', '2026-09-27T22:00:00Z'), '2026-09-28T03:00:00.000Z'); // PDT
  assert.equal(at('Online until 8pm PT', '2026-12-01T22:00:00Z'), '2026-12-02T04:00:00.000Z'); // PST
});

test('parseClosing keeps a time up to an hour past (running over)', () => {
  assert.equal(at('Online until 8pm ET (2400z)', '2026-09-28T00:20:00Z'), '2026-09-28T00:00:00.000Z');
});

test('parseClosing still accepts the older styles', () => {
  assert.equal(at('Closing at 0200z', '2026-09-27T22:00:00Z'), '2026-09-28T02:00:00.000Z');
  assert.equal(at('Closing in 20 min', '2026-09-27T22:00:00Z'), '2026-09-27T22:20:00.000Z');
});

test('parseClosing ignores lines that only look like closing', () => {
  for (const info of [
    'Solo endorsement valid until 11/10',
    'RWY 27 closed',
    'Student Solo Valid Until 9/27',
    'Online since 6pm ET',
    'Close attention to readbacks',
    'Closing at ???',
    'Online until ???',
    'Closing soon',
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

test('only active secondary positions count as also covering', () => {
  const center = controller('1', 'IND_83_CTR', 'Center', { facilityId: 'ZID' });
  const display = (callsign, isActive) => ({
    isPrimary: false,
    isActive,
    facilityId: callsign.split('_')[0],
    facilityName: 'TRACON',
    positionType: 'Tracon',
    positionName: callsign,
    defaultCallsign: callsign,
    frequency: 1,
  });
  // As IND_83_CTR appeared live: STARS displays open in the profile, not signed in.
  center.positions.push(display('SDF_D_APP', false), display('CVG_W_APP', false));
  let [facility] = groupByFacility({ controllers: [center] });
  assert.deepEqual(facility.controllers[0].extraPositions, []);

  center.positions.push(display('IND_E_APP', true));
  [facility] = groupByFacility({ controllers: [center] });
  assert.deepEqual(facility.controllers[0].extraPositions.map((p) => p.callsign), ['IND_E_APP']);
});

test('top-down coverage lists only unstaffed TRACONs directly underneath', () => {
  const node = (id, positionType, childIds = []) => [
    `ZID:${id}`,
    { key: `ZID:${id}`, id, name: id, positionType, childKeys: childIds.map((c) => `ZID:${c}`) },
  ];
  const tree = new Map([
    node('ZID', 'Artcc', ['SDF', 'EVV', 'HUF', 'PKB']),
    node('SDF', 'Tracon', ['LOU', 'FTK']),
    node('EVV', 'Tracon', ['OWB']),
    node('HUF', 'Tracon', ['BMG']),
    node('PKB', 'Atct'),
    node('LOU', 'Atct'),
    node('FTK', 'Atct'),
    node('OWB', 'Atct'),
    node('BMG', 'Atct'),
  ]);
  const center = controller('1', 'IND_83_CTR', 'Center', { facilityId: 'ZID' });
  center.positions[0].positionType = 'Artcc';
  const feed = {
    controllers: [
      center,
      controller('2', 'SDF_D_APP', 'ApproachDeparture', { facilityId: 'SDF' }),
      controller('3', 'EVV_TWR', 'Tower', { facilityId: 'EVV' }),
      controller('4', 'LOU_TWR', 'Tower', { facilityId: 'LOU' }),
    ],
  };
  const topDown = (f, id) =>
    new StatusBoard({}).update(groupByFacility(f, { includeInactive: true }), [], new Date(), tree)
      .find((e) => e.key === `ZID:${id}`).topDown.map((t) => t.id);

  // SDF has radar, so it's not listed. EVV has only its tower on, so center still covers its radar.
  // PKB is a tower, never listed; TRACONs never list their towers.
  assert.deepEqual(topDown(feed, 'ZID'), ['EVV', 'HUF']);
  assert.deepEqual(topDown(feed, 'SDF'), []);
  assert.deepEqual(topDown(feed, 'EVV'), []);

  // An inactive radar controller doesn't count as staffing the TRACON.
  feed.controllers[1].isActive = false;
  assert.deepEqual(topDown(feed, 'ZID'), ['EVV', 'HUF', 'SDF']);

  // An inactive center covers nothing.
  center.isActive = false;
  assert.deepEqual(topDown(feed, 'ZID'), []);

  // Without the ARTCC data (ARTCC_IDS unset) there's no top-down line.
  center.isActive = true;
  assert.deepEqual(new StatusBoard().update(groupByFacility(feed), [], new Date())[0].topDown, []);
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

test('the end time shows on its own line before the closing window', () => {
  const { statusEmbed } = require('../src/embeds');
  const now = new Date('2026-09-27T20:00:00Z');
  const feed = {
    controllers: [
      controller('1', 'IND_N_APP', 'ApproachDeparture', { info: 'Online until 8pm ET (2400z)' }),
      controller('2', 'IND_E_TWR', 'Tower'),
    ],
  };
  const [entry] = new StatusBoard().update(groupByFacility(feed), [], now);
  const [app, twr] = statusEmbed(entry, { showNames: false }).data.description.split('\n\n');
  const end = Date.parse('2026-09-28T00:00:00Z') / 1000;
  assert.equal(entry.status, 'online');
  assert.match(app, new RegExp(`\\n└ Online until <t:${end}:t> \\(<t:${end}:R>\\)$`));
  assert.doesNotMatch(app, /🟡/);
  assert.doesNotMatch(twr, /Online until/);
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
