import { MAX_NICKNAME_LENGTH } from './nicknames';
import type { VatusaName } from './vatusa';

/**
 * The one rule for a member's Discord nickname, until member-profile moves nicknames to identity's
 * `name`. Null leaves their nickname as it is.
 *
 * 1. Their identity `preferred_name`, as typed, cut to 32 characters.
 * 2. Else VATUSA's "First Last", or "First CID" when VATUSA's name-privacy flag is on, shortened as
 *    VATUSA's bot does.
 * 3. Else (VATUSA doesn't know them) identity's `given_name` and their CID.
 *
 * Nobody rated below 1 gets one. `identity` is null when identity has no user for them or couldn't be
 * reached.
 */
export function nicknameFor(
  person: { cid: number; rating: number; name: VatusaName | null },
  identity: { preferredName: string | null; givenName: string | null } | null,
): string | null {
  if (person.rating < 1) return null;
  const preferred = identity?.preferredName;
  if (preferred?.trim()) return cut(preferred);
  if (person.name) return shorten(person.name.privacy ? `${person.name.first} ${person.cid}` : `${person.name.first} ${person.name.last}`);
  const given = identity?.givenName?.trim();
  if (given) return cut(`${given} ${person.cid}`);
  return null;
}

/** Discord counts characters, not UTF-16 units; so does this. */
const characters = (text: string) => Array.from(text);
const cut = (text: string) => characters(text).slice(0, MAX_NICKNAME_LENGTH).join('');

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
