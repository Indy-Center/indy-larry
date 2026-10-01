// Checks SEND_CHANNELS before a deploy: node scripts/check-channels.ts (Node 22.18+ runs the TypeScript as is).
// Fails on a malformed entry, a repeated name, or Larry's status channel (CHANNEL_ID), where the bot
// deletes every message that isn't a status embed.
import { parseChannels } from '../src/channels.ts';

try {
  const channels = parseChannels(process.env.SEND_CHANNELS);
  for (const [name, id] of channels) {
    if (id === process.env.CHANNEL_ID) throw new Error(`SEND_CHANNELS "${name}" is the status channel (CHANNEL_ID); pick another channel`);
  }
  console.log(`SEND_CHANNELS: ${[...channels.keys()].join(', ') || 'none (send() and enqueue() will refuse every channel)'}`);
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
