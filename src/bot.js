require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { fetchFeed, groupByFacility, fetchFacilityIndex, fetchBookings, trackActivations } = require('./feed');
const { statusEmbed, noneOnlineEmbed } = require('./embeds');
const { StatusBoard } = require('./status');
const { Notifications, parseRoles, parseAreas } = require('./notify');
const { IronMic } = require('./ironmicCommand');

const config = {
  token: process.env.DISCORD_TOKEN,
  channelId: process.env.CHANNEL_ID,
  artccIds: (process.env.ARTCC_IDS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  pollSeconds: Math.max(15, Number(process.env.POLL_SECONDS) || 30),
  includeInactive: process.env.INCLUDE_INACTIVE === 'true',
  showNames: process.env.SHOW_NAMES !== 'false',
  plannedHours: Number(process.env.PLANNED_HOURS || 3),
  closingMinutes: Number(process.env.CLOSING_MINUTES || 15),
  offlineMinutes: Number(process.env.OFFLINE_MINUTES || 30),
};

if (!config.token || !config.channelId) {
  console.error('DISCORD_TOKEN and CHANNEL_ID must be set (see .env.example).');
  process.exit(1);
}

// Notification panels (relief/staffing roles and Iron Mic). Off unless PANEL_CHANNEL_ID is set.
const notifyConfig = {
  panelChannelId: process.env.PANEL_CHANNEL_ID,
  alertChannelId: process.env.ALERT_CHANNEL_ID || process.env.PANEL_CHANNEL_ID,
  positions: parseRoles(process.env.RELIEF_ROLES),
  areas: parseAreas(process.env),
  ironMicRoleId: process.env.IRON_MIC_ROLE_ID,
  expireMinutes: Math.max(0, Number(process.env.REQUEST_EXPIRE_MINUTES || 60) || 0),
  stateFile: path.join(__dirname, '..', 'notify.json'),
};

// The status loop deletes every other message the bot has in CHANNEL_ID, so panels and alerts need their own channel.
if ([notifyConfig.panelChannelId, notifyConfig.alertChannelId].includes(config.channelId)) {
  console.error('PANEL_CHANNEL_ID and ALERT_CHANNEL_ID must be different from CHANNEL_ID.');
  process.exit(1);
}

// /ironmic: Iron Mic leaderboard (totals from vNAS Stats). Always on; IRON_MIC_ROLE_ID (if set) is pinged when one starts.
// Its embeds go above the status embeds in CHANNEL_ID, or in IRON_MIC_CHANNEL_ID if set.
const ironMicConfig = {
  stateFile: path.join(__dirname, '..', 'ironmic.json'),
  channelId: process.env.IRON_MIC_CHANNEL_ID || config.channelId,
  statusChannelId: config.channelId,
  onPosted: () => refresh(), // a new leaderboard message in CHANNEL_ID pushes the status embeds back under it
  roleId: process.env.IRON_MIC_ROLE_ID,
  // Towers and TRACONs from the vNAS ARTCC data, for /ironmic start's facility list.
  facilities: () =>
    [...(cache.index?.facilities.values() ?? [])]
      .filter((f) => f.positionType === 'Atct' || f.positionType === 'Tracon')
      .map((f) => ({ id: f.id, name: f.name })),
};
let ironMic = null;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// facility key -> { message, signature }
const posted = new Map();

// When each controller went active (the feed only has connect time). See trackActivations().
let activeSince = new Map();
let firstRefresh = true;

// Which message belongs to which facility, so a restart edits the same messages,
// plus activation times so "on since" survives a restart.
const STATE_FILE = path.join(__dirname, '..', 'state.json');

function saveState() {
  const messages = Object.fromEntries([...posted].map(([key, { message }]) => [key, message.id]));
  const state = { channelId: config.channelId, messages, activeSince: Object.fromEntries(activeSince) };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Could not save state.json:', err.message);
  }
}

function readState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (state.channelId !== config.channelId) return { messages: {}, activeSince: {} };
    return { messages: state.messages ?? {}, activeSince: state.activeSince ?? {} };
  } catch {
    return { messages: {}, activeSince: {} };
  }
}
let channel;
let running = false;
let again = false; // refresh() was asked for while one was running
const board = new StatusBoard(config);

// Bookings and top-down coverage need the ARTCC's facility data, so they only work when
// ARTCC_IDS is set. Both are cached since they change slowly.
const BOOKINGS_TTL = 5 * 60_000;
const INDEX_TTL = 6 * 60 * 60_000;
const cache = { index: null, indexAt: 0, bookings: [], bookingsAt: 0 };

/** @returns {{ bookings: object[], facilityTree: Map|null }} */
async function getReferenceData() {
  if (!config.artccIds.length) return { bookings: [], facilityTree: null };
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
  return { bookings: cache.bookings, facilityTree: cache.index?.facilities ?? null };
}

/**
 * Re-adopt the bot's own status messages after a restart so we don't post duplicates.
 * Any other message the bot posted in the channel is stale and gets cleaned up.
 */
async function loadExistingMessages() {
  const state = readState();
  activeSince = new Map(Object.entries(state.activeSince));
  const known = new Map(Object.entries(state.messages).map(([key, id]) => [id, key]));
  const leaderboard = ironMic?.messageIn(config.channelId);
  const messages = await channel.messages.fetch({ limit: 100 });
  for (const msg of messages.values()) {
    if (msg.author.id !== client.user.id || msg.id === leaderboard) continue;
    const key = known.get(msg.id);
    if (key) posted.set(key, { message: msg, signature: null });
    else await msg.delete().catch(() => {});
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
  saveState();
}

async function remove(key) {
  const existing = posted.get(key);
  posted.delete(key);
  saveState();
  await existing?.message.delete().catch((err) => {
    if (err.code !== 10008) console.error(`Failed to delete message for ${key}:`, err.message);
  });
}

async function refresh() {
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const feed = await fetchFeed();
    if (trackActivations(feed, activeSince, new Date(), firstRefresh, config.artccIds)) saveState();
    firstRefresh = false;
    await ironMic?.tick(); // catches its own errors, so the status embeds still update

    // The Iron Mic leaderboard sits on top. If it's newer than any status message (just started, reposted,
    // or the order got lost), take the status messages down so they're posted again below it.
    const top = ironMic?.messageIn(config.channelId);
    if (top && [...posted.values()].some(({ message }) => BigInt(message.id) < BigInt(top))) {
      for (const key of [...posted.keys()]) await remove(key);
    }

    const facilities = groupByFacility(feed, { ...config, activeSince });
    const { bookings, facilityTree } = await getReferenceData();
    const entries = board.update(facilities, bookings, new Date(), facilityTree);

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
  if (again) {
    again = false;
    await refresh();
  }
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  channel = await client.channels.fetch(config.channelId);
  if (!channel?.isTextBased()) throw new Error(`Channel ${config.channelId} is not a text channel`);

  ironMic = new IronMic(client, ironMicConfig); // before loadExistingMessages, so its message isn't cleaned up
  await loadExistingMessages();
  await ironMic.start(channel.guild).catch((err) => {
    console.error('/ironmic failed to start:', err.message);
    ironMic = null;
  });
  await refresh();
  setInterval(refresh, config.pollSeconds * 1000);
  console.log(`Polling every ${config.pollSeconds}s${config.artccIds.length ? ` for ${config.artccIds.join(', ')}` : ''}.`);

  if (notifyConfig.panelChannelId) {
    await new Notifications(client, notifyConfig).start().catch((err) => console.error('Notification panels failed to start:', err.message));
  }
});

client.login(config.token);
