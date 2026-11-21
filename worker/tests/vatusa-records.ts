import type { VatusaLists, VatusaRecord } from '../src/vatusa';

/**
 * VATUSA-shaped records for tests: the fields VATUSA's roster/both and integration/staff send, with
 * made-up CIDs, names and Discord IDs. `discord_id` is a string here, as it is once parsed.
 */
export function record(overrides: Partial<VatusaRecord> & Pick<VatusaRecord, 'cid'>): VatusaRecord {
  return {
    fname: 'Test',
    lname: `Person${overrides.cid}`,
    facility: 'ZID',
    rating: 4,
    rating_short: 'S3',
    flag_nameprivacy: false,
    discord_id: null,
    roles: [],
    ...overrides,
  };
}

export const role = (cid: number, facility: string, name: string) => ({ id: cid * 10, cid, facility, role: name, created_at: '2025-01-01T00:00:00+00:00' });

/** Lists with nothing on them but what a test adds. */
export function lists(overrides: Partial<{ [K in keyof VatusaLists['rosters']]: VatusaRecord[] }> = {}, staff: VatusaRecord[] = [], ace: { cid: number }[] = []): VatusaLists {
  return {
    rosters: { ZID: [], ZME: [], ZDC: [], ZAU: [], ZOB: [], ZTL: [], ZKC: [], ...overrides },
    staff,
    ace: ace.map(({ cid }) => ({ cid, fname: 'Ace', lname: `Member${cid}` })),
  };
}
