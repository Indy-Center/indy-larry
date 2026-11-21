import { describe, expect, it } from 'vitest';
import { rolesFor } from '../src/criteria';
import { checkMapping, MAPPING, type MappingEntry } from '../src/mapping';
import { peopleFrom } from '../src/vatusa';
import { lists, record, role } from './vatusa-records';

/** The mapping names VATUSA's bot would give the person with this CID, worked out by hand from zid.yaml. */
function namesFor(cid: number, from: ReturnType<typeof lists>): string[] {
  const person = peopleFrom(from).find((candidate) => candidate.cid === cid);
  if (!person) throw new Error(`${cid} is on no list`);
  return rolesFor(person).map((entry) => entry.name).sort();
}

describe('the seeded mapping', () => {
  it('has unique names and Discord role IDs, each a Discord ID', () => {
    const ids = MAPPING.map((entry) => entry.discordRoleId);
    expect(new Set(MAPPING.map((entry) => entry.name)).size).toBe(MAPPING.length);
    expect(new Set(ids).size).toBe(MAPPING.length);
    for (const id of ids) expect(id).toMatch(/^\d{17,20}$/);
  });

  it('gives a home S3 their rating, Air Traffic Controller and Member', () => {
    const from = lists({ ZID: [record({ cid: 1000001, rating: 4, rating_short: 'S3' })] });
    expect(namesFor(1000001, from)).toEqual(['Air Traffic Controller', 'Member', 'Student 3']);
  });

  it('gives a visiting C1 who mentors at ZID Mentor and Training Staff too', () => {
    const visitor = record({ cid: 1000002, facility: 'ZNY', rating: 5, rating_short: 'C1', roles: [role(1000002, 'ZID', 'MTR')] });
    expect(namesFor(1000002, lists({ ZID: [visitor] }))).toEqual(['Air Traffic Controller', 'Controller 1', 'Member', 'Mentor', 'Training Staff']);
  });

  it("gives ZME's ATM the neighbouring roles, found on ZME's roster and the staff list", () => {
    const atm = record({ cid: 1000003, facility: 'ZME', rating: 5, rating_short: 'C1', roles: [role(1000003, 'ZME', 'ATM')] });
    expect(namesFor(1000003, lists({ ZME: [atm] }, [atm]))).toEqual(['Controller 1', 'Member', 'Neighboring Controllers', 'Neighboring Senior Staff']);
  });

  it('gives a ZHQ ACE member from elsewhere Ace Team, from the staff list', () => {
    const ace = record({ cid: 1000004, facility: 'ZNY', rating: 8, rating_short: 'C3', roles: [role(1000004, 'ZHQ', 'ACE')] });
    expect(namesFor(1000004, lists({}, [ace], [ace]))).toEqual(['Ace Team', 'Controller 3', 'Member']);
  });

  it('gives Ace Team to someone on the ACE list whose roster entry lacks the role', () => {
    const from = lists({ ZID: [record({ cid: 1000005 })] }, [], [{ cid: 1000005 }]);
    expect(namesFor(1000005, from)).toEqual(['Ace Team', 'Air Traffic Controller', 'Member', 'Student 3']);
  });

  it('gives a home I1 Instructor 1 and Training Staff', () => {
    const from = lists({ ZID: [record({ cid: 1000006, rating: 8, rating_short: 'I1' })] });
    expect(namesFor(1000006, from)).toEqual(['Air Traffic Controller', 'Instructor 1', 'Member', 'Training Staff']);
  });

  it('gives VATUSA Staff to a division staff member, and nothing to someone inactive', () => {
    const us2 = record({ cid: 1000007, facility: 'ZHQ', rating: 8, rating_short: 'C3', roles: [role(1000007, 'ZHQ', 'US2')] });
    const inactive = record({ cid: 1000008, rating: -1, rating_short: 'INA', roles: [role(1000008, 'ZID', 'MTR')] });
    const from = lists({ ZID: [inactive] }, [us2]);
    expect(namesFor(1000007, from)).toEqual(['Controller 3', 'Member', 'VATUSA Staff']);
    expect(namesFor(1000008, from)).toEqual([]);
  });
});

describe('checking a mapping when it loads', () => {
  const certification = { type: 'certification', value: 'T-RC' } as const;

  it('accepts the seeded mapping', () => {
    expect(() => checkMapping(MAPPING)).not.toThrow();
  });

  it('accepts a certification entry that gives only a Discord role', () => {
    const entries: MappingEntry[] = [{ name: 'Radar', discordRoleId: '900000000000000001', criteria: [{ conditions: [certification] }] }];
    expect(() => checkMapping(entries)).not.toThrow();
  });

  it("refuses a certification condition on an entry with a TeamSpeak group, in any criterion", () => {
    const entries: MappingEntry[] = [
      { name: 'Radar', discordRoleId: '900000000000000001', teamspeakGroupId: 12, criteria: [{ conditions: [{ type: 'all' }] }, { conditions: [{ type: 'all' }, certification] }] },
    ];
    expect(() => checkMapping(entries)).toThrow("Mapping entry Radar: certifications can't give TeamSpeak groups");
  });

  it('accepts a TeamSpeak group on an entry with no certification condition', () => {
    expect(() => checkMapping([{ name: 'Members', teamspeakGroupId: 12, criteria: [{ conditions: [{ type: 'all' }] }] }])).not.toThrow();
  });
});
