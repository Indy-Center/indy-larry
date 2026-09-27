# vNAS Online ATC Discord Bot

Posts one embed per facility (e.g. "Indianapolis TRACON is online") listing each controller,
their position and frequency. Embeds are edited in place as controllers come and go, and deleted
when the facility goes offline. Data: https://docs.virtualnas.net/data-admin/controller-feed/

## Setup
1. Create an app + bot at https://discord.com/developers/applications and copy the token.
2. Invite it with the `bot` scope and View Channel, Send Messages, Embed Links,
   and Read Message History permissions.
3. `cp .env.example .env`, then fill in DISCORD_TOKEN, CHANNEL_ID and ARTCC_IDS.
4. `npm install` and `npm start`.

Use a dedicated channel: the bot owns its messages there and cleans them up on restart.

## Embed colours
- 🟢 Online: at least one controller is on.
- 🟡 Closing: every controller on is closing within `CLOSING_MINUTES` (default 15).
- 🔵 Planned: nobody's on yet, but a VATSIM ATC booking starts within `PLANNED_HOURS` (default 3).
- 🔴 Offline: the facility just closed. The embed is removed after `OFFLINE_MINUTES` (default 30).

## SOP: announcing you're closing
Add this line to your controller info, with the Eastern time and the zulu time in brackets:

    Online until 8pm ET (2400z)

The bot marks your position as closing 15 minutes before that time. If both times are given,
the zulu one is used. A booked position is also marked closing 15 minutes before its booking
ends, even without this line.
