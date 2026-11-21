import { vi } from 'vitest';
import type { VatusaLists } from '../src/vatusa';
import { fakeDiscord, type Server, type Write } from './fake-discord';

const VATUSA = 'https://api.vatusa.net/v2';

/**
 * A stand-in for VATUSA's public API beside fakeDiscord. Serves `lists` the way VATUSA does, with
 * `discord_id` as a bare number, and answers 503 for any path in `failing`. Discord message posts
 * (larry's alerts) are recorded in the returned writes, like every other Discord write.
 */
export function fakeVatusaAndDiscord(lists: VatusaLists, server: Server, failing: string[] = []): { writes: Write[]; vatusaCalls: string[] } {
  const writes = fakeDiscord(server);
  const discordFetch = globalThis.fetch;
  const vatusaCalls: string[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.startsWith(VATUSA)) {
        const path = url.slice(VATUSA.length);
        vatusaCalls.push(path);
        if (failing.includes(path)) return new Response('Service Unavailable', { status: 503 });
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
  return { writes, vatusaCalls };
}
