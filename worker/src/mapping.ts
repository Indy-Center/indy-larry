import type { RosterFacility } from './vatusa';

/**
 * The mapping: which Discord role and which TeamSpeak server group each VATUSA role gives. The role sync
 * adds and removes only the roles and groups named here; anything else a member holds is left alone.
 *
 * Same shape as VATUSA's bot config (VATUSA/discord-bot-v3-config), typed so the build catches a bad
 * entry: an entry matches when any one of its criteria does, and a criterion when every one of its
 * conditions does. Nobody rated below 1 matches anything. Seeded from VATUSA's config/zid.yaml at
 * ed42eca7, with the same names and Discord role IDs, so nobody's roles change on the day it goes live.
 * The TeamSpeak group IDs are the legacy TeamSpeak bot's: its roles table, matched by name to the
 * server's groups (sgid) and given to the entry of the same meaning.
 *
 * Change it by pull request: a wrong entry hands its role to everyone it matches.
 */

/** One test of a member's VATUSA record, evaluated as VATUSA's bot does (criteria.ts). */
export type Condition =
  /** Their rating, by its short name (OBS, S1 … ADM). */
  | { type: 'rating'; value: string }
  /** Their home facility. */
  | { type: 'home'; value: string }
  /** On that facility's roster, home or visiting. Only the rosters the sync fetches can be named. */
  | { type: 'home_or_visit'; value: RosterFacility }
  /** Holds that role at that facility, as FAC:ROLE. */
  | { type: 'facility_role'; value: `${string}:${string}` }
  /** Holds that role at any facility. */
  | { type: 'role'; value: string }
  /** Holds a division staff role: one starting US with a digit in it (US2, not USWT). */
  | { type: 'division_staff' }
  /** Anyone rated 1 or above. */
  | { type: 'all' };

export type Criterion = { conditions: Condition[] };

export type MappingEntry = {
  name: string;
  /** The Discord role this entry gives. An entry without one changes nothing in Discord. */
  discordRoleId?: string;
  /** The TeamSpeak server group (sgid) this entry gives. An entry without one changes nothing in TeamSpeak. */
  teamspeakGroupId?: number;
  criteria: Criterion[];
};

/**
 * TeamSpeak groups the sync never touches: 6 Server Admin, 8 Guest (the default group), 27 teamspeak-bot
 * (the bot's own), and the query groups 1 Guest Server Query and 2 Admin Server Query.
 */
export const ADMIN_GROUPS: readonly number[] = [1, 2, 6, 8, 27];

/** The entries as given, or throws for one naming an admin group. Run on the mapping when it loads. */
export function checkMapping(entries: MappingEntry[]): MappingEntry[] {
  for (const entry of entries) {
    if (entry.teamspeakGroupId !== undefined && ADMIN_GROUPS.includes(entry.teamspeakGroupId)) {
      throw new Error(`Mapping entry ${entry.name}: TeamSpeak group ${entry.teamspeakGroupId} is an admin group`);
    }
  }
  return entries;
}

const rating = (value: string): Criterion[] => [{ conditions: [{ type: 'rating', value }] }];
const facilityRoles = (...values: `${string}:${string}`[]): Criterion[] => values.map((value) => ({ conditions: [{ type: 'facility_role', value }] }));
const NEIGHBOURS = ['ZME', 'ZKC', 'ZTL', 'ZDC', 'ZOB', 'ZAU'] as const;
const neighbourRole = (role: string) => facilityRoles(...NEIGHBOURS.map((facility) => `${facility}:${role}` as const));

export const MAPPING: MappingEntry[] = checkMapping([
  { name: 'Observer', discordRoleId: '896858108054368298', criteria: rating('OBS') },
  { name: 'Student 1', discordRoleId: '896858107702042655', teamspeakGroupId: 17, criteria: rating('S1') },
  { name: 'Student 2', discordRoleId: '896858107404255233', teamspeakGroupId: 16, criteria: rating('S2') },
  { name: 'Student 3', discordRoleId: '896858107051909159', teamspeakGroupId: 15, criteria: rating('S3') },
  { name: 'Controller 1', discordRoleId: '896858105789440041', teamspeakGroupId: 14, criteria: rating('C1') },
  { name: 'Controller 3', discordRoleId: '896858105567129631', teamspeakGroupId: 13, criteria: rating('C3') },
  { name: 'Instructor 1', discordRoleId: '896858105390977084', teamspeakGroupId: 12, criteria: rating('I1') },
  { name: 'Instructor 3', discordRoleId: '896858104677924916', teamspeakGroupId: 11, criteria: rating('I3') },
  // TeamSpeak's VATSIM Supervisor and VATSIM Administrator.
  { name: 'Supervisor', discordRoleId: '896858104187220030', teamspeakGroupId: 20, criteria: rating('SUP') },
  { name: 'Administrator', discordRoleId: '896858103914561596', teamspeakGroupId: 21, criteria: rating('ADM') },
  { name: 'Mentor', discordRoleId: '1178168909115969707', teamspeakGroupId: 19, criteria: facilityRoles('ZID:MTR') },
  { name: 'VATUSA Staff', discordRoleId: '991370038340759593', criteria: [{ conditions: [{ type: 'division_staff' }] }] },
  { name: 'Senior Staff', discordRoleId: '1300575634296410164', teamspeakGroupId: 18, criteria: facilityRoles('ZID:TA', 'ZID:ATM', 'ZID:DATM') },
  { name: 'Events Team', discordRoleId: '1296503795429150835', teamspeakGroupId: 24, criteria: facilityRoles('ZID:EC') },
  // Facility Working Group is the Facilities Team's new name; TeamSpeak's group 25 is the same group.
  { name: 'Facility Working Group', discordRoleId: '1148442325689835540', teamspeakGroupId: 25, criteria: facilityRoles('ZID:FE') },
  { name: 'Tech Team', discordRoleId: '1296502514656481382', teamspeakGroupId: 23, criteria: facilityRoles('ZID:WM') },
  {
    name: 'Training Staff',
    discordRoleId: '477496066590375947',
    criteria: [
      ...facilityRoles('ZID:MTR', 'ZID:INS'),
      { conditions: [{ type: 'home', value: 'ZID' }, { type: 'rating', value: 'I1' }] },
      { conditions: [{ type: 'home', value: 'ZID' }, { type: 'rating', value: 'I3' }] },
    ],
  },
  { name: 'Ace Team', discordRoleId: '700873587388711012', criteria: [{ conditions: [{ type: 'role', value: 'ACE' }] }] },
  { name: 'Air Traffic Controller', discordRoleId: '477495351838900254', teamspeakGroupId: 10, criteria: [{ conditions: [{ type: 'home_or_visit', value: 'ZID' }] }] },
  {
    name: 'Neighboring Controllers',
    discordRoleId: '1544793606068506694',
    criteria: (['ZME', 'ZDC', 'ZAU', 'ZOB', 'ZTL', 'ZKC'] as const).map((value) => ({ conditions: [{ type: 'home_or_visit', value }] })),
  },
  { name: 'Neighboring Senior Staff', discordRoleId: '1544788828534079529', criteria: [...neighbourRole('ATM'), ...neighbourRole('DATM'), ...neighbourRole('TA')] },
  { name: 'Neighboring Events Coordinators', discordRoleId: '1544788164969758822', criteria: neighbourRole('EC') },
  { name: 'Neighboring Facility Engineers', discordRoleId: '1544788395966992506', criteria: neighbourRole('FE') },
  { name: 'Neighboring Webmasters', discordRoleId: '1544788466863317124', criteria: neighbourRole('WM') },
  { name: 'Member', discordRoleId: '1125403438545641564', teamspeakGroupId: 7, criteria: [{ conditions: [{ type: 'all' }] }] },
]);
