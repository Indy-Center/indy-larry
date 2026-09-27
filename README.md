# vNAS Discord Bot

A Discord bot for Indy Center (ZID) that shows which facilities are staffed on vNAS. It posts one
embed per facility (e.g. "Indianapolis ATCT/TRACON is online") listing each controller, their
position and frequency, and edits it in place as controllers come and go.

Facility and position names come straight from vNAS, so they match what controllers see in CRC.

Data sources:
- [vNAS controller feed](https://docs.virtualnas.net/data-admin/controller-feed/): who is online
- vNAS ARTCC data API: the facility and position list for each ARTCC
- [VATSIM ATC bookings](https://atc-bookings.vatsim.net/): planned and closing times

## Setup
1. Create an application and bot at https://discord.com/developers/applications and copy the token.
2. Invite it with the `bot` scope and the View Channel, Send Messages, Embed Links and
   Read Message History permissions.
3. Copy `.env.example` to `.env`, then fill in `DISCORD_TOKEN`, `CHANNEL_ID` and `ARTCC_IDS`.
4. Run `npm install`, then `npm start` (`npm.cmd start` in Windows PowerShell).

Give the bot its own channel. It owns its messages there and removes any of its old ones on startup.

`state.json` is created automatically on first run. It records which message belongs to which
facility so restarts edit the same messages. It's specific to your server, so it isn't committed.

## Embed colors
- 🟢 **Online**: at least one controller is on.
- 🟡 **Closing**: every controller on is closing within `CLOSING_MINUTES` (default 15).
- 🔵 **Planned**: nobody's on yet, but a VATSIM ATC booking starts within `PLANNED_HOURS` (default 3).
- 🔴 **Offline**: the facility just closed. The embed is removed after `OFFLINE_MINUTES` (default 30).

Within each embed, positions are listed TRACON first, then Tower, Ground and Clearance.

## SOP: "Online until"
Add this line to your controller info, with the Eastern time and the zulu time in brackets:

    Online until 8pm ET (2400z)

The bot marks your position as closing 15 minutes before that time. If both times are given,
the zulu one is used. A booked position is also marked closing 15 minutes before its booking
ends, even without this line.

## Running with Docker
1. Create `.env` as above.
2. Start it:

       docker compose up -d --build

3. Check it logged in with `docker compose logs -f`.

The container restarts on its own after a crash or reboot. `state.json` is kept in the
`bot-state` volume, so rebuilds edit the same Discord messages. Use `docker compose down` to stop
it (not `down -v`, which also deletes the saved state). To update: `git pull`, then
`docker compose up -d --build`.

Only run one copy of the bot per channel. Two copies with the same token will keep deleting each
other's embeds.
