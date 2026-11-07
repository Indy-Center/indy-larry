const test = require('node:test');
const assert = require('node:assert/strict');
const { buildNameIndex, resolvePosition, airportOf, applyNames } = require('../src/names');

// Shaped like cms.flyindycenter.com/api/public/v1/positions
const cms = [
  { id: 'A', callsign: 'IND_E_APP', shortName: 'IND E', radioName: 'Indianapolis Approach', facility: { id: 'IND' }, frequency: 123000000, retired: false },
  { id: 'B', callsign: 'IND_EM_APP', shortName: null, radioName: 'Indianapolis Guard', facility: { id: 'IND' }, retired: false },
  { id: 'C', callsign: 'BMG_TWR', shortName: 'BMG LC', radioName: 'Bloomington Tower', facility: { id: 'BMG' }, retired: false },
  { id: 'D', callsign: 'OLD_X_APP', shortName: 'OLD X', radioName: 'Old Approach', facility: { id: 'OLD' }, retired: true },
  { id: 'E', callsign: 'IND_83_CTR', shortName: 'FLM 83', radioName: 'Indy Center', facility: { id: 'ZID' }, retired: false },
];
const index = buildNameIndex(cms);
const cs = (callsign, positionId) => resolvePosition(index, callsign, positionId)?.callsign;

test('resolvePosition: exact callsign', () => {
  assert.equal(cs('IND_E_APP'), 'IND_E_APP');
  assert.equal(cs('ind_e_app'), 'IND_E_APP');
});

test('resolvePosition: relief drops one trailing digit from the middle part', () => {
  assert.equal(cs('IND_E1_APP'), 'IND_E_APP');
  assert.equal(cs('IND_831_CTR'), 'IND_83_CTR');
  assert.equal(cs('IND_EM1_APP'), 'IND_EM_APP');
});

test('resolvePosition: relief drops an all-digit middle', () => {
  assert.equal(cs('BMG_1_TWR'), 'BMG_TWR');
});

test('resolvePosition: exact beats relief, and one digit only', () => {
  assert.equal(cs('IND_EM_APP'), 'IND_EM_APP');
  assert.equal(cs('IND_E12_APP'), undefined);
});

test('resolvePosition: other suffix, prefix or a retired position is unknown', () => {
  assert.equal(cs('IND_E1_TWR'), undefined);
  assert.equal(cs('LAF_E_APP'), undefined);
  assert.equal(cs('OLD_X_APP'), undefined);
});

test('resolvePosition: a vNAS id wins and the callsign is not read, but a retired position is still found by id', () => {
  assert.equal(cs('ZZZ_X_APP', 'A'), 'IND_E_APP');
  assert.equal(cs('IND_E_APP', 'C'), 'BMG_TWR');
  assert.equal(cs('IND_E_APP', 'D'), 'OLD_X_APP');
  assert.equal(cs('IND_E_APP', 'nope'), undefined);
});

test('airportOf: a cab or approach has its facility airport, a center has none', () => {
  assert.equal(airportOf(cms[0]), 'KIND');
  assert.equal(airportOf(cms[2]), 'KBMG');
  assert.equal(airportOf(cms[4]), null);
  assert.equal(airportOf({ callsign: 'X_TWR', facility: { id: 'LONG' } }), null);
  assert.equal(airportOf(null), null);
});

test('applyNames: id, then login callsign, then the default callsign; unknowns stay unnamed', () => {
  const facilities = [{
    controllers: [
      { callsign: 'IND_E1_APP', defaultCallsign: 'IND_E_APP', positionId: 'A', extraPositions: [{ callsign: 'IND_EM_APP' }] },
      { callsign: 'BMG_1_TWR', defaultCallsign: 'BMG_TWR', positionId: 'unlisted', extraPositions: [] },
      { callsign: 'ZZZ_CTR', defaultCallsign: 'ZZZ_CTR', extraPositions: [] },
    ],
  }];
  const bookings = [{ callsign: 'BMG_TWR' }];
  applyNames(index, facilities, bookings);
  const [e, bmg, zzz] = facilities[0].controllers;
  assert.equal(e.radioName, 'Indianapolis Approach');
  assert.equal(e.airport, 'KIND');
  assert.equal(e.displayFrequency, 123000000);
  assert.equal(e.extraPositions[0].radioName, 'Indianapolis Guard');
  assert.equal(bmg.radioName, 'Bloomington Tower'); // its id isn't in the CMS, so the default callsign is tried
  assert.equal(zzz.radioName, undefined);
  assert.equal(zzz.airport, undefined);
  assert.equal(bookings[0].airport, 'KBMG');
});

test('applyNames: no index (CMS down) changes nothing', () => {
  const facilities = [{ controllers: [{ callsign: 'IND_E_APP', extraPositions: [] }] }];
  applyNames(null, facilities);
  assert.equal('radioName' in facilities[0].controllers[0], false);
});
