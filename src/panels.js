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

// How long a relief notification role lasts. "perm" keeps it until the user drops it.
const DURATIONS = [
  { value: '3', label: '3 hours', hours: 3 },
  { value: '6', label: '6 hours', hours: 6 },
  { value: '9', label: '9 hours', hours: 9 },
  { value: '12', label: '12 hours', hours: 12 },
  { value: 'perm', label: 'Permanent', hours: null },
];

const REQUEST_TYPES = [
  { value: 'break', label: 'Break', description: 'Ask for someone to relieve you' },
  { value: 'staffing', label: 'Staffing', description: 'Ask for another position to open' },
];

const STAFFING_AREAS = ['Cab', 'TRACON sector', 'Enroute sector'];

const text = (content) => new TextDisplayBuilder().setContent(content);

/** One drop-down per position, each in its own row, with the position's name as the placeholder. */
function positionMenus(positions, prefix, options) {
  return positions.map((p) =>
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId(`${prefix}:${p.roleId}`).setPlaceholder(p.label).addOptions(options),
    ),
  );
}

function reliefPanel(positions) {
  return new ContainerBuilder()
    .setAccentColor(0x3498db)
    .addTextDisplayComponents(
      text('## Controller Relief Notification'),
      text('Use the menus below to opt in to receiving notifications when controllers request a break or additional staffing for specific positions.'),
      text('-# Pick how long for each position. Pick a different length to change it, or Opt out (or the length you already have) to stop.'),
    )
    .addActionRowComponents(
      ...positionMenus(positions, 'relief:role', [
        ...DURATIONS.map((d) => ({ label: d.label, value: d.value })),
        { label: 'Opt out', value: 'off' },
      ]),
    );
}

function requestPanel(positions) {
  return new ContainerBuilder()
    .setAccentColor(0xe67e22)
    .addTextDisplayComponents(
      text('## Controller Break/Staffing Notification System'),
      text('Use the menus below to request a break or additional positions to come online for specific positions.'),
      text('-# Pick Break or Staffing on the position that should be notified.'),
    )
    .addActionRowComponents(...positionMenus(positions, 'request:pos', REQUEST_TYPES));
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

const shortInput = (id, placeholder, { required = true, max = 50 } = {}) =>
  new TextInputBuilder().setCustomId(id).setStyle(TextInputStyle.Short).setPlaceholder(placeholder).setRequired(required).setMaxLength(max);

/** The form a controller fills in after picking a request type and a position. */
function requestModal(type, position) {
  const modal = new ModalBuilder().setCustomId(`request:modal:${type}:${position.roleId}`);
  if (type === 'break') {
    return modal.setTitle(`Break request · ${position.label}`.slice(0, 45)).addLabelComponents(
      new LabelBuilder().setLabel('Position you need relief from').setTextInputComponent(shortInput('position', 'e.g. IND_GND', { max: 20 })),
      new LabelBuilder()
        .setLabel('How long can you stay on?')
        .setTextInputComponent(shortInput('stay', 'e.g. 30 minutes, or until 0200z')),
    );
  }
  return modal.setTitle(`Staffing request · ${position.label}`.slice(0, 45)).addLabelComponents(
    new LabelBuilder().setLabel("Position you're working").setTextInputComponent(shortInput('position', 'e.g. IND_TWR', { max: 20 })),
    new LabelBuilder()
      .setLabel('Area to staff')
      .setStringSelectMenuComponent(
        new StringSelectMenuBuilder()
          .setCustomId('area')
          .setPlaceholder('Cab, TRACON sector or Enroute sector')
          .addOptions(STAFFING_AREAS.map((a) => ({ label: a, value: a }))),
      ),
    new LabelBuilder()
      .setLabel('Brief reason')
      .setTextInputComponent(shortInput('reason', 'e.g. departure push, weather', { required: false, max: 100 })),
  );
}

/** The alert posted for a submitted request. The role mention goes in the content so it pings. */
function requestAlert(type, position, userId, fields) {
  const embed = new EmbedBuilder().setTimestamp();
  if (type === 'break') {
    embed
      .setColor(0xf1c40f)
      .setTitle(`Break requested ·${position.label}`)
      .addFields(
        { name: 'Requested by', value: `<@${userId}>`, inline: true },
        { name: 'Relief needed on', value: fields.position, inline: true },
        { name: 'Can stay on', value: fields.stay, inline: true },
      );
  } else {
    embed
      .setColor(0xe67e22)
      .setTitle(`Staffing requested ·${position.label}`)
      .addFields(
        { name: 'Requested by', value: `<@${userId}>`, inline: true },
        { name: 'Working', value: fields.position, inline: true },
        { name: 'Wants staffed', value: fields.area, inline: true },
      );
    if (fields.reason) embed.addFields({ name: 'Reason', value: fields.reason });
  }
  return { content: `<@&${position.roleId}>`, embeds: [embed], allowedMentions: { roles: [position.roleId] } };
}

module.exports = { DURATIONS, REQUEST_TYPES, reliefPanel, requestPanel, ironMicPanel, requestModal, requestAlert };
