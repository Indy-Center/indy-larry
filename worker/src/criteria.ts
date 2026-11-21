import { MAPPING, type Condition, type MappingEntry } from './mapping';
import type { VatusaPerson } from './vatusa';

/**
 * The mapping's conditions, evaluated as VATUSA's bot does (VATUSA/discord-bot-v3, internal/bot/roles.go,
 * read at 3092c305): an entry matches when any criterion does, a criterion when all its conditions do,
 * and nobody rated below 1 matches anything.
 */

/** The mapping entries this person matches. */
export function rolesFor(person: VatusaPerson, mapping: MappingEntry[] = MAPPING): MappingEntry[] {
  return mapping.filter((entry) => entryMatches(entry, person));
}

export function entryMatches(entry: MappingEntry, person: VatusaPerson): boolean {
  if (!(person.rating >= 1)) return false;
  return entry.criteria.some((criterion) => criterion.conditions.every((condition) => conditionMatches(condition, person)));
}

function conditionMatches(condition: Condition, person: VatusaPerson): boolean {
  switch (condition.type) {
    case 'all':
      return true;
    case 'rating':
      return person.ratingShort === condition.value;
    case 'home':
      return person.facility === condition.value;
    case 'home_or_visit':
      return person.rosters.includes(condition.value);
    case 'facility_role': {
      const [facility, role] = condition.value.split(':');
      return person.roles.some((held) => held.facility === facility && held.role === role);
    }
    case 'role':
      return person.roles.some((held) => held.role === condition.value);
    case 'division_staff':
      return person.roles.some((held) => held.role.startsWith('US') && /\d/.test(held.role));
  }
}
