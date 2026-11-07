const { EmbedBuilder } = require('discord.js');
const { formatFrequency } = require('./feed');

const STATUS = {
  online: { color: 0x2ecc71, icon: '🟢', verb: 'is online' },
  closing: { color: 0xf1c40f, icon: '🟡', verb: 'is closing' },
  planned: { color: 0x3498db, icon: '🔵', verb: 'is planned' },
  offline: { color: 0xe74c3c, icon: '🔴', verb: 'is offline' },
};

const unix = (date) => Math.floor(date.getTime() / 1000);

// CMS short and radio names when there are any (IND E · Indianapolis Approach), else callsign and vNAS name.
const label = (x) => x.shortName ?? x.callsign;
const radio = (x) => x.radioName ?? x.positionName;

function controllerLine(c, { showNames }) {
  const freq = formatFrequency(c.frequency);
  const who = showNames && c.name && c.name !== c.cid ? `${c.name} (${c.rating})` : `${c.cid} (${c.rating})`;
  let line = `**${label(c)}** · ${radio(c)}${freq ? ` · ${freq}` : ''}\n└ ${who} · on since <t:${unix(c.activeSince ?? c.loginTime)}:t>`;
  if (!c.isActive) line += ' · *inactive*';
  const until = c.announcedEnd ?? c.closing?.at;
  if (until) line += `\n└ ${c.closing ? '🟡 ' : ''}Online until <t:${unix(until)}:t> (<t:${unix(until)}:R>)`;
  else if (c.closing) line += '\n└ 🟡 closing soon';
  // A center's "also covering" would repeat the Top-down line, so only the other positions show it.
  if (c.extraPositions.length && c.facilityType !== 'Center') {
    line += `\n└ also covering ${c.extraPositions.map((p) => `**${label(p)}**`).join(', ')}`;
  }
  return line;
}

function bookingLine(b) {
  const kind = b.type && b.type !== 'booking' ? ` · ${b.type}` : '';
  return `**${label(b)}** · ${radio(b) ?? ''}\n└ <t:${unix(b.start)}:t> – <t:${unix(b.end)}:t> (<t:${unix(b.start)}:R>) · CID ${b.cid}${kind}`;
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
    const last = entry.facility.controllers.map((c) => `**${label(c)}**`).join(', ');
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

/** Every online position with how many aircraft are tuned to it, busiest first. */
function trafficEmbed(positions) {
  const sorted = [...positions].sort((a, b) => b.count - a.count || a.callsign.localeCompare(b.callsign));
  const lines = sorted.map((p) => `✈️ **${p.count}** · **${label(p)}** · ${formatFrequency(p.frequency)}`);
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('✈️ Aircraft on frequency')
    .setDescription(clip(lines.join('\n')))
    .setFooter({ text: 'Aircraft near each controller, excluding guard' });
}

const staffNote = (a) => (a.staff ? `${a.staff} on` : a.topDown ? 'top-down' : 'nobody on');

/** Airborne aircraft in each ARTCC and TRACON, with how many are about to enter and who's working it. */
function congestionEmbed(staffed, { lookaheadMin }) {
  const enroute = staffed.filter((a) => a.kind === 'enroute');
  const tracons = staffed
    .filter((a) => a.kind === 'tracon')
    .sort((a, b) => b.inside + b.entering - (a.inside + a.entering) || a.key.localeCompare(b.key));
  const lines = enroute.map(
    (a) => `**${a.name}** · **${a.inside}** airborne (${a.high} high · ${a.low} low) · +${a.entering} · ${staffNote(a)}`,
  );
  if (tracons.length) {
    lines.push('', ...tracons.map((a) => `**${a.name}** · **${a.inside}** · +${a.entering} · ${staffNote(a)}`));
  }
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🗺️ ${enroute.map((a) => a.name).join(' / ') || 'Airspace'} airspace`)
    .setDescription(clip(lines.join('\n')) || 'No boundaries loaded.')
    .setFooter({ text: `Airborne aircraft by boundary · +N entering in the next ${lookaheadMin} min · high = FL240+` });
}

/** The automated "this area is getting busy" post. */
function congestionAlert(a, { roleId, lookaheadMin }) {
  const title =
    a.reason === 'uncovered'
      ? `⚠️ ${a.name} is busy with nobody on`
      : `⚠️ ${a.name} is busy: ${Math.round(a.total / a.staff)} aircraft per controller`;
  return {
    content: roleId ? `<@&${roleId}>` : undefined,
    allowedMentions: { roles: roleId ? [roleId] : [] },
    embeds: [
      new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle(title)
        .setDescription(
          `**${a.inside}** aircraft in ${a.name}, **${a.entering}** more due in ${lookaheadMin} min` +
            (a.staff ? ` · ${a.staff} controller${a.staff === 1 ? '' : 's'} on.` : '.'),
        ),
    ],
  };
}

module.exports = { statusEmbed, noneOnlineEmbed, trafficEmbed, congestionEmbed, congestionAlert };
