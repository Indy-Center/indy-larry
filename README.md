# vnas-discord-bot

A Discord bot that shows which Indy Center (ZID) facilities are staffed on vNAS. It polls the vNAS controller feed every 30 seconds and keeps one embed per facility up to date in a Discord channel.

[![Build and Deploy](https://github.com/Indy-Center/vnas-discord-bot/actions/workflows/build-and-deploy.yml/badge.svg)](https://github.com/Indy-Center/vnas-discord-bot/actions/workflows/build-and-deploy.yml)

## Embeds

One embed per facility (e.g. "Indianapolis ATCT/TRACON is online"), listing each controller with their position, frequency and when they went active. Facility and position names come straight from vNAS, so they match CRC. Positions are listed TRACON first, then Tower, Ground and Clearance.

- 🟢 **Online**: at least one controller is on.
- 🟡 **Closing**: every controller on is closing within `CLOSING_MINUTES` (default 15).
- 🔵 **Planned**: nobody's on yet, but a VATSIM ATC booking starts within `PLANNED_HOURS` (default 3).
- 🔴 **Offline**: the facility just closed. The embed is removed after `OFFLINE_MINUTES` (default 30).

### SOP: "Online until"

Controllers add this line to their controller info, with the Eastern time and the zulu time in brackets:

    Online until 8pm ET (2400z)

The bot marks the position as closing 15 minutes before that time. If both times are given, the zulu one is used. A booked position is also marked closing 15 minutes before its booking ends, even without this line.

## Project layout

- `src/bot.js`: logs in, polls every `POLL_SECONDS`, and posts, edits and deletes embeds.
- `src/feed.js`: fetches the [vNAS controller feed](https://docs.virtualnas.net/data-admin/controller-feed/), the vNAS ARTCC data (facility and position list) and [VATSIM ATC bookings](https://atc-bookings.vatsim.net/), groups controllers by facility and tracks activation times.
- `src/status.js`: decides each facility's status and parses "Online until" from controller info.
- `src/embeds.js`: the embed layout.
- `test/`: unit tests.
- `Dockerfile`: the image, published as `ghcr.io/indy-center/vnas-discord-bot`.
- `deploy/docker-compose.yml`: what's deployed to `/home/deploy/apps/vnas-discord-bot/` on the VPS. Keeps `state.json` in the `bot-state` volume.
- `.github/workflows/ci.yml`: tests, compose validation and an image build, on every pull request.
- `.github/workflows/build-and-deploy.yml`: runs CI, pushes the image to GHCR, then rsyncs `deploy/` to the VPS and runs `docker compose up -d` over SSH.
- `.env.example`: every setting, with its default.

## Local development

```bash
npm install
cp .env.example .env # then fill in DISCORD_TOKEN and CHANNEL_ID
npm start            # npm.cmd start in Windows PowerShell
```

Or in Docker:

```bash
docker build -t vnas-discord-bot .
docker run --rm --env-file .env -v vnas-discord-bot-state:/data vnas-discord-bot
```

Create the bot at https://discord.com/developers/applications and give it the View Channel, Send Messages, Embed Links and Read Message History permissions in a channel of its own. It owns its messages there and removes any of its old ones on startup.

Use a test channel, or stop the production bot first. Two copies with the same token keep deleting each other's embeds.

`state.json` is created on first run. It records which message belongs to which facility, and when each controller went active, so restarts edit the same messages. It isn't committed.

## Tests

```bash
npm test
```

## Deployment

The bot runs on the Vanderbilt VPS, following the [VPS apps pattern](https://tech.flyindycenter.com/patterns/vps-apps/). It only makes outbound calls (Discord, vNAS, VATSIM), so it has no Traefik labels, doesn't join `traefik-shared` and publishes no ports.

`build-and-deploy.yml` runs on every push to `main`, and by hand from **Actions → Build and Deploy → Run workflow**. It calls `ci.yml` and only deploys if it passes. It builds the image and pushes it to `ghcr.io/indy-center/vnas-discord-bot`, tagged `latest` and with the commit SHA. It then writes `.env` from the `DOTENV` secret, rsyncs `deploy/` to `/home/deploy/apps/vnas-discord-bot/`, pulls and runs `docker compose up -d`, and fails if anything is restarting 15 seconds later.

Secrets:

- **Deploy credentials**: the `VANDERBILT_HOST`, `VANDERBILT_DEPLOY_USER`, `VANDERBILT_DEPLOY_SSH_KEY` and `VANDERBILT_KNOWN_HOSTS` organization secrets. An org admin adds this repository to their repository access.
- **Runtime settings**: the `DOTENV` repository secret, holding the whole `.env` file (`DISCORD_TOKEN`, `CHANNEL_ID` and the other settings from `.env.example`). Every deploy writes it to `/home/deploy/apps/vnas-discord-bot/.env`, readable only by `deploy`. It's never in git or the image. Unlike the [VPS apps pattern](https://tech.flyindycenter.com/patterns/vps-apps/), which keeps runtime secrets on the VPS only, this lets the bot be managed without shell access to the VPS.

To change a setting, update `DOTENV` (**Settings → Secrets and variables → Actions**), then run **Build and Deploy**.

### First deploy

1. An org admin adds this repository to the `VANDERBILT_*` secrets.
2. Add the `DOTENV` repository secret: paste in the whole `.env` file.
3. Stop any other copy of the bot.
4. Run **Build and Deploy**. The first run pushes the image, then fails at the pull, because new GHCR packages start private.
5. Make the package public: **Indy-Center → Packages → vnas-discord-bot → Package settings → Change visibility → Public**.
6. Run **Build and Deploy** again, then check the run's log, or on the VPS:

   ```bash
   cd /home/deploy/apps/vnas-discord-bot && docker compose ps && docker compose logs --tail 50
   ```

## Disclaimer

We are not affiliated with the FAA or any aviation governing body. This software is for flight simulation use on the [VATSIM](https://www.vatsim.net) network.
