const fs = require('fs');
const path = require('path');
const { Events, MessageFlags } = require('discord.js');
const { DURATIONS, reliefPanel, requestPanel, ironMicPanel, requestModal, requestAlert } = require('./panels');

const HOUR = 60 * 60_000;
const SWEEP_MS = 30_000; // expired roles come off within this long

/**
 * "S Ground:123, A Ground:456" -> [{ label: 'S Ground', roleId: '123' }, ...].
 * The label is the button text; the ID is the role it hands out and pings.
 */
function parseRoles(value) {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.lastIndexOf(':');
      const label = entry.slice(0, i).trim();
      const roleId = entry.slice(i + 1).trim();
      if (i < 1 || !label || !/^\d+$/.test(roleId)) throw new Error(`RELIEF_ROLES entry "${entry}" should look like "S Ground:123456789"`);
      return { label, roleId };
    });
}

/**
 * What pressing a relief position button does.
 * A role with no record (e.g. added by hand) counts as permanent.
 * @param {boolean} hasRole
 * @param {{ duration: string }|undefined} grant the stored assignment, if any
 * @param {string} choice the duration picked in the menu ('3' ... '12' or 'perm')
 * @returns {'add'|'change'|'remove'}
 */
function reliefAction(hasRole, grant, choice) {
  if (!hasRole) return 'add';
  return (grant?.duration ?? 'perm') === choice ? 'remove' : 'change';
}

/** Grants whose time is up. */
function expiredGrants(grants, now) {
  return Object.entries(grants).filter(([, g]) => g.expiresAt != null && g.expiresAt <= now);
}

const unix = (ms) => Math.floor(ms / 1000);

class Notifications {
  /**
   * @param {import('discord.js').Client} client
   * @param {{ panelChannelId: string, alertChannelId: string, positions: {label: string, roleId: string}[], ironMicRoleId?: string, stateFile: string }} config
   */
  constructor(client, config) {
    this.client = client;
    this.config = config;
    // grants: "userId:roleId" -> { userId, roleId, duration, expiresAt|null }
    // choices: what each user last picked in the two menus, so it survives a restart.
    this.state = { panelChannelId: null, panels: [], grants: {}, choices: { duration: {}, request: {} } };
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf8'));
      this.state = { ...this.state, ...saved, choices: { ...this.state.choices, ...saved.choices } };
    } catch {
      // First run.
    }
  }

  save() {
    try {
      fs.writeFileSync(this.config.stateFile, JSON.stringify(this.state, null, 2));
    } catch (err) {
      console.error(`Could not save ${path.basename(this.config.stateFile)}:`, err.message);
    }
  }

  async start() {
    this.load();
    this.channel = await this.client.channels.fetch(this.config.panelChannelId);
    if (!this.channel?.isTextBased() || !this.channel.guild) throw new Error(`Panel channel ${this.config.panelChannelId} is not a server text channel`);
    this.alertChannel =
      this.config.alertChannelId === this.config.panelChannelId ? this.channel : await this.client.channels.fetch(this.config.alertChannelId);

    await this.postPanels();
    this.client.on(Events.InteractionCreate, (interaction) =>
      this.handle(interaction).catch((err) => this.fail(interaction, err)),
    );
    await this.sweep();
    setInterval(() => this.sweep(), SWEEP_MS);
    console.log(`Notification panels ready in #${this.channel.name}.`);
  }

  panels() {
    const { positions, ironMicRoleId } = this.config;
    const list = [];
    if (positions.length) list.push(reliefPanel(positions), requestPanel(positions));
    if (ironMicRoleId) list.push(ironMicPanel());
    return list;
  }

  /** Edit the panels in place; if any is missing (or the layout changed shape), repost all of them in order. */
  async postPanels() {
    const wanted = this.panels();
    const ids = this.state.panelChannelId === this.channel.id ? this.state.panels : [];
    const found = [];
    for (const id of ids) {
      const msg = await this.channel.messages.fetch(id).catch(() => null);
      if (msg) found.push(msg);
    }

    if (found.length === wanted.length && found.length === ids.length) {
      for (let i = 0; i < wanted.length; i++) await found[i].edit({ components: [wanted[i]] });
    } else {
      for (const msg of found) await msg.delete().catch(() => {});
      const posted = [];
      for (const panel of wanted) {
        posted.push(await this.channel.send({ components: [panel], flags: MessageFlags.IsComponentsV2 }));
      }
      this.state.panels = posted.map((m) => m.id);
    }
    this.state.panelChannelId = this.channel.id;
    this.save();
  }

  position(roleId) {
    return this.config.positions.find((p) => p.roleId === roleId);
  }

  async handle(interaction) {
    const id = interaction.customId;
    if (!id || interaction.guildId !== this.channel.guild.id) return;
    const [scope, kind, ...rest] = id.split(':');
    const userId = interaction.user.id;

    if (scope === 'relief' && kind === 'duration') return this.remember(interaction, 'duration');
    if (scope === 'request' && kind === 'type') return this.remember(interaction, 'request');
    if (scope === 'relief' && kind === 'role') return this.toggleRelief(interaction, rest[0]);
    if (scope === 'ironmic') return this.toggleIronMic(interaction);

    if (scope === 'request' && kind === 'pos') {
      const position = this.position(rest[0]);
      const type = this.state.choices.request[userId];
      if (!position) return this.reply(interaction, 'That position is no longer set up.');
      if (!type) return this.reply(interaction, 'Pick **Break** or **Staffing** in the menu first.');
      return interaction.showModal(requestModal(type, position));
    }
    if (scope === 'request' && kind === 'modal') return this.submitRequest(interaction, rest[0], rest[1]);
  }

  async remember(interaction, menu) {
    this.state.choices[menu][interaction.user.id] = interaction.values[0];
    this.save();
    await interaction.deferUpdate();
  }

  async toggleRelief(interaction, roleId) {
    const position = this.position(roleId);
    if (!position) return this.reply(interaction, 'That position is no longer set up.');
    const choice = this.state.choices.duration[interaction.user.id];
    const duration = DURATIONS.find((d) => d.value === choice);
    if (!duration) return this.reply(interaction, 'Pick how long you want notifications for in the menu first.');

    const member = interaction.member;
    const key = `${member.id}:${roleId}`;
    const hasRole = member.roles.cache.has(roleId);
    const action = reliefAction(hasRole, this.state.grants[key], duration.value);

    if (action === 'remove') {
      await member.roles.remove(roleId, 'Relief notifications: opted out');
      delete this.state.grants[key];
      this.save();
      return this.reply(interaction, `🔕 You'll no longer get **${position.label}** notifications.`);
    }

    if (!hasRole) await member.roles.add(roleId, `Relief notifications: ${duration.label}`);
    const expiresAt = duration.hours ? Date.now() + duration.hours * HOUR : null;
    this.state.grants[key] = { userId: member.id, roleId, duration: duration.value, expiresAt };
    this.save();

    const until = expiresAt
      ? `until <t:${unix(expiresAt)}:t> (<t:${unix(expiresAt)}:R>)`
      : `permanently. Press **${position.label}** again with Permanent selected to opt out`;
    const verb = action === 'change' ? 'now get' : 'get';
    return this.reply(interaction, `🔔 You'll ${verb} **${position.label}** notifications ${until}.`);
  }

  async toggleIronMic(interaction) {
    const roleId = this.config.ironMicRoleId;
    if (!roleId) return this.reply(interaction, 'Iron Mic notifications are not set up.');
    const member = interaction.member;
    if (member.roles.cache.has(roleId)) {
      await member.roles.remove(roleId, 'Iron Mic notifications: opted out');
      return this.reply(interaction, "🔕 You'll no longer get Iron Mic notifications.");
    }
    await member.roles.add(roleId, 'Iron Mic notifications: opted in');
    return this.reply(interaction, "🎙️ You'll get Iron Mic notifications. Press the button again to opt out.");
  }

  async submitRequest(interaction, type, roleId) {
    const position = this.position(roleId);
    if (!position) return this.reply(interaction, 'That position is no longer set up.');
    const f = interaction.fields;
    const fields =
      type === 'break'
        ? { position: f.getTextInputValue('position'), stay: f.getTextInputValue('stay') }
        : { position: f.getTextInputValue('position'), area: f.getStringSelectValues('area')[0], reason: f.getTextInputValue('reason') };

    await this.alertChannel.send(requestAlert(type, position, interaction.user.id, fields));
    const where = this.alertChannel.id === interaction.channelId ? '' : ` in <#${this.alertChannel.id}>`;
    return this.reply(interaction, `✅ Sent. **${position.label}** has been notified${where}.`);
  }

  /** Take expired relief roles back off. */
  async sweep() {
    const expired = expiredGrants(this.state.grants, Date.now());
    if (!expired.length) return;
    const guild = this.channel.guild;
    for (const [key, g] of expired) {
      try {
        const member = await guild.members.fetch(g.userId);
        await member.roles.remove(g.roleId, 'Relief notifications: time is up');
      } catch (err) {
        // 10007 = Unknown Member (left the server); anything else, try again next sweep.
        if (err.code !== 10007) {
          console.error(`[${new Date().toISOString()}] Could not remove role ${g.roleId} from ${g.userId}:`, err.message);
          continue;
        }
      }
      delete this.state.grants[key];
    }
    this.save();
  }

  reply(interaction, content) {
    return interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }

  async fail(interaction, err) {
    console.error(`[${new Date().toISOString()}] Interaction ${interaction.customId} failed:`, err.message);
    // 50013 = Missing Permissions: usually the bot's role sits below the role it's handing out.
    const content =
      err.code === 50013
        ? "I don't have permission to do that. Staff: give me Manage Roles and move my role above the notification roles."
        : 'Something went wrong. Try again in a moment.';
    const send = interaction.deferred || interaction.replied ? interaction.followUp.bind(interaction) : interaction.reply.bind(interaction);
    await send({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
}

module.exports = { Notifications, parseRoles, reliefAction, expiredGrants };
