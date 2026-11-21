import { parseVatusaBody, personFromUser, type VatusaPerson, type VatusaUserRecord } from './vatusa';

/**
 * Per-user lookups for the members VATUSA's lists don't cover, each cached in KV for 24 hours, found or
 * not. A lookup that fails (not a 404) throws and caches nothing, so the job is retried.
 */

const VATUSA_API = 'https://api.vatusa.net/v2';
const VATSIM_API = 'https://api.vatsim.net/v2';
const CACHE_SECONDS = 24 * 60 * 60;
/** VATUSA's bot keeps to 20 lookups a second; so does this. */
const VATUSA_LOOKUPS_PER_SECOND = 20;

/** Who to look VATUSA up by: their Discord ID (`?d`), or their CID. */
export type LookupKey = { discordId: string } | { cid: number };

// The time the next VATUSA request may go out; it is a Worker-wide spacing, shared by every job.
let nextSlot = 0;

async function takeVatusaSlot(): Promise<void> {
  const now = Date.now();
  if (nextSlot - now > 1000) nextSlot = now; // the clock went back
  const start = Math.max(now, nextSlot);
  nextSlot = start + 1000 / VATUSA_LOOKUPS_PER_SECOND;
  if (start > now) await new Promise((resolve) => setTimeout(resolve, start - now));
}

/** VATUSA's record of this person, or null when it has none (404). */
export async function lookupVatusa(kv: KVNamespace, key: LookupKey): Promise<VatusaPerson | null> {
  const id = 'discordId' in key ? `discord:${key.discordId}` : `cid:${key.cid}`;
  const cacheKey = `role-sync:vatusa-user:${id}`;
  const cached = await kv.get<{ record: VatusaUserRecord | null }>(cacheKey, 'json');
  if (cached) return cached.record ? personFromUser(cached.record) : null;

  await takeVatusaSlot();
  const path = 'discordId' in key ? `${encodeURIComponent(key.discordId)}?d` : String(key.cid);
  const res = await fetch(`${VATUSA_API}/user/${path}`);
  let record: VatusaUserRecord | null = null;
  if (res.status !== 404) {
    if (!res.ok) throw new Error(`VATUSA's /user/${path} answered ${res.status}`);
    const body = parseVatusaBody(await res.text()) as { data?: VatusaUserRecord } & Partial<VatusaUserRecord>;
    record = (body.data ?? body) as VatusaUserRecord;
    if (typeof record?.cid !== 'number') throw new Error(`VATUSA's /user/${path} answered without a CID`);
  }
  await kv.put(cacheKey, JSON.stringify({ record }), { expirationTtl: CACHE_SECONDS });
  return record ? personFromUser(record) : null;
}

/** VATSIM's rating numbers as the short codes the mapping uses. 0 and below are not a rating to hold. */
const RATING_SHORT: Record<number, string> = {
  [-1]: 'INAC',
  0: 'SUS',
  1: 'OBS',
  2: 'S1',
  3: 'S2',
  4: 'S3',
  5: 'C1',
  6: 'C2',
  7: 'C3',
  8: 'I1',
  9: 'I2',
  10: 'I3',
  11: 'SUP',
  12: 'ADM',
};

/** A CID's ATC rating from VATSIM, or null when VATSIM has no such member (404). */
export async function lookupVatsimRating(kv: KVNamespace, cid: number): Promise<{ rating: number; ratingShort: string } | null> {
  const cacheKey = `role-sync:vatsim-rating:${cid}`;
  const cached = await kv.get<{ rating: number | null }>(cacheKey, 'json');
  let rating = cached ? cached.rating : undefined;
  if (rating === undefined) {
    const res = await fetch(`${VATSIM_API}/members/${cid}`);
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`VATSIM's /members/${cid} answered ${res.status}`);
      const body = (await res.json()) as { rating?: unknown };
      if (typeof body.rating !== 'number') throw new Error(`VATSIM's /members/${cid} answered without a rating`);
      rating = body.rating;
    }
    await kv.put(cacheKey, JSON.stringify({ rating: rating ?? null }), { expirationTtl: CACHE_SECONDS });
  }
  return rating == null ? null : { rating, ratingShort: RATING_SHORT[rating] ?? String(rating) };
}
