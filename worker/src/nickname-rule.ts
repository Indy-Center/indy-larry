import { MAX_NICKNAME_LENGTH } from './nicknames';
import type { VatusaName } from './vatusa';

/**
 * The one rule for a member's Discord nickname. Null leaves their nickname as it is.
 *
 * 1. Nobody rated below 1 gets one.
 * 2. Else, when identity knows them and they have set a preferred name, identity's `name` (that
 *    preferred name), shortened as VATUSA's bot does.
 * 3. Else, when VATUSA's name-privacy flag is on, VATUSA's "First CID", shortened the same way, so
 *    identity's fallback to their VATSIM first and last name never shows a private member's surname.
 * 4. Else identity's `name` (their VATSIM first and last name) whenever identity knows them, shortened
 *    the same way.
 * 5. Else VATUSA's "First Last", shortened the same way.
 * 6. Else null.
 *
 * `identity` is null when identity has no user for them or couldn't be reached.
 */
export function nicknameFor(
  person: { cid: number; rating: number; name: VatusaName | null },
  identity: { name: string | null; preferredName: string | null } | null,
): string | null {
  if (person.rating < 1) return null;
  const name = identity?.name?.trim();
  if (name && identity?.preferredName?.trim()) return shorten(name);
  if (person.name?.privacy) return shorten(`${person.name.first} ${person.cid}`);
  if (name) return shorten(name);
  if (person.name) return shorten(`${person.name.first} ${person.name.last}`);
  return null;
}

/** Discord counts characters, not UTF-16 units; so does this. */
const characters = (text: string) => Array.from(text);
const cut = (text: string, max = MAX_NICKNAME_LENGTH) => characters(text).slice(0, max).join('');

/**
 * VATUSA's bot's shortenNickname (discord-bot-v3, internal/bot/nickname.go) with no title: the name as
 * it is, then first and last, then first and last initial, then first, then the first name cut short.
 */
function shorten(name: string): string {
  const fits = (candidate: string) => characters(candidate).length <= MAX_NICKNAME_LENGTH;
  if (fits(name)) return name;
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return name;
  const first = parts[0]!;
  const last = parts[parts.length - 1]!;
  const candidates = parts.length > 1 ? [`${first} ${last}`, `${first} ${characters(last)[0]}`, first] : [first];
  return candidates.find(fits) ?? cut(first);
}
