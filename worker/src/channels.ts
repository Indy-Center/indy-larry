/**
 * SEND_CHANNELS, "events:111, training:222", as a map of name -> channel ID.
 * Same format as the bot's RELIEF_ROLES. Throws on a malformed entry or a repeated name.
 */
export function parseChannels(value: string | undefined): Map<string, string> {
  const channels = new Map<string, string>();
  for (const entry of (value ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = entry.lastIndexOf(':');
    const name = entry.slice(0, i).trim();
    const id = entry.slice(i + 1).trim();
    if (i < 1 || !name || !/^\d+$/.test(id)) throw new Error(`SEND_CHANNELS entry "${entry}" should look like "events:123456789"`);
    if (channels.has(name)) throw new Error(`SEND_CHANNELS lists "${name}" twice`);
    channels.set(name, id);
  }
  return channels;
}
