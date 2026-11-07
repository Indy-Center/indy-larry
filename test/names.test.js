const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNameIndex, lookupNames, applyNames } = require('../src/names');

// Shaped like cms.flyindycenter.com/api/public/v1/positions
const cms = [
  { callsign: 'IND_E_APP', shortName: 'IND E', radioName: 'Indianapolis Approach', retired: false },
  { callsign: 'IND_EM_APP', shortName: null, radioName: 'Indianapolis Guard', retired: false },
  { callsign: 'BMG_TWR', shortName: 'BMG LC', radioName: 'Bloomington Tower', retired: false },
  { callsign: 'OLD_X_APP', shortName: 'OLD X', radioName: 'Old Approach', retired: true },
];
const index = buildNameIndex(cms);

test('lookupNames: exact callsign', () => {
  assert.deepEqual(lookupNames(index, 'IND_E_APP'), { shortName: 'IND E', radioName: 'Indianapolis Approach' });
  assert.equal(lookupNames(index, 'BMG_TWR').shortName, 'BMG LC');
});

test('lookupNames: successive positions match IND_E*_APP', () => {
  assert.equal(lookupNames(index, 'IND_E1_APP').shortName, 'IND E');
  assert.equal(lookupNames(index, 'IND_E2_APP').radioName, 'Indianapolis Approach');
});

test('lookupNames: the longest base wins, and exact beats wildcard', () => {
  assert.equal(lookupNames(index, 'IND_EM_APP').radioName, 'Indianapolis Guard');
  assert.equal(lookupNames(index, 'IND_EM1_APP').radioName, 'Indianapolis Guard');
});

test('lookupNames: no match for another suffix, prefix, or a retired position', () => {
  assert.equal(lookupNames(index, 'IND_E1_TWR'), null);
  assert.equal(lookupNames(index, 'LAF_E_APP'), null);
  assert.equal(lookupNames(index, 'OLD_X_APP'), null);
  assert.equal(lookupNames(index, 'BMG_1_TWR'), null); // two-part bases aren't wildcarded
});

test('applyNames: falls back to the default callsign, and leaves unknowns unnamed', () => {
  const facilities = [{
    controllers: [
      { callsign: 'IND_E1_APP', defaultCallsign: 'IND_E_APP', extraPositions: [{ callsign: 'IND_EM_APP' }] },
      { callsign: 'BMG_1_TWR', defaultCallsign: 'BMG_TWR', extraPositions: [] },
      { callsign: 'ZZZ_CTR', defaultCallsign: 'ZZZ_CTR', extraPositions: [] },
    ],
  }];
  const bookings = [{ callsign: 'BMG_TWR' }];
  applyNames(index, facilities, bookings);
  const [e, bmg, zzz] = facilities[0].controllers;
  assert.equal(e.shortName, 'IND E');
  assert.equal(e.extraPositions[0].shortName, undefined); // guard has no short name -> callsign shows
  assert.equal(e.extraPositions[0].radioName, 'Indianapolis Guard');
  assert.equal(bmg.shortName, 'BMG LC');
  assert.equal(zzz.shortName, undefined);
  assert.equal(bookings[0].radioName, 'Bloomington Tower');
});

test('applyNames: no index (CMS down) changes nothing', () => {
  const facilities = [{ controllers: [{ callsign: 'IND_E_APP', extraPositions: [] }] }];
  applyNames(null, facilities);
  assert.equal('shortName' in facilities[0].controllers[0], false);
});
