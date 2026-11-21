import { vi } from 'vitest';
import type { VatusaLists, VatusaUserRecord } from '../src/vatusa';
import { fakeDiscord, type Server, type Write } from './fake-discord';

const VATUSA = 'https://api.vatusa.net/v2';
const VATSIM = 'https://api.vatsim.net/v2';

/** What the per-user lookups answer: VATUSA's user records (404 for anyone else) and VATSIM's ratings by CID. */
type Extras = { users?: VatusaUserRecord[]; vatsimRatings?: Record<number, number> };

/**
 * A stand-in for VATUSA's public API beside fakeDiscord. Serves `lists` the way VATUSA does, with
 * `discord_id` as a bare number, and answers 503 for any path in `failing`. Discord message posts
 * (larry's alerts) are recorded in the returned writes, like every other Discord write.
 */
export function fakeVatusaAndDiscord(
  lists: VatusaLists,
  server: Server,
  failing: string[] = [],
  extras: Extras = {},
): { writes: Write[]; vatusaCalls: string[]; vatusaCallTimes: number[]; vatsimCalls: string[] } {
  const writes = fakeDiscord(server);
  const discordFetch = globalThis.fetch;
  const vatusaCalls: string[] = [];
  const vatusaCallTimes: number[] = [];
  const vatsimCalls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.startsWith(VATSIM)) {
        const path = url.slice(VATSIM.length);
        vatsimCalls.push(path);
        const rating = extras.vatsimRatings?.[Number(path.match(/^\/members\/(\d+)$/)?.[1])];
        return rating === undefined ? new Response('Not Found', { status: 404 }) : new Response(JSON.stringify({ id: 1, rating, pilotrating: 0 }), { status: 200 });
      }
      if (url.startsWith(VATUSA)) {
        const path = url.slice(VATUSA.length);
        vatusaCalls.push(path);
        vatusaCallTimes.push(Date.now());
        if (failing.includes(path)) return new Response('Service Unavailable', { status: 503 });
        const user = path.match(/^\/user\/(\d+)(\?d)?$/);
        if (user) {
          const found = (extras.users ?? []).find((candidate) => (user[2] ? candidate.discord_id === user[1] : String(candidate.cid) === user[1]));
          if (!found) return new Response('Not Found', { status: 404 });
          // A user record, not wrapped in `data`, with discord_id as a bare number.
          return new Response(JSON.stringify(found).replace(/"discord_id":"(\d+)"/g, '"discord_id":$1'), { status: 200 });
        }
        const roster = path.match(/^\/facility\/(\w+)\/roster\/both$/)?.[1] as keyof VatusaLists['rosters'] | undefined;
        const data = roster ? lists.rosters[roster] : path === '/integration/staff' ? lists.staff : path === '/user/roles/ZHQ/ACE' ? lists.ace : undefined;
        if (!data) return new Response('Not Found', { status: 404 });
        const text = JSON.stringify({ data, testing: false }).replace(/"discord_id":"(\d+)"/g, '"discord_id":$1');
        return new Response(text, { status: 200 });
      }
      const path = url.replace('https://discord.com/api/v10', '');
      if (init.method === 'POST' && /^\/channels\/\d+\/messages$/.test(path)) {
        writes.push({ method: 'POST', path, body: JSON.parse(init.body as string) });
        return new Response(JSON.stringify({ id: '800000000000000001' }), { status: 200 });
      }
      return discordFetch(url, init);
    }),
  );
  return { writes, vatusaCalls, vatusaCallTimes, vatsimCalls };
}
