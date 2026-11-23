import { SNOWFLAKE } from './discord';
import { readJson } from './http';
import { findByDiscordId, getUser } from './identity';
import { checkMode } from './platforms/platform';
import { heldByAnother, writeTsLink } from './platforms/teamspeak-links';
import type { RoleSyncEnv } from './role-sync';
import { fetchLists, peopleFrom, type VatusaPerson } from './vatusa';

/**
 * `POST /teamspeak/seed`: the cutover's one-off import of the legacy bot's links (seed-ts-links.ts sends
 * them). Each row's Discord ID is matched to a CID (identity's `discord_id`, else VATUSA's lists, read once
 * per request), and the UID is written with the same write confirmTsLink uses, which queues the member's
 * sync. Behind TEAMSPEAK_SEED_SECRET (bot-events.ts), a secret set for the cutover and removed after.
 */

export type TeamSpeakSeedEnv = RoleSyncEnv & {
  /** The seed script's secret. Unset refuses every call. */
  TEAMSPEAK_SEED_SECRET?: string;
};

/** The most rows one request takes. */
export const MAX_SEED_ROWS = 50;

export type SeedOutcome = 'written' | 'already-linked' | 'uid-on-another-member' | 'extra-uid' | 'no-cid' | 'never-signed-in';
export type SeedResult = { discordId: string; uid: string; outcome: SeedOutcome; cid?: number };

const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function seedLinks(request: Request, env: TeamSpeakSeedEnv): Promise<Response> {
  const body = await readJson(request);
  if (body === undefined) return json({ error: 'not JSON' }, 400);
  const { rows, dryRun } = (body ?? {}) as { rows?: unknown; dryRun?: unknown };
  if (typeof dryRun !== 'boolean' || !Array.isArray(rows) || rows.length > MAX_SEED_ROWS || !rows.every(isRow)) {
    return json({ error: `expected { rows: [{ discordId, uid }] } of at most ${MAX_SEED_ROWS}, and dryRun: true or false` }, 400);
  }
  const mode = checkMode(env);

  let people: Map<string, VatusaPerson> | undefined;
  const vatusaCid = async (discordId: string): Promise<number | null> => {
    if (!people) {
      const fetched = await fetchLists();
      if ('failed' in fetched) throw new VatusaDown(fetched.failed);
      people = new Map(peopleFrom(fetched.lists).flatMap((person) => (person.discordId ? [[person.discordId, person] as const] : [])));
    }
    return people.get(discordId)?.cid ?? null;
  };

  // CIDs and UIDs this request has written (or, in a dry run, would have), so the rest of a member's rows
  // are "extra UID" and a UID two members share goes to the first.
  const claimedCids = new Set<number>();
  const claimedUids = new Set<string>();
  const results: SeedResult[] = [];
  try {
    for (const { discordId, uid } of rows as { discordId: string; uid: string }[]) {
      const done = (outcome: SeedOutcome, cid?: number) => results.push({ discordId, uid, outcome, ...(cid === undefined ? {} : { cid }) });

      const found = await findByDiscordId(env, discordId);
      const cid = found?.cid ?? (await vatusaCid(discordId));
      if (cid === null) {
        done('no-cid');
        continue;
      }
      if (claimedCids.has(cid)) {
        done('extra-uid', cid);
        continue;
      }
      const user = found ?? (await getUser(env, cid));
      if (!user) {
        done('never-signed-in', cid);
        continue;
      }
      if (user.teamspeakUid) {
        done('already-linked', cid);
        continue;
      }
      if (claimedUids.has(uid) || (await heldByAnother(env, cid, uid))) {
        done('uid-on-another-member', cid);
        continue;
      }
      if (dryRun) {
        claimedCids.add(cid);
        claimedUids.add(uid);
        done('written', cid);
        continue;
      }
      const written = await writeTsLink(env, mode, cid, user, uid);
      if (written === 'written') {
        claimedCids.add(cid);
        claimedUids.add(uid);
      }
      done(written === 'written' ? 'written' : written === 'taken' ? 'uid-on-another-member' : 'never-signed-in', cid);
    }
  } catch (error) {
    // Rerunning is safe: what was written is "already linked" next time.
    const message = error instanceof VatusaDown ? `couldn't fetch ${error.lists.join(', ')} from VATUSA` : String(error);
    console.error(`TeamSpeak seed failed after ${results.length} of ${rows.length} rows: ${message}`);
    return json({ error: message, results }, error instanceof VatusaDown ? 503 : 502);
  }
  console.log(`TeamSpeak seed${dryRun ? ' (dry run)' : ''}: ${results.length} rows`);
  return json({ dryRun, results });
}

class VatusaDown extends Error {
  constructor(readonly lists: string[]) {
    super('VATUSA is down');
  }
}

function isRow(value: unknown): value is { discordId: string; uid: string } {
  if (!value || typeof value !== 'object') return false;
  const { discordId, uid } = value as Record<string, unknown>;
  return typeof discordId === 'string' && SNOWFLAKE.test(discordId) && typeof uid === 'string' && uid !== '';
}
