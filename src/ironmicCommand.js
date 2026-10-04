// The /ironmic command and its leaderboard embed. The counting itself is in ironmic.js.
//
//   /ironmic start facility:LEX positions:local, approach   posts the embeds and starts counting
//   /ironmic end                                            stops counting; the embed shows the final standings
//   /ironmic clear                                          deletes the embed and the log, ready for the next one
//
// The embeds go in IRON_MIC_CHANNEL_ID (the status channel unless set), one message with an embed per
// position; bot.js keeps that message above the status embeds when they share a channel.
// Totals come from vNAS Stats every few minutes, checked on Larry's feed poll. One competition at a time. It's saved to ironmic.json, so a restart edits the same message.

const fs = require('fs');
const path = require('path');
const { Events, MessageFlags } = require('discord.js');
const { POSITIONS, parsePositions, resolveCallsigns, resolvePlaces, fetchStats, readStats, monthStart, newCompetition, competitionEmbeds } = require('./ironmic');

const FETCH_MS = 5 * 60_000; // how often to ask vNAS Stats for new totals

const MANAGE_GUILD = String(1 << 5); // default permission to run it; servers can change this under Integrations

const COMMAND = {
  name: 'ironmic',
  description: 'Track how long a facility\'s positions are staffed',
  default_member_permissions: MANAGE_GUILD,
  contexts: [0], // servers only
  options: [
    {
      type: 1,
      name: 'start',
      description: 'Start an Iron Mic and post its leaderboard',
      options: [
        { type: 3, name: 'facility', description: 'Facility ID, e.g. LEX', required: true, autocomplete: true, max_length: 4 },
        { type: 3, name: 'positions', description: 'Positions to track, e.g. local, approach', required: true, autocomplete: true, max_length: 100 },
      ],
    },
    { type: 1, name: 'end', description: 'End the Iron Mic; the leaderboard shows the final standings' },
    { type: 1, name: 'clear', description: 'Delete the leaderboard and clear its log, after /ironmic end' },
  ],
};

// Suggested position sets for the positions box; anything typed by hand works too.
const POSITION_SETS = [
  'local, approach',
  'local',
  'approach',
  'ground, local',
  'ground, local, approach',
  'delivery, ground, local',
  'delivery, ground, local, approach',
  'center',
];

class IronMic {
  /**
   * @param {import('discord.js').Client} client
   * @param {{ stateFile: string, channelId: string, statusChannelId: string, roleId?: string,
   *           facilities?: () => {id: string, name: string}[], facilityIndex?: () => object|null,
   *           onPosted?: () => void }} config
   *   channelId: where the embeds go. facilities: the facilities to suggest and allow (from the vNAS
   *   ARTCC data); empty allows any ID. facilityIndex: fetchFacilityIndex() output, to work out each
   *   position's callsigns. onPosted: called after the embeds go out as a new message.
   */
  constructor(client, config) {
    this.client = client;
    this.config = config;
    this.competition = null;
    this.signature = null;
    this.lastFetchAttempt = 0;
    this.load();
  }

  /** The leaderboard's message ID if it's posted in channelId, so the status loop can keep it on top. */
  messageIn(channelId) {
    const c = this.competition;
    return c?.messageId && c.channelId === channelId ? c.messageId : null;
  }

  load() {
    try {
      this.competition = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf8')).competition ?? null;
    } catch {
      // First run, or nothing running.
    }
  }

  save() {
    try {
      fs.writeFileSync(this.config.stateFile, JSON.stringify({ competition: this.competition }, null, 2));
    } catch (err) {
      console.error(`Could not save ${path.basename(this.config.stateFile)}:`, err.message);
    }
  }

  /** Registers /ironmic in the server and starts answering it. */
  async start(guild) {
    this.guildId = guild.id;
    // Creating a command with an existing name updates it, and leaves the server's other commands alone.
    await guild.commands.create(COMMAND);
    this.client.on(Events.InteractionCreate, (interaction) => this.handle(interaction).catch((err) => this.fail(interaction, err)));
    const c = this.competition;
    console.log(
      c ? `Iron Mic ${c.endedAt ? 'ended' : 'running'}: ${c.facilityId} ${c.positions.join(', ')}.` : '/ironmic is ready; no Iron Mic running.',
    );
  }

  /** Called with every feed check. Errors are caught here so they never hold up the status embeds. */
  async tick(now = Date.now()) {
    const c = this.competition;
    if (!c || c.final) return;
    try {
      if (!c.callsigns || !c.places) {
        // Started before callsigns and titles were worked out from the vNAS data; work them out now.
        const index = this.config.facilityIndex?.();
        c.callsigns ??= resolveCallsigns(index, c.facilityId, c.positions);
        c.places = resolvePlaces(index, c.facilityId, c.positions, c.facilityName);
        this.lastFetchAttempt = 0;
        this.save();
      }
      if (c.startedAt !== monthStart(c.startedAt)) {
        // Started before Iron Mics counted from the 1st; move it back.
        c.startedAt = monthStart(c.startedAt);
        this.lastFetchAttempt = 0;
        this.save();
      }
      await this.refreshTotals(now);
      await this.render();
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Iron Mic update failed:`, err.message);
    }
  }

  /**
   * Fetches totals every FETCH_MS while running. Once it has ended, fetches the whole run on the next
   * check (and keeps retrying if vNAS Stats is down) and then marks it final.
   */
  async refreshTotals(now) {
    const c = this.competition;
    if (now - this.lastFetchAttempt < (c.endedAt ? 60_000 : FETCH_MS)) return;
    const end = c.endedAt ?? now;
    if (end - c.startedAt < 60_000) return; // vNAS Stats needs the range to have started in the past
    this.lastFetchAttempt = now;

    const totals = readStats(await fetchStats(c.startedAt, end), c.callsigns);
    if (this.competition !== c) return; // cleared while the request was out
    c.totals = totals;
    if (c.endedAt) c.final = true;
    this.save();
  }

  /** Edits the leaderboard when it changed, and reposts it if someone deleted it or the channel changed. */
  async render() {
    const c = this.competition;
    if (!c) return;
    if (c.channelId !== this.config.channelId) {
      await this.deleteMessage(c);
      c.channelId = this.config.channelId;
      c.messageId = null;
    }
    const embeds = competitionEmbeds(c);
    const signature = JSON.stringify(embeds);
    if (signature === this.signature && c.messageId) return;

    const channel = await this.client.channels.fetch(c.channelId);
    if (c.messageId) {
      try {
        await channel.messages.edit(c.messageId, { embeds });
        this.signature = signature;
        return;
      } catch (err) {
        if (err.code !== 10008) throw err; // 10008 = Unknown Message (deleted) -> repost
      }
    }
    const message = await channel.send({ embeds });
    c.messageId = message.id;
    this.signature = signature;
    this.save();
    this.config.onPosted?.();
  }

  async deleteMessage(c) {
    if (!c.messageId) return;
    const channel = await this.client.channels.fetch(c.channelId).catch(() => null);
    await channel?.messages.delete(c.messageId).catch((err) => {
      if (err.code !== 10008) throw err;
    });
  }

  async handle(interaction) {
    if (interaction.commandName !== COMMAND.name || interaction.guildId !== this.guildId) return;
    if (interaction.isAutocomplete()) return this.autocomplete(interaction);
    if (!interaction.isChatInputCommand()) return;

    const sub = interaction.options.getSubcommand();
    if (sub === 'start') return this.startCompetition(interaction);
    if (sub === 'end') return this.endCompetition(interaction);
    if (sub === 'clear') return this.clearCompetition(interaction);
  }

  facilities() {
    return this.config.facilities?.() ?? [];
  }

  async autocomplete(interaction) {
    const focused = interaction.options.getFocused(true);
    const typed = String(focused.value ?? '').trim().toLowerCase();
    let choices;

    if (focused.name === 'facility') {
      choices = this.facilities()
        .filter((f) => !typed || f.id.toLowerCase().startsWith(typed) || f.name.toLowerCase().includes(typed))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((f) => ({ name: `${f.id} · ${f.name}`.slice(0, 100), value: f.id }));
      if (!choices.length && typed) choices = [{ name: typed.toUpperCase(), value: typed.toUpperCase() }];
    } else {
      choices = POSITION_SETS.filter((s) => !typed || s.includes(typed)).map((s) => ({ name: s, value: s }));
      if (typed && !POSITION_SETS.includes(typed)) choices.unshift({ name: typed.slice(0, 100), value: typed.slice(0, 100) });
    }
    return interaction.respond(choices.slice(0, 25));
  }

  async startCompetition(interaction) {
    const c = this.competition;
    if (c) {
      const next = c.endedAt ? '`/ironmic clear` it first.' : '`/ironmic end` it, then `/ironmic clear`, first.';
      return this.reply(interaction, `There's already an Iron Mic for **${c.facilityId}**. ${next}`);
    }
    if (interaction.channelId === this.config.statusChannelId) {
      return this.reply(interaction, 'Run this in another channel; my ping would land between the status embeds.');
    }

    const facilityId = interaction.options.getString('facility').trim().toUpperCase();
    const known = this.facilities();
    const facility = known.find((f) => f.id === facilityId);
    if (!/^[A-Z0-9]{2,4}$/.test(facilityId) || (known.length && !facility)) {
      return this.reply(interaction, `**${facilityId}** isn't a facility I know. Pick one from the list.`);
    }

    let positions;
    try {
      positions = parsePositions(interaction.options.getString('positions'));
    } catch (err) {
      return this.reply(interaction, err.message);
    }
    const index = this.config.facilityIndex?.();
    const callsigns = resolveCallsigns(index, facilityId, positions);
    const missing = positions.filter((k) => !callsigns[k].length).map((k) => POSITIONS[k].label);
    if (missing.length) {
      return this.reply(interaction, `**${facilityId}** has no ${missing.join(' or ')} position in the vNAS data.`);
    }

    this.competition = newCompetition({
      facilityId,
      facilityName: facility?.name ?? null,
      positions,
      callsigns,
      places: resolvePlaces(index, facilityId, positions, facility?.name),
      channelId: this.config.channelId,
      startedAt: monthStart(Date.now()), // counts the whole month so far, like vnas-stats.com's month view
    });
    try {
      await this.render();
    } catch (err) {
      this.competition = null;
      throw err;
    }
    this.save();

    const what = `**${facilityId}** ${positions.map((k) => POSITIONS[k].label).join(' + ')}`;
    const { roleId } = this.config;
    // The ping goes in a reply everyone sees, so the role hears about it; the leaderboard is its own message.
    return interaction.reply({
      content: `🎙️ Iron Mic is on for ${what}!${roleId ? ` <@&${roleId}>` : ''}`,
      allowedMentions: { roles: roleId ? [roleId] : [] },
    });
  }

  async endCompetition(interaction) {
    const c = this.competition;
    if (!c) return this.reply(interaction, 'No Iron Mic is running.');
    if (c.endedAt) return this.reply(interaction, 'It has already ended. `/ironmic clear` removes the leaderboard.');

    c.endedAt = Date.now();
    this.lastFetchAttempt = 0; // fetch the final totals on the next check
    this.save();
    await this.render();
    return interaction.reply({
      content: `🏁 The **${c.facilityId}** Iron Mic is over. Final totals will be on the leaderboard within a minute.`,
      allowedMentions: { parse: [] },
    });
  }

  async clearCompetition(interaction) {
    const c = this.competition;
    if (!c) return this.reply(interaction, 'There\'s nothing to clear.');
    if (!c.endedAt) return this.reply(interaction, '`/ironmic end` it first, so the final standings are posted.');

    await this.deleteMessage(c);
    this.competition = null;
    this.signature = null;
    this.lastFetchAttempt = 0;
    this.save();
    return this.reply(interaction, `Cleared the **${c.facilityId}** Iron Mic. Ready for the next one.`);
  }

  /** A reply only the person who ran the command sees. */
  reply(interaction, content) {
    const message = { content, flags: MessageFlags.Ephemeral };
    return interaction.replied || interaction.deferred ? interaction.followUp(message) : interaction.reply(message);
  }

  async fail(interaction, err) {
    console.error(`[${new Date().toISOString()}] /ironmic failed:`, err.message);
    if (interaction.isAutocomplete?.()) return;
    // 50001 = Missing Access, 50013 = Missing Permissions in the channel
    const content = [50001, 50013].includes(err.code)
      ? "I can't post here. Give me View Channel, Send Messages and Embed Links in this channel."
      : 'Something went wrong. Try again in a moment.';
    await this.reply(interaction, content).catch(() => {});
  }
}

module.exports = { IronMic, COMMAND };
