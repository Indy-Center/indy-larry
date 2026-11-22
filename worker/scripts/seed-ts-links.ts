// The cutover's one-off: sends the legacy TeamSpeak bot's links to larry, which links each UID to its member.
//   LARRY_URL=https://indy-larry.indy-center.workers.dev TEAMSPEAK_SEED_SECRET=... \
//     npm run seed-ts-links -- <path to database.sqlite> [--dry-run]
// Needs Node 22.18+ (it runs the TypeScript as is) for `node:sqlite`. See the README's "Role sync".
import { DatabaseSync } from 'node:sqlite';

declare const process: { argv: string[]; env: Record<string, string | undefined>; exitCode?: number };

export type SeedRow = { discordId: string; uid: string };
type Outcome = 'written' | 'already-linked' | 'uid-on-another-member' | 'extra-uid' | 'no-cid' | 'never-signed-in';
type Result = SeedRow & { outcome: Outcome; cid?: number };

/** The most rows one request carries (the route's limit). */
export const BATCH = 50;

// What each outcome is called in the report, and what it means for the member.
const HEADINGS: Record<Outcome, string> = {
  written: 'Written',
  'already-linked': 'Already linked (left alone)',
  'uid-on-another-member': 'UID already on another member (skipped)',
  'extra-uid': 'Extra UID (the member keeps their first)',
  'no-cid': 'No CID for the Discord ID (dropped; they get the link message on their next connect)',
  'never-signed-in': 'Never signed in (dropped)',
};

/** The `members` table's rows: the Discord ID and TeamSpeak unique ID columns, found by name whatever their case or underscores. */
export function readRows(path: string): SeedRow[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const columns = db.prepare('PRAGMA table_info(members)').all().map((column) => String(column.name));
    const find = (...names: string[]) => columns.find((column) => names.includes(column.toLowerCase().replaceAll('_', '')));
    const discord = find('discordid');
    const teamspeak = find('teamspeakid', 'teamspeakuid', 'tsid', 'tsuid');
    if (!discord || !teamspeak) throw new Error(`members has columns [${columns.join(', ')}]; expected a Discord ID and a TeamSpeak ID`);
    const query = db.prepare(`SELECT "${discord}" AS d, "${teamspeak}" AS t FROM members ORDER BY rowid`);
    // Discord IDs are past 2^53: read them exactly.
    query.setReadBigInts(true);
    return query
      .all()
      .map((row) => ({ discordId: String(row.d ?? '').trim(), uid: String(row.t ?? '').trim() }))
      .filter((row) => row.discordId !== '' && row.uid !== '');
  } finally {
    db.close();
  }
}

/** Batches of at most BATCH rows, never splitting one Discord ID's rows, so "extra UID" is judged in one request. */
export function batches(rows: SeedRow[]): SeedRow[][] {
  const byMember = new Map<string, SeedRow[]>();
  for (const row of rows) byMember.set(row.discordId, [...(byMember.get(row.discordId) ?? []), row]);
  const out: SeedRow[][] = [];
  let current: SeedRow[] = [];
  for (const group of byMember.values()) {
    if (group.length > BATCH) throw new Error(`Discord ID ${group[0]!.discordId} has ${group.length} rows, more than a batch of ${BATCH}`);
    if (current.length + group.length > BATCH) {
      out.push(current);
      current = [];
    }
    current.push(...group);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Posts every batch to larry and returns the combined results. Stops, throwing, at the first batch larry refuses. */
export async function seed(rows: SeedRow[], options: { url: string; secret: string; dryRun: boolean; fetch?: typeof fetch }): Promise<Result[]> {
  const send = options.fetch ?? fetch;
  const results: Result[] = [];
  for (const batch of batches(rows)) {
    const res = await send(new URL('/teamspeak/seed', options.url), {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows: batch, dryRun: options.dryRun }),
    });
    const body = (await res.json().catch(() => null)) as { results?: Result[]; error?: string } | null;
    if (!res.ok || !body?.results) {
      throw new Error(`larry answered ${res.status}${body?.error ? `: ${body.error}` : ''} after ${results.length} of ${rows.length} rows; running it again is safe`);
    }
    results.push(...body.results);
  }
  return results;
}

export function report(results: Result[], dryRun: boolean): string {
  const lines = [`${dryRun ? 'Dry run, nothing written: ' : ''}${results.length} rows`];
  for (const [outcome, heading] of Object.entries(HEADINGS)) {
    const these = results.filter((result) => result.outcome === outcome);
    lines.push(`${dryRun && outcome === 'written' ? 'Would be written' : heading}: ${these.length}`);
    if (outcome !== 'written') for (const result of these) lines.push(`  Discord ${result.discordId}, TeamSpeak ${result.uid}${result.cid === undefined ? '' : `, CID ${result.cid}`}`);
  }
  return lines.join('\n');
}

async function main(args: string[], env: Record<string, string | undefined>) {
  const dryRun = args.includes('--dry-run');
  const paths = args.filter((arg) => arg !== '--dry-run');
  const { LARRY_URL: url, TEAMSPEAK_SEED_SECRET: secret } = env;
  if (paths.length !== 1 || !url || !secret) {
    console.error('Usage: LARRY_URL=<larry\'s address> TEAMSPEAK_SEED_SECRET=<secret> npm run seed-ts-links -- <database.sqlite> [--dry-run]');
    process.exitCode = 2;
    return;
  }
  try {
    const rows = readRows(paths[0]!);
    console.log(`Read ${rows.length} rows from ${paths[0]}`);
    console.log(report(await seed(rows, { url, secret, dryRun }), dryRun));
  } catch (error) {
    console.error((error as Error).message);
    process.exitCode = 1;
  }
}

if (process.argv[1]?.endsWith('seed-ts-links.ts')) await main(process.argv.slice(2), process.env);
