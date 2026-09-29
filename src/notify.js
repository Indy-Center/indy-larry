const fs = require('fs');
const path = require('path');
const { Events, MessageFlags } = require('discord.js');
const {
  MIN_HOURS,
  MAX_HOURS,
  reliefPanel,
  hoursModal,
  parseHours,
  requestPanel,
  ironMicPanel,
  requestModal,
  requestAlert,
  alertStatus,
} = require('./panels');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SWEEP_MS = 30_000; // expired roles come off within this long

// The Break/Staffing panel's menus, in order. Each area's roles come from its own setting.
const REQUEST_AREAS = [
  { key: 'cab', label: 'CAB', setting: 'CAB_ROLES' },
  { key: 'tracon', label: 'TRACON', setting: 'TRACON_ROLES' },
  { key: 'enroute', label: 'ENROUTE', setting: 'ENROUTE_ROLES' },
];

/**
 * "S Ground:123, A Ground:456" -> [{ label: 'S Ground', roleId: '123' }, ...].
 * The label is what the menu or form shows; the ID is the role it hands out or pings.
 */
function parseRoles(value, setting = 'RELIEF_ROLES') {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const i = entry.lastIndexOf(':');
      const label = entry.slice(0, i).trim();
      const roleId = entry.slice(i + 1).trim();
      if (i < 1 || !label || !/^\d+$/.test(roleId)) throw new Error(`${setting} entry "${entry}" should look like "S Ground:123456789"`);
      return { label, roleId };
    });
}

/**
 * What picking an option in a relief position's menu does.
 * Temporary always sets a new time. Permanent when you already have it opts out, as does "Opt out".
 * A role with no record (e.g. added by hand) counts as permanent.
 * @param {boolean} hasRole
 * @param {{ duration: string }|undefined} grant the stored assignment, if any
 * @param {'temp'|'perm'|'off'} choice the option picked
 * @returns {'add'|'change'|'remove'|'none'}
 */
function reliefAction(hasRole, grant, choice) {
  if (choice === 'off') return hasRole ? 'remove' : 'none';
  if (!hasRole) return 'add';
  if (choice === 'perm') return (grant?.duration ?? 'perm') === 'perm' ? 'remove' : 'change';
  return 'change';
}

/** The request areas that have roles set, each with its parsed roles. */
function parseAreas(env) {
  return REQUEST_AREAS.map((a) => ({ key: a.key, label: a.label, roles: parseRoles(env[a.setting], a.setting) })).filter(
    (a) => a.roles.length,
  );
}

/** Grants (or alerts) whose time is up. */
function expiredGrants(grants, now) {
  return Object.entries(grants).filter(([, g]) => g.expiresAt != null && g.expiresAt <= now);
}

const unix = (ms) => Math.floor(ms / 1000);

class Notifications {
  /**
   * @param {import('discord.js').Client} client
   * @param {{ panelChannelId: string, alertChannelId: string, positions: {label: string, roleId: string}[], areas: {key: string, label: string, roles: {label: string, roleId: string}[]}[], ironMicRoleId?: string, expireMinutes?: number, stateFile: string }} config
   */
  constructor(client, config) {
    this.client = client;
    this.config = config;
    // grants: "userId:roleId" -> { userId, roleId, duration, expiresAt|null }
    // alerts: messageId -> the request alert's record (see requestAlert), while it can still be claimed or cancelled
    this.state = { panelChannelId: null, panels: [], grants: {}, alerts: {} };
  }

  load() {
    try {
      const { panelChannelId, panels, grants, alerts } = JSON.parse(fs.readFileSync(this.config.stateFile, 'utf8'));
      this.state = { panelChannelId, panels: panels ?? [], grants: grants ?? {}, alerts: alerts ?? {} };
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
    const { positions, areas, ironMicRoleId } = this.config;
    const shown = [
      ironMicRoleId ? 'Iron Mic' : null,
      areas.length ? `Break/Staffing (${areas.map((a) => `${a.label}: ${a.roles.map((r) => r.label).join(', ')}`).join('; ')})` : null,
      positions.length ? `Relief (${positions.map((p) => p.label).join(', ')})` : null,
    ].filter(Boolean);
    console.log(`Notification panels ready in #${this.channel.name}: ${shown.join(' | ') || 'none'}.`);
    if (!areas.length) console.log('No Break/Staffing panel: CAB_ROLES, TRACON_ROLES and ENROUTE_ROLES are all unset.');
  }

  /** Top to bottom. Relief goes last, since the mobile app opens a channel at its newest message. */
  panels() {
    const { positions, areas, ironMicRoleId } = this.config;
    const list = [];
    if (ironMicRoleId) list.push(ironMicPanel());
    if (areas.length) list.push(requestPanel(areas));
    if (positions.length) list.push(reliefPanel(positions));
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

  area(key) {
    return this.config.areas.find((a) => a.key === key);
  }

  async handle(interaction) {
    const id = interaction.customId;
    if (!id || interaction.guildId !== this.channel.guild.id) return;
    const [scope, kind, ...rest] = id.split(':');

    if (scope === 'relief' && kind === 'role') return this.pickRelief(interaction, rest[0]);
    if (scope === 'relief' && kind === 'hours') return this.submitHours(interaction, rest[0]);
    if (scope === 'ironmic') return this.toggleIronMic(interaction);
    if (scope === 'alert' && kind === 'claim') return this.claimAlert(interaction);
    if (scope === 'alert' && kind === 'cancel') return this.cancelAlert(interaction);

    if (scope === 'request' && kind === 'area') {
      const area = this.area(rest[0]);
      if (!area) return this.reply(interaction, 'That area is no longer set up.');
      // Showing the form has to be the first response, so the menu is reset when the form is sent.
      return interaction.showModal(requestModal(interaction.values[0], area));
    }
    if (scope === 'request' && kind === 'modal') return this.submitRequest(interaction, rest[0], rest[1]);
  }

  /**
   * Redraw the panel the interaction came from. A menu keeps showing what was picked until the
   * message is redrawn, and picking the same option again doesn't fire, so this clears it.
   */
  resetPanel(interaction, panel) {
    return interaction.update({ components: [panel] });
  }

  /** A pick in a relief position's menu. Temporary asks how long first; the rest apply straight away. */
  async pickRelief(interaction, roleId) {
    const position = this.position(roleId);
    if (!position) return this.reply(interaction, 'That position is no longer set up.');
    const choice = interaction.values[0];
    // Showing the form has to be the first response, so the menu is reset when the form is sent.
    if (choice === 'temp') return interaction.showModal(hoursModal(position));
    await this.resetPanel(interaction, reliefPanel(this.config.positions));
    return this.applyRelief(interaction, position, choice);
  }

  async submitHours(interaction, roleId) {
    const position = this.position(roleId);
    if (!position) return this.reply(interaction, 'That position is no longer set up.');
    if (interaction.isFromMessage()) await this.resetPanel(interaction, reliefPanel(this.config.positions));
    const hours = parseHours(interaction.fields.getTextInputValue('hours'));
    if (!hours) return this.reply(interaction, `Enter a whole number of hours from ${MIN_HOURS} to ${MAX_HOURS}.`);
    return this.applyRelief(interaction, position, 'temp', hours);
  }

  /**
   * @param {'temp'|'perm'|'off'} choice
   * @param {number} [hours] for Temporary
   */
  async applyRelief(interaction, position, choice, hours) {
    const { roleId } = position;
    const member = interaction.member;
    const key = `${member.id}:${roleId}`;
    const hasRole = member.roles.cache.has(roleId);
    const action = reliefAction(hasRole, this.state.grants[key], choice);

    if (action === 'none') return this.reply(interaction, `You weren't getting **${position.label}** notifications.`);
    if (action === 'remove') {
      await member.roles.remove(roleId, 'Relief notifications: opted out');
      delete this.state.grants[key];
      this.save();
      return this.reply(interaction, `🔕 You'll no longer get **${position.label}** notifications.`);
    }

    if (!hasRole) await member.roles.add(roleId, `Relief notifications: ${choice === 'temp' ? `${hours}h` : 'permanent'}`);
    const expiresAt = choice === 'temp' ? Date.now() + hours * HOUR : null;
    this.state.grants[key] = { userId: member.id, roleId, duration: choice, hours: hours ?? null, expiresAt };
    this.save();

    const until = expiresAt
      ? `until <t:${unix(expiresAt)}:t> (<t:${unix(expiresAt)}:R>)`
      : `permanently. Pick Opt out on **${position.label}** to stop`;
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

  async submitRequest(interaction, type, areaKey) {
    const area = this.area(areaKey);
    if (!area) return this.reply(interaction, 'That area is no longer set up.');
    if (interaction.isFromMessage()) await this.resetPanel(interaction, requestPanel(this.config.areas));
    const f = interaction.fields;
    const fields =
      type === 'break'
        ? { position: f.getTextInputValue('position'), stay: f.getTextInputValue('stay') }
        : { position: f.getTextInputValue('position'), reason: f.getTextInputValue('reason') };
    // A one-role area has no picker in the form and always pings its role.
    const picked = area.roles.length > 1 ? f.getStringSelectValues('notify') : area.roles.map((r) => r.roleId);
    const roles = area.roles.filter((r) => picked.includes(r.roleId));

    const now = Date.now();
    const { expireMinutes } = this.config;
    const alert = {
      channelId: this.alertChannel.id,
      type,
      area: area.label,
      userId: interaction.user.id,
      fields,
      roleIds: roles.map((r) => r.roleId),
      createdAt: now,
      expiresAt: expireMinutes ? now + expireMinutes * MINUTE : null,
      status: 'open',
      claimedBy: null,
    };
    const msg = await this.alertChannel.send(requestAlert(alert));
    this.state.alerts[msg.id] = alert;
    this.save();
    const where = this.alertChannel.id === interaction.channelId ? '' : ` in <#${this.alertChannel.id}>`;
    return this.reply(interaction, `✅ Sent. Notified ${roles.map((r) => `**${r.label}**`).join(', ')}${where}.`);
  }

  /**
   * The record for the alert a button was pressed on. If it's gone (cancelled or expired), the buttons are
   * taken off and the presser is told.
   */
  async alertFor(interaction) {
    const alert = this.state.alerts[interaction.message.id];
    if (alert) return alert;
    await interaction.update({ components: [] });
    await this.reply(interaction, 'This request is closed.');
    return null;
  }

  /** Claim an open alert, or unclaim one you claimed. Anyone but the requester can claim. */
  async claimAlert(interaction) {
    const alert = await this.alertFor(interaction);
    if (!alert) return;
    const userId = interaction.user.id;
    if (alert.userId === userId) return this.reply(interaction, "You can't claim your own request.");
    if (alert.status === 'claimed' && alert.claimedBy !== userId) return this.reply(interaction, `<@${alert.claimedBy}> already has this.`);

    if (alert.status === 'claimed') Object.assign(alert, { status: 'open', claimedBy: null });
    else Object.assign(alert, { status: 'claimed', claimedBy: userId });
    this.save();
    return interaction.update(requestAlert(alert));
  }

  /** Cancel an alert. Only the requester can. */
  async cancelAlert(interaction) {
    const alert = await this.alertFor(interaction);
    if (!alert) return;
    if (alert.userId !== interaction.user.id) return this.reply(interaction, `Only <@${alert.userId}> can cancel this.`);
    delete this.state.alerts[interaction.message.id];
    this.save();
    return interaction.update(requestAlert({ ...alert, status: 'cancelled' }));
  }

  async sweep() {
    await this.sweepGrants();
    await this.sweepAlerts();
  }

  /** Close alerts whose time is up: an open one shows Expired, a claimed one stays claimed without buttons. */
  async sweepAlerts() {
    const expired = expiredGrants(this.state.alerts, Date.now());
    if (!expired.length) return;
    for (const [messageId, alert] of expired) {
      try {
        const channel = await this.client.channels.fetch(alert.channelId);
        const msg = await channel.messages.fetch(messageId);
        const status = alertStatus(alert, Date.now());
        await msg.edit(requestAlert({ ...alert, status }, { final: true }));
      } catch (err) {
        // 10003 = Unknown Channel, 10008 = Unknown Message (deleted); anything else, try again next sweep.
        if (err.code !== 10003 && err.code !== 10008) {
          console.error(`[${new Date().toISOString()}] Could not close alert ${messageId}:`, err.message);
          continue;
        }
      }
      delete this.state.alerts[messageId];
    }
    this.save();
  }

  /** Take expired relief roles back off. */
  async sweepGrants() {
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

  /** A reply only the user sees; a follow-up if the panel was already redrawn. */
  reply(interaction, content) {
    const message = { content, flags: MessageFlags.Ephemeral };
    return interaction.replied || interaction.deferred ? interaction.followUp(message) : interaction.reply(message);
  }

  async fail(interaction, err) {
    console.error(`[${new Date().toISOString()}] Interaction ${interaction.customId} failed:`, err.message);
    // 50013 = Missing Permissions: usually the bot's role sits below the role it's handing out.
    const content =
      err.code === 50013
        ? "I don't have permission to do that. Staff: give me Manage Roles and move my role above the notification roles."
        : 'Something went wrong. Try again in a moment.';
    await this.reply(interaction, content).catch(() => {});
  }
}

module.exports = { Notifications, parseRoles, parseAreas, reliefAction, expiredGrants };
