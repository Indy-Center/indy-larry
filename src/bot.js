require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { fetchFeed, groupByFacility, fetchFacilityIndex, fetchBookings } = require('./feed');
const { statusEmbed, noneOnlineEmbed, FOOTER_PREFIX } = require('./embeds');
const { StatusBoard } = require('./status');

const config = {
  token: process.env.DISCORD_TOKEN,
  channelId: process.env.CHANNEL_ID,
  artccIds: (process.env.ARTCC_IDS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  pollSeconds: Math.max(15, Number(process.env.POLL_SECONDS) || 30),
  includeInactive: process.env.INCLUDE_INACTIVE === 'true',
  showNames: process.env.SHOW_NAMES !== 'false',
  plannedHours: Number(process.env.PLANNED_HOURS ?? 3),
  closingMinutes: Number(process.env.CLOSING_MINUTES ?? 15),
  offlineMinutes: Number(process.env.OFFLINE_MINUTES ?? 30),
};

if (!config.token || !config.channelId) {
  console.error('DISCORD_TOKEN and CHANNEL_ID must be set (see .env.example).');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// facility key -> { message, signature }
const posted = new Map();
let channel;
let running = false;
const board = new StatusBoard(config);

// Bookings need the ARTCC's position list to map callsigns to facilities, so they
// only work when ARTCC_IDS is set. Both are cached since they change slowly.
const BOOKINGS_TTL = 5 * 60_000;
const INDEX_TTL = 6 * 60 * 60_000;
const cache = { index: null, indexAt: 0, bookings: [], bookingsAt: 0 };

async function getBookings() {
  if (!config.artccIds.length) return [];
  const now = Date.now();
  try {
    if (!cache.index || now - cache.indexAt > INDEX_TTL) {
      cache.index = await fetchFacilityIndex(config.artccIds);
      cache.indexAt = now;
    }
    if (now - cache.bookingsAt > BOOKINGS_TTL) {
      cache.bookings = await fetchBookings(cache.index);
      cache.bookingsAt = now;
    }
  } catch (err) {
    // Keep going with whatever we had; online/offline still works without bookings.
    console.error(`[${new Date().toISOString()}] Bookings update failed:`, err.message);
  }
  return cache.bookings;
}

/** Re-adopt the bot's own status messages after a restart so we don't post duplicates. */
async function loadExistingMessages() {
  const messages = await channel.messages.fetch({ limit: 100 });
  for (const msg of messages.values()) {
    if (msg.author.id !== client.user.id) continue;
    const footer = msg.embeds[0]?.footer?.text ?? '';
    if (!footer.startsWith(FOOTER_PREFIX)) continue;
    const key = footer.slice(FOOTER_PREFIX.length);
    if (posted.has(key)) {
      await msg.delete().catch(() => {}); // duplicate from an earlier crash
    } else {
      posted.set(key, { message: msg, signature: null });
    }
  }
  console.log(`Adopted ${posted.size} existing status message(s).`);
}

async function upsert(key, embed) {
  // Only touch Discord when the embed actually changed; relative timestamps update client-side.
  const signature = JSON.stringify(embed.toJSON());
  const existing = posted.get(key);
  if (existing?.signature === signature) return;

  if (existing) {
    try {
      await existing.message.edit({ embeds: [embed] });
      existing.signature = signature;
      return;
    } catch (err) {
      if (err.code !== 10008) throw err; // 10008 = Unknown Message (someone deleted it) -> repost
    }
  }
  const message = await channel.send({ embeds: [embed] });
  posted.set(key, { message, signature });
}

async function remove(key) {
  const existing = posted.get(key);
  posted.delete(key);
  await existing?.message.delete().catch((err) => {
    if (err.code !== 10008) console.error(`Failed to delete message for ${key}:`, err.message);
  });
}

async function refresh() {
  if (running) return;
  running = true;
  try {
    const feed = await fetchFeed();
    const facilities = groupByFacility(feed, config);
    const entries = board.update(facilities, await getBookings());

    const wanted = new Map(entries.map((e) => [e.key, statusEmbed(e, config)]));
    if (wanted.size === 0) wanted.set('__none__', noneOnlineEmbed(config.artccIds));

    for (const key of [...posted.keys()]) {
      if (!wanted.has(key)) await remove(key);
    }
    for (const [key, embed] of wanted) await upsert(key, embed);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Refresh failed:`, err.message);
  } finally {
    running = false;
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  channel = await client.channels.fetch(config.channelId);
  if (!channel?.isTextBased()) throw new Error(`Channel ${config.channelId} is not a text channel`);

  await loadExistingMessages();
  await refresh();
  setInterval(refresh, config.pollSeconds * 1000);
  console.log(`Polling every ${config.pollSeconds}s${config.artccIds.length ? ` for ${config.artccIds.join(', ')}` : ''}.`);
});

client.login(config.token);
