/**
 * VATUSA's public lists, the role sync's source for ratings, facilities and staff roles (no API key).
 */

/** The facilities whose roster/both the sync fetches: ZID and its neighbours. */
export const ROSTER_FACILITIES = ['ZID', 'ZME', 'ZDC', 'ZAU', 'ZOB', 'ZTL', 'ZKC'] as const;
export type RosterFacility = (typeof ROSTER_FACILITIES)[number];

/** What the sync knows about one CID, put together from every list they are on. */
export type VatusaPerson = {
  cid: number;
  /** The Discord account they gave VATUSA, or null. */
  discordId: string | null;
  rating: number;
  /** OBS, S1 … ADM. */
  ratingShort: string;
  /** Their home facility. */
  facility: string;
  /** The fetched rosters they are on, home or visiting. */
  rosters: RosterFacility[];
  /** Every role entry they hold, at any facility. */
  roles: { facility: string; role: string }[];
  /** The training app's certification and endorsement codes they hold. Filled in when they are synced. */
  credentials: string[];
  /** Their name as VATUSA has it, and whether they asked VATUSA to hide their last name. Null when VATUSA doesn't know them. */
  name: VatusaName | null;
};

export type VatusaName = { first: string; last: string; privacy: boolean };

/** One entry of roster/both or integration/staff, as far as the sync reads it. */
export type VatusaRecord = {
  cid: number;
  fname: string;
  lname: string;
  facility: string;
  rating: number;
  rating_short: string;
  flag_nameprivacy: boolean;
  /** A string once parsed (parseVatusaBody); on the wire it is a number too big to keep exact. */
  discord_id: string | null;
  roles: { facility: string; role: string; [key: string]: unknown }[];
  [key: string]: unknown;
};

/** The nine lists, as fetched at the start of a run. */
export type VatusaLists = {
  rosters: Record<RosterFacility, VatusaRecord[]>;
  staff: VatusaRecord[];
  /** user/roles/ZHQ/ACE: only CIDs and names. */
  ace: { cid: number; fname: string; lname: string }[];
};

/** Everyone on the lists, one entry per CID, with their rosters and role entries put together. */
export function peopleFrom(lists: VatusaLists): VatusaPerson[] {
  const people = new Map<number, VatusaPerson>();
  const add = (entry: VatusaRecord, roster?: RosterFacility) => {
    let person = people.get(entry.cid);
    if (!person) {
      person = newPerson(entry);
      people.set(entry.cid, person);
    }
    person.discordId ??= discordId(entry.discord_id);
    if (roster && !person.rosters.includes(roster)) person.rosters.push(roster);
    for (const { facility, role } of entry.roles ?? []) addRole(person, facility, role);
  };

  for (const facility of ROSTER_FACILITIES) for (const entry of lists.rosters[facility]) add(entry, facility);
  for (const entry of lists.staff) add(entry);
  // The ACE list has no ratings or Discord IDs: it only adds the role to someone another list has.
  for (const { cid } of lists.ace) {
    const person = people.get(cid);
    if (person) addRole(person, 'ZHQ', 'ACE');
  }
  return [...people.values()];
}

function newPerson(entry: VatusaRecord): VatusaPerson {
  return {
    cid: entry.cid,
    discordId: null,
    rating: Number(entry.rating),
    ratingShort: entry.rating_short,
    facility: entry.facility,
    rosters: [],
    roles: [],
    credentials: [],
    name: { first: entry.fname, last: entry.lname, privacy: entry.flag_nameprivacy === true },
  };
}

/** A user record from `/v2/user/{id}`: a roster entry, plus the facilities they visit. */
export type VatusaUserRecord = VatusaRecord & { visiting_facilities?: { facility: string }[] | null };

/**
 * One person from a per-user lookup, evaluated like a list member: on the roster of their home facility
 * and of each facility they visit (as far as those are fetched lists), with their roles at every facility.
 */
export function personFromUser(record: VatusaUserRecord): VatusaPerson {
  const person = newPerson(record);
  person.discordId = discordId(record.discord_id);
  const onRoster = (facility: string) => {
    const roster = ROSTER_FACILITIES.find((id) => id === facility);
    if (roster && !person.rosters.includes(roster)) person.rosters.push(roster);
  };
  onRoster(record.facility);
  for (const visiting of record.visiting_facilities ?? []) onRoster(visiting.facility);
  for (const { facility, role } of record.roles ?? []) addRole(person, facility, role);
  return person;
}

function addRole(person: VatusaPerson, facility: string, role: string) {
  if (!person.roles.some((held) => held.facility === facility && held.role === role)) person.roles.push({ facility, role });
}

/** Only a run of digits is a Discord ID: a placeholder 0 isn't one. */
function discordId(value: unknown): string | null {
  const id = value == null ? '' : String(value);
  return /^[1-9]\d*$/.test(id) ? id : null;
}

const VATUSA_API = 'https://api.vatusa.net/v2';

/**
 * Fetch the nine lists. Returns the names of the lists that failed instead when any fetch fails or
 * comes back malformed, or any roster or the staff list comes back empty: an empty list would read as
 * everyone on it losing their roles. The ACE list may be empty.
 */
export async function fetchLists(): Promise<{ lists: VatusaLists } | { failed: string[] }> {
  const failed: string[] = [];
  const get = async <T>(path: string, name: string, mayBeEmpty = false): Promise<T[]> => {
    try {
      const res = await fetch(`${VATUSA_API}${path}`);
      if (!res.ok) throw new Error(`${res.status}`);
      const body = parseVatusaBody(await res.text()) as { data?: unknown };
      if (!Array.isArray(body?.data)) throw new Error('no data array');
      if (body.data.length === 0 && !mayBeEmpty) throw new Error('empty');
      return body.data as T[];
    } catch (error) {
      console.warn(`VATUSA's ${path} failed: ${String(error)}`);
      failed.push(name);
      return [];
    }
  };

  const [staff, ace, ...rosters] = await Promise.all([
    get<VatusaRecord>('/integration/staff', 'the staff list'),
    get<VatusaLists['ace'][number]>('/user/roles/ZHQ/ACE', 'the ACE list', true),
    ...ROSTER_FACILITIES.map((facility) => get<VatusaRecord>(`/facility/${facility}/roster/both`, `${facility}'s roster`)),
  ]);
  if (failed.length > 0) return { failed };
  const byFacility = Object.fromEntries(ROSTER_FACILITIES.map((facility, i) => [facility, rosters[i]!])) as VatusaLists['rosters'];
  return { lists: { rosters: byFacility, staff, ace } };
}

/**
 * Parse a VATUSA body without rounding Discord IDs. VATUSA sends `discord_id` as a bare JSON number,
 * and snowflakes are past Number.MAX_SAFE_INTEGER, so the digits are quoted before parsing (as
 * training-tools' parseRosterBody does).
 */
export function parseVatusaBody(text: string): unknown {
  return JSON.parse(text.replace(/"discord_id"\s*:\s*(\d+)/g, '"discord_id":"$1"'));
}
