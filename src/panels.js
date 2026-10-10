const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');

// How long a Temporary relief notification role can last, in whole hours.
const MIN_HOURS = 1;
const MAX_HOURS = 24;

const RELIEF_OPTIONS = [
  { value: 'temp', label: 'Temporary', description: `${MIN_HOURS} to ${MAX_HOURS} hours; you'll be asked how long` },
  { value: 'perm', label: 'Permanent', description: 'Until you opt out' },
  { value: 'off', label: 'Opt out' },
];

const REQUEST_TYPES = [
  { value: 'break', label: 'Break', description: 'Ask for someone to relieve you' },
  { value: 'staffing', label: 'Staffing', description: 'Ask for another position to open' },
];

const text = (content) => new TextDisplayBuilder().setContent(content);

/** One drop-down per item, each in its own row, with the item's name as the placeholder. */
function menus(items, prefix, idOf, options) {
  return items.map((item) =>
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`${prefix}:${idOf(item)}`).setPlaceholder(item.label).addOptions(options),
    ),
  );
}

function reliefPanel(positions) {
  return new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      text('## Controller Relief Notification'),
      text('Use the menus below to opt in to receiving notifications when controllers request a break or additional staffing for specific positions.'),
      text(`-# Pick Temporary (${MIN_HOURS}–${MAX_HOURS} hours) or Permanent for each position. Picking Temporary again sets a new time; Opt out stops.`),
    )
    .addActionRowComponents(...menus(positions, 'relief:role', (p) => p.roleId, RELIEF_OPTIONS));
}

/** Asks how many hours a Temporary relief role should last. */
function hoursModal(position) {
  return new ModalBuilder()
    .setCustomId(`relief:hours:${position.roleId}`)
    .setTitle(`Temporary · ${position.label}`.slice(0, 45))
    .addLabelComponents(
      new LabelBuilder()
        .setLabel(`How many hours? (${MIN_HOURS}–${MAX_HOURS})`)
        .setTextInputComponent(
          new TextInputBuilder()
            .setCustomId('hours')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('e.g. 4')
            .setMinLength(1)
            .setMaxLength(2),
        ),
    );
}

/** "4" -> 4; anything that isn't a whole number from MIN_HOURS to MAX_HOURS -> null. */
function parseHours(value) {
  const text = String(value).trim();
  if (!/^\d+$/.test(text)) return null;
  const hours = Number(text);
  return hours >= MIN_HOURS && hours <= MAX_HOURS ? hours : null;
}

function requestPanel(areas) {
  return new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      text('## Controller Break/Staffing Notification System'),
      text('Use the menus below to request a break or additional positions to come online for specific positions.'),
      text('-# Pick Break or Staffing on your area, then choose who to notify in the form.'),
    )
    .addActionRowComponents(...menus(areas, 'request:area', (a) => a.key, REQUEST_TYPES));
}

function ironMicPanel() {
  return new ContainerBuilder()
    .setAccentColor(0x9b59b6)
    .addTextDisplayComponents(
      text('## Iron Mic Notification Preference'),
      text('Use the button below to opt in/out receiving notifications for Iron Mic'),
    )
    .addActionRowComponents(
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ironmic:toggle').setLabel('Iron Mic').setEmoji('🎙️').setStyle(ButtonStyle.Primary),
      ),
    );
}

const shortInput = (id, placeholder, { required = true, max = 50, min = 0 } = {}) =>
  new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setRequired(required).setMinLength(min).setMaxLength(max);

/** The clock in Zulu as "HHMM", e.g. "0245". */
function zuluNow(now = Date.now()) {
  const d = new Date(now);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * "0200" -> the next time the Zulu clock reads 0200, as a timestamp (tomorrow if it has already passed).
 * Anything but exactly four digits from 0000 to 2359 -> null.
 */
function parseZulu(value, now = Date.now()) {
  const m = String(value).trim().match(/^([01]\d|2[0-3])([0-5]\d)$/);
  if (!m) return null;
  const at = new Date(now);
  at.setUTCHours(Number(m[1]), Number(m[2]), 0, 0);
  if (+at <= now) at.setUTCDate(at.getUTCDate() + 1);
  return +at;
}

/** The form a controller fills in after picking a request type and a position. */
/** Who to ping. Left out when the area has only one role, which is then always pinged. */
function notifyPicker(area) {
  if (area.roles.length < 2) return [];
  return [
    new LabelBuilder()
      .setLabel('Who to notify')
      .setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId('notify')
          .setPlaceholder('Pick one or more')
          .setMinValues(1)
          .setMaxValues(area.roles.length)
          .addOptions(area.roles.map((r) => ({ label: r.label, value: r.roleId }))),
      ),
  ];
}

/** The form a controller fills in after picking a request type on an area. */
function requestModal(type, area) {
  const modal = new ModalBuilder().setCustomId(`request:modal:${type}:${area.key}`);
  if (type === 'break') {
    return modal.setTitle(`Break request · ${area.label}`).addLabelComponents(
      new LabelBuilder().setLabel('Position you need relief from').setTextInputComponent(shortInput('position', 'e.g. IND_GND', { max: 20 })),
      new LabelBuilder()
        .setLabel(`Stay on until (Zulu HHMM) · now ${zuluNow()}Z`)
        .setTextInputComponent(shortInput('stay', 'e.g. 0200', { min: 4, max: 4 })),
      ...notifyPicker(area),
    );
  }
  return modal.setTitle(`Staffing request · ${area.label}`).addLabelComponents(
    new LabelBuilder().setLabel("Position you're working").setTextInputComponent(shortInput('position', 'e.g. IND_TWR', { max: 20 })),
    ...notifyPicker(area),
    new LabelBuilder()
      .setLabel('Brief reason')
      .setTextInputComponent(shortInput('reason', 'e.g. departure push, weather', { required: false, max: 100 })),
  );
}

const CLAIMED_COLOR = 0x2ecc71;
const CLOSED_COLOR = 0x95a5a6;

/**
 * What an alert shows right now: an open alert past its expiry time counts as expired.
 * @returns {'open'|'claimed'|'cancelled'|'expired'}
 */
function alertStatus(alert, now) {
  return alert.status === 'open' && alert.expiresAt != null && alert.expiresAt <= now ? 'expired' : alert.status;
}

/**
 * The alert posted for a submitted request, drawn from its stored record. The role mentions go in the
 * content so they ping; edits never ping again. Open and claimed alerts get Claim/Unclaim and Cancel
 * buttons unless `final` is set; cancelled and expired ones get none.
 * @param {{ type: string, area: string, userId: string, fields: object, roleIds: string[], createdAt: number,
 *   expiresAt: number|null, status: 'open'|'claimed'|'cancelled'|'expired', claimedBy: string|null }} alert
 */
function requestAlert(alert, { final = false } = {}) {
  const { type, area, userId, fields, status } = alert;
  const embed = new EmbedBuilder().setTimestamp(alert.createdAt);
  if (type === 'break') {
    embed
      .setColor(0xf1c40f)
      .setTitle(`Break requested · ${area}`)
      .addFields(
        { name: 'Requested by', value: `<@${userId}>`, inline: true },
        { name: 'Relief needed on', value: fields.position, inline: true },
        { name: 'Can stay on until', value: /^\d{4}$/.test(fields.stay) ? `${fields.stay}Z` : fields.stay, inline: true },
      );
  } else {
    embed
      .setColor(0xe67e22)
      .setTitle(`Staffing requested · ${area}`)
      .addFields(
        { name: 'Requested by', value: `<@${userId}>`, inline: true },
        { name: 'Working', value: fields.position, inline: true },
      );
    if (fields.reason) embed.addFields({ name: 'Reason', value: fields.reason });
  }

  const title = embed.data.title;
  if (status === 'claimed') {
    embed.setColor(CLAIMED_COLOR).setTitle(`✅ Claimed · ${title}`).addFields({ name: 'Claimed by', value: `<@${alert.claimedBy}>` });
  } else if (status === 'cancelled' || status === 'expired') {
    embed.setColor(CLOSED_COLOR).setTitle(`${status === 'cancelled' ? 'Cancelled' : 'Expired'} · ${title}`);
  } else if (alert.expiresAt != null) {
    embed.setDescription(`-# Expires <t:${Math.floor(alert.expiresAt / 1000)}:R> if nobody claims it`);
  }

  const live = !final && (status === 'open' || status === 'claimed');
  const components = live
    ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId('alert:claim')
            .setLabel(status === 'claimed' ? 'Unclaim' : 'Claim')
            .setStyle(status === 'claimed' ? ButtonStyle.Secondary : ButtonStyle.Success),
          new ButtonBuilder().setCustomId('alert:cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger),
        ),
      ]
    : [];
  const ids = alert.roleIds;
  return { content: ids.map((id) => `<@&${id}>`).join(' '), embeds: [embed], components, allowedMentions: { roles: ids } };
}

module.exports = {
  MIN_HOURS,
  MAX_HOURS,
  REQUEST_TYPES,
  reliefPanel,
  hoursModal,
  parseHours,
  parseZulu,
  zuluNow,
  requestPanel,
  ironMicPanel,
  requestModal,
  requestAlert,
  alertStatus,
};
