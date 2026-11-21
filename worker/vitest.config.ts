import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Tests run in Node, not workerd, so the entrypoint's base class comes from a stand-in.
export default defineConfig({
  resolve: {
    alias: { 'cloudflare:workers': fileURLToPath(new URL('./tests/cloudflare-workers.ts', import.meta.url)) },
  },
});
