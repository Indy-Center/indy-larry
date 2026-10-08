const { EmbedBuilder } = require('discord.js');
const { formatFrequency } = require('./feed');

const STATUS = {
  online: { color: 0x2ecc71, icon: '🟢', verb: 'is online' },
  closing: { color: 0xf1c40f, icon: '🟡', verb: 'is closing' },
  planned: { color: 0x3498db, icon: '🔵', verb: 'is planned' },
  offline: { color: 0xe74c3c, icon: '🔴', verb: 'is offline' },
};

const unix = (date) => Math.floor(date.getTime() / 1000);

function controllerLine(c, { showNames }) {
  const freq = formatFrequency(c.frequency);
  const who = showNames && c.name && c.name !== c.cid ? `${c.name} (${c.rating})` : `${c.cid} (${c.rating})`;
  let line = `**${c.callsign}** · ${c.positionName}${freq ? ` · ${freq}` : ''}\n└ ${who} · on since <t:${unix(c.activeSince ?? c.loginTime)}:t>`;
  if (!c.isActive) line += ' · *inactive*';
  const until = c.announcedEnd ?? c.closing?.at;
  if (until) line += `\n└ ${c.closing ? '🟡 ' : ''}Online until <t:${unix(until)}:t> (<t:${unix(until)}:R>)`;
  else if (c.closing) line += '\n└ 🟡 closing soon';
  if (c.extraPositions.length) {
    line += `\n└ also covering ${c.extraPositions.map((p) => `**${p.callsign}**`).join(', ')}`;
  }
  return line;
}

function bookingLine(b) {
  const kind = b.type && b.type !== 'booking' ? ` · ${b.type}` : '';
  return `**${b.callsign}** · ${b.positionName ?? ''}\n└ <t:${unix(b.start)}:t> – <t:${unix(b.end)}:t> (<t:${unix(b.start)}:R>) · CID ${b.cid}${kind}`;
}

function clip(text) {
  return text.length > 4000 ? text.slice(0, 3990) + '\n…' : text;
}

/** One embed for a StatusBoard entry. */
function statusEmbed(entry, opts = {}) {
  const s = STATUS[entry.status];
  const embed = new EmbedBuilder()
    .setColor(s.color)
    .setTitle(`${s.icon} ${entry.facilityName} ${s.verb}`);

  if (entry.status === 'online' || entry.status === 'closing') {
    const lines = entry.facility.controllers.map((c) => controllerLine(c, opts));
    if (entry.topDown?.length) {
      // "Evansville ATCT/TRACON" -> "Evansville TRACON"
      const names = entry.topDown.map((f) => f.name.replace('ATCT/TRACON', 'TRACON')).sort();
      lines.push(`**Top-down:** ${names.join(' · ')}`);
    }
    embed.setDescription(clip(lines.join('\n\n')));
  } else if (entry.status === 'planned') {
    embed.setDescription(clip(entry.bookings.map(bookingLine).join('\n\n')));
  } else {
    const last = entry.facility.controllers.map((c) => `**${c.callsign}**`).join(', ');
    embed.setDescription(`Closed <t:${unix(entry.closedAt)}:R>\nLast on: ${last}`);
  }
  return embed;
}

function noneOnlineEmbed(artccIds) {
  return new EmbedBuilder()
    .setColor(0x4a5568)
    .setTitle('⚫ No ATC online')
    .setDescription(artccIds.length ? `Nobody is controlling in ${artccIds.join(', ')} right now.` : 'Nobody is controlling right now.');
}

module.exports = { statusEmbed, noneOnlineEmbed };
