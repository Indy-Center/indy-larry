import { describe, expect, it } from 'vitest';
import { entryMatches } from '../src/criteria';
import type { Condition, MappingEntry } from '../src/mapping';
import type { VatusaPerson } from '../src/vatusa';

/** A ZID home S3 with no staff roles; each case changes what it needs. */
const person = (overrides: Partial<VatusaPerson> = {}): VatusaPerson => ({
  cid: 1000001,
  discordId: '500000000000000001',
  rating: 4,
  ratingShort: 'S3',
  facility: 'ZID',
  rosters: ['ZID'],
  roles: [],
  name: null,
  ...overrides,
});

const entry = (...criteria: Condition[][]): MappingEntry => ({
  name: 'Test',
  discordRoleId: '600000000000000001',
  criteria: criteria.map((conditions) => ({ conditions })),
});

describe('each condition type', () => {
  const cases: [string, Condition, Partial<VatusaPerson>, boolean][] = [
    ['rating matches rating_short', { type: 'rating', value: 'S3' }, {}, true],
    ['rating is not another rating', { type: 'rating', value: 'C1' }, {}, false],
    ['home matches the home facility', { type: 'home', value: 'ZID' }, {}, true],
    ['home is not a facility visited', { type: 'home', value: 'ZID' }, { facility: 'ZNY', rosters: ['ZID'] }, false],
    ['home_or_visit matches a roster the person is on', { type: 'home_or_visit', value: 'ZME' }, { facility: 'ZNY', rosters: ['ZME'] }, true],
    ['home_or_visit is not a roster the person is off', { type: 'home_or_visit', value: 'ZME' }, {}, false],
    ['facility_role matches that role at that facility', { type: 'facility_role', value: 'ZID:MTR' }, { roles: [{ facility: 'ZID', role: 'MTR' }] }, true],
    ['facility_role is not that role elsewhere', { type: 'facility_role', value: 'ZID:MTR' }, { roles: [{ facility: 'ZTL', role: 'MTR' }] }, false],
    ['facility_role is not another role there', { type: 'facility_role', value: 'ZID:MTR' }, { roles: [{ facility: 'ZID', role: 'INS' }] }, false],
    ['role matches that role at any facility', { type: 'role', value: 'ACE' }, { roles: [{ facility: 'ZHQ', role: 'ACE' }] }, true],
    ['role is not another role', { type: 'role', value: 'ACE' }, { roles: [{ facility: 'ZHQ', role: 'DCC' }] }, false],
    ['division_staff matches US2', { type: 'division_staff' }, { roles: [{ facility: 'ZHQ', role: 'US2' }] }, true],
    ['division_staff is not USWT', { type: 'division_staff' }, { roles: [{ facility: 'ZHQ', role: 'USWT' }] }, false],
    ['division_staff is not facility staff', { type: 'division_staff' }, { roles: [{ facility: 'ZID', role: 'ATM' }] }, false],
    ['all matches anyone rated', { type: 'all' }, {}, true],
  ];

  it.each(cases)('%s', (_, condition, overrides, expected) => {
    expect(entryMatches(entry([condition]), person(overrides))).toBe(expected);
  });
});

describe('ratings below 1', () => {
  it.each([0, -1])('rating %i matches nothing, not even all', (rating) => {
    const suspended = person({ rating, ratingShort: rating === 0 ? 'SUS' : 'INA' });
    expect(entryMatches(entry([{ type: 'all' }]), suspended)).toBe(false);
    expect(entryMatches(entry([{ type: 'home', value: 'ZID' }]), suspended)).toBe(false);
  });
});

describe('criteria and conditions', () => {
  const homeI1: Condition[] = [
    { type: 'home', value: 'ZID' },
    { type: 'rating', value: 'I1' },
  ];

  it('needs every condition in one criterion', () => {
    expect(entryMatches(entry(homeI1), person({ ratingShort: 'I1', rating: 8 }))).toBe(true);
    expect(entryMatches(entry(homeI1), person({ ratingShort: 'I1', rating: 8, facility: 'ZNY' }))).toBe(false);
    expect(entryMatches(entry(homeI1), person())).toBe(false);
  });

  it('matches when any one criterion does', () => {
    const either = entry([{ type: 'facility_role', value: 'ZID:MTR' }], homeI1);
    expect(entryMatches(either, person({ roles: [{ facility: 'ZID', role: 'MTR' }] }))).toBe(true);
    expect(entryMatches(either, person({ ratingShort: 'I1', rating: 8 }))).toBe(true);
    expect(entryMatches(either, person())).toBe(false);
  });
});
