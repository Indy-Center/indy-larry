# vnas-discord-bot

A Discord bot that shows which Indy Center (ZID) facilities are staffed on vNAS. It polls the vNAS controller feed every 30 seconds and keeps one embed per facility up to date in a Discord channel.

[![Build and Deploy](https://github.com/Indy-Center/indy-larry/actions/workflows/build-and-deploy.yml/badge.svg)](https://github.com/Indy-Center/indy-larry/actions/workflows/build-and-deploy.yml)

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

## Notification panels

If `PANEL_CHANNEL_ID` is set, the bot also keeps three panels in that channel, in this order from the top. Relief is last because the mobile app opens a channel at its newest message. Each uses Discord's newer message components, and the bot's replies are visible only to the person who picked or pressed something.

- **Iron Mic Notification Preference**: one button that adds or removes `IRON_MIC_ROLE_ID`.
- **Controller Break/Staffing Notification System**: one drop-down per area (CAB, TRACON, ENROUTE); pick Break or Staffing on your area. A form asks for the position you need relief from and how long you can stay on (Break), or the position you're working and a brief optional reason (Staffing), plus who to notify out of that area's roles. An area with a single role skips that question and always pings it. The request is posted in `ALERT_CHANNEL_ID` and pings the chosen roles. Anyone but the requester can press **Claim** on it, which turns it green and shows who has it; only they can press **Unclaim** to reopen it. The requester can **Cancel** it. An alert nobody has claimed turns grey as Expired after `REQUEST_EXPIRE_MINUTES` (default 60; 0 turns this off), and a claimed one loses its buttons then.
- **Controller Relief Notification**: one drop-down per position. Pick Permanent, or Temporary and enter a whole number of hours from 1 to 24 in the form, to get that position's role. Temporary roles come off within 30 seconds of running out, even across restarts. Picking Temporary again sets a new time from now, and switching between Temporary and Permanent changes the role over; Opt out, or Permanent when you already have it, removes the role.

The positions and their roles come from `RELIEF_ROLES`, e.g. `S Ground:111,A Ground:222,S Local:333,A Local:444,T Radar:555,E Radar:666`, so a dev server and the production server can use different roles. The drop-downs follow that order. Each request area's roles come from `CAB_ROLES`, `TRACON_ROLES` and `ENROUTE_ROLES` in the same format, e.g. `CAB_ROLES=S-GC:111,A-GC:222,S-LC:333,A-LC:444`; they can be the same roles as `RELIEF_ROLES` under different names. Each panel is redrawn after a pick, so the drop-downs go back to showing the position names. The panels are edited in place on every start, so a changed setting shows up after a restart.

The bot needs **Manage Roles**, and its own role has to sit above every role it hands out. To ping a role it also needs **Mention @everyone, @here and All Roles** in the alert channel, or the role has to allow anyone to mention it. `notify.json` holds the panel message IDs, who has which role until when, and the request alerts that can still be claimed or cancelled. It isn't committed.

## Iron Mic leaderboard

Staff run `/ironmic` in any channel except `CHANNEL_ID` to keep a leaderboard of how long a facility's positions were staffed. The leaderboard is one message at the top of `CHANNEL_ID`, above the status embeds, with an embed per position in the order Center, Approach, Local, Ground, Delivery. Set `IRON_MIC_CHANNEL_ID` to post it somewhere else instead, such as a test channel.

- `/ironmic start facility:LEX positions:local, approach` posts the leaderboard (reposting the status embeds below it) and pings `IRON_MIC_ROLE_ID`, if set, in the channel it was run in. The facility list comes from the vNAS ARTCC data (towers and TRACONs in `ARTCC_IDS`). Positions are `center`, `approach`, `local`, `ground` and `delivery` (or `ctr`, `app`, `twr`, `gnd`, `del`), any combination.
- `/ironmic end` stops it. The leaderboard shows the final totals within a minute.
- `/ironmic clear` deletes the leaderboard and its log, after `end`. Only one Iron Mic runs at a time.

Totals come from [vNAS Stats](https://vnas-stats.com) ([source](https://github.com/kengreim/vnas-stats)), fetched every 5 minutes. An Iron Mic always counts from midnight UTC on the 1st of the month `start` was run in, so it matches the site's month view. It counts active controllers and groups time by callsign prefix and suffix, ignoring the middle part, so `LEX_APP` and `LEX_N_APP` are both LEX approach and two controllers on it at once count once. Which callsigns a position covers comes from the vNAS ARTCC data: Center is the ARTCC's (`IND_CTR`), Approach is the TRACON over the facility (DAY's is CMH's, `CMH_APP` + `DAY_APP`), and Local, Ground and Delivery are the facility's own. A position with several callsigns adds them up. `start` refuses a position the facility doesn't have, like PKB approach. Its list only has the network's top callsigns; a position that didn't make it shows as "Under" the last one listed.
By default only members with **Manage Server** see the command; change who can use it under **Server Settings → Integrations → Larry**. The bot needs **View Channel**, **Send Messages** and **Embed Links** where it's run and in the leaderboard's channel, and the role ping needs the same mention permission as the request alerts. `ironmic.json` holds the running Iron Mic and its message ID, so a restart edits the same message. It isn't committed.

## Sending messages from other apps

Other Indy Center Workers can send Discord messages as Larry instead of keeping their own webhooks: to a channel by name, or as a DM to a user. A small Cloudflare Worker in `worker/` (`indy-larry`) does the sending with Larry's token, through Discord's REST API, so the bot on the VPS isn't involved. Following the [RPC vs Queue pattern](https://tech.flyindycenter.com/patterns/rpc-vs-queue/), callers reach it over a service binding; it has no HTTP route and isn't on the internet.

```jsonc
// caller's wrangler.jsonc
"services": [{ "binding": "LARRY", "service": "indy-larry" }]
```

```ts
import type { LarryBinding } from '@indy-center/larry'; // npm install @indy-center/larry

// RPC: sends now and returns { channelId, messageId }; throws if Discord refuses it.
await env.LARRY.send({
  channel: 'events',
  content: `<@${userId}> your session is confirmed`,
  embeds: [{ title: 'FNO', color: 0x5865f2 }],
});
await env.LARRY.sendDirect({ userId, content: 'Your training session starts in an hour.' });

// Queue: returns once queued; delivery retries rate limits and Discord outages.
await env.LARRY.enqueue({ channel: 'events', content: 'FNO starts in one hour! @everyone', allowedMentions: { parse: ['everyone'] } });
await env.LARRY.enqueueDirect({ userId, embeds: [{ title: 'Request approved' }] });
```

- **Channels**: callers name a channel from `SEND_CHANNELS` (`name:channelId`, like `RELIEF_ROLES`), e.g. `SEND_CHANNELS=events:111,training:222`. Any other name, or a channel ID, is refused, so a channel moves by changing the setting and redeploying, with no change to the callers. The deploy fails on a malformed entry, a repeated name, or `CHANNEL_ID`, where the status loop would delete the message.
- **DMs** take the user's Discord ID. The user has to share a server with Larry and accept DMs from it; if not, `sendDirect()` throws and a queued DM is dropped.
- **Mentions**: `allowedMentions` goes to Discord as `allowed_mentions`, unchanged. Without it, the users mentioned in the content (`<@id>`) are pinged and nobody else is.
- **Checks**: every method throws straight away for an unknown channel, a bad user ID, an empty message, more than 2000 characters or more than 10 embeds; the queue methods queue nothing then.
- **Delivery**: `send()` waits out a rate limit of 5 seconds or less once, then throws. The queue (`larry-messages`) waits for Discord's `retry_after` on a rate limit, backs off on 5xx and network errors, and drops a message Discord refuses (4xx), logging why. When the refusal is Larry's own setup, the queue run also **fails**, so it shows as an error on the Worker's dashboard: a channel Larry can't see or post in (403), one that no longer exists (404), or a bad token (401). The message is still dropped, not retried. A bad embed or a user who won't take DMs is logged only. After 5 attempts a message moves to `larry-messages-dlq`. Each queued message carries a nonce, so a retry can't post twice.

The bot needs **View Channel**, **Send Messages** and **Embed Links** in each channel in `SEND_CHANNELS`.

### Roles and channels

Two more things callers can ask Larry to keep in step, separately: who holds a role, and private channels under a category. Neither knows what it is for. Training-tools uses both together (a role per teacher, held by the teacher and their students, and a channel only that role and the training admins see), but an app that only needs roles uses only `syncRoles()`.

```ts
// Roles: who holds which.
const { roles } = await env.LARRY.syncRoles({
  roles: [{ key: 'JR', name: 'JR', members: [teacherId, studentId], exclusive: true }],
  dryRun: true, // report what would change, and change nothing
});

// Channels: find or create, under a category Larry is allowed to use.
const { channels } = await env.LARRY.syncChannels({
  channels: [{ key: 'JR', category: 'training', name: 'Jo Rivera', visibleTo: [roles[0].roleId, trainingAdminRoleId] }],
});

// Post to one by ID.
await env.LARRY.enqueueToChannel({ channelId: channels[0].channelId, content: `<@${studentId}> you're with <@${teacherId}>` });
```

**`syncRoles()`**

- A role is found by `id` when given, otherwise by exact name, otherwise created with no permissions. Two roles of the same name is an error for that entry; Larry won't guess.
- Everyone in `members` gets the role. With `exclusive: true`, **everyone else holding it loses it**, however they got it. With `exclusive: false` Larry only ever adds. The caller has to say which.
- Someone not in the server comes back in `notInServer`; call again later and they are picked up once they join.
- Larry refuses a role that carries moderation permissions (Administrator, Manage Roles, Kick, Ban and the like), one that belongs to a bot or integration, and @everyone. It manages labels, so that a caller with the binding can't make anyone a moderator.

**`setMemberRole()` and `enqueueMemberRole()`** change one role for one person: `{ userId, roleId, has }`. They are for a single change made on the spot, like a button press, where there is no repeating check behind it to put things right later. `setMemberRole()` does it now and throws if Discord refuses. `enqueueMemberRole()` checks the role, queues the change on `larry-messages` and returns; delivery retries rate limits and Discord outages the way queued messages do, and a change for someone not in the server is logged and dropped. Both sit behind the same guard as `syncRoles()`. To keep a whole role's membership in step, use `syncRoles()`, which needs no queue: it is called again on a schedule and only changes what is out of step.

**`syncChannels()`**

- A channel is found by `id`, otherwise by name under its category, otherwise created there. The name is lowercased and hyphenated the way Discord stores it (`Jo Rivera` → `#jo-rivera`).
- `category` is a name from `CHANNEL_CATEGORIES` (`name:categoryId`, like `SEND_CHANNELS`). Any other category is refused.
- A channel Larry **creates** is hidden from everyone but the roles in `visibleTo` and Larry itself. A channel it **finds** keeps its permissions exactly as they are.

**Both**

- `dryRun: true` makes no changes and returns what would happen. Run this first against a server where roles or channels were made by hand.
- One entry failing (returned with `error`) doesn't stop the others.
- Store the `roleId` and `channelId` that come back and pass them next time, so a rename in Discord doesn't make Larry create a second one.
- `rename: true` on an entry keeps the name in step: a role or channel found by its ID under a different name is renamed to the one asked for. Without it Larry never renames anything. Discord allows a channel only two renames in ten minutes.

**`deleteRoles()` and `deleteChannels()`** take IDs and remove them for good: a deleted role is gone for everyone who held it, and a deleted channel takes its messages with it. Neither can be undone. They sit behind the same fences as everything else here: no role with moderation permissions, no bot's role, and only text channels under a category in `CHANNEL_CATEGORIES`. One that is already gone comes back as `gone`, not an error. Both take `dryRun`.

`sendToChannel()` and `enqueueToChannel()` post by channel ID, and refuse any channel that isn't a text channel under a category in `CHANNEL_CATEGORIES`.

Setup, once:

1. Give Larry **Manage Channels** as well as Manage Roles, and move its role above every role it should manage. It can't hand out or remove a role that sits above its own.
2. In the Discord developer portal, switch on **Server Members Intent** for the bot. Without it Larry can't list who holds a role, so it still adds people but never removes anyone, and `canSeeMembers` comes back `false`.
3. Add the repository variables `ENV_GUILD_ID` (the server) and `ENV_CHANNEL_CATEGORIES` (e.g. `training:123456789`). Until `ENV_GUILD_ID` is set these methods refuse every call.

**Types for callers** are published to npm as [`@indy-center/larry`](https://www.npmjs.com/package/@indy-center/larry), like `@indy-center/identity`: install it as a dependency and type the binding as `LARRY: LarryBinding`. It's types only, built from `worker/src/client/`; callers also need `@cloudflare/workers-types` (or `wrangler types`) for `Service` and `Rpc`. It's public so callers install it with no npm login, and it holds nothing that isn't already in this repo. To publish a change to `src/client/`: bump `version` in `worker/package.json` and merge. The `publish-types` job in `build-and-deploy.yml` publishes any version npm doesn't have yet, and does nothing when the version is unchanged. It needs the `NPM_TOKEN` repository secret, an npm access token allowed to publish the package; without it the job warns and passes. To publish by hand instead, run `npm publish` from `worker/` (needs publish rights on the `@indy-center` npm org; `prepublishOnly` builds `dist/`).

First time only, before the first deploy that includes the Worker:

1. Create the queues (needs `npx wrangler login` with the IndyCenter account): `cd worker && npx wrangler queues create larry-messages && npx wrangler queues create larry-messages-dlq`
2. Add the `CLOUDFLARE_WORKERS_API_KEY` repository secret: a Cloudflare API token with **Workers Scripts:Edit** and **Queues:Edit**.
3. Add the `ENV_SEND_CHANNELS` repository variable.

To try it locally: `cd worker && npm install`, copy `.dev.vars.example` to `.dev.vars` with a test token and test channels, and run `npx wrangler dev`. A caller Worker run alongside it (`npx wrangler dev -c ../caller/wrangler.jsonc -c wrangler.jsonc`) can then use its `LARRY` binding.

## Project layout

- `src/bot.js`: logs in, polls every `POLL_SECONDS`, and posts, edits and deletes embeds.
- `src/ironmic.js`: Iron Mic positions, vNAS Stats totals and the leaderboard embed. `src/ironmicCommand.js`: the `/ironmic` command.
- `src/feed.js`: fetches the [vNAS controller feed](https://docs.virtualnas.net/data-admin/controller-feed/), the vNAS ARTCC data (facility and position list) and [VATSIM ATC bookings](https://atc-bookings.vatsim.net/), groups controllers by facility and tracks activation times.
- `src/status.js`: decides each facility's status and parses "Online until" from controller info.
- `src/embeds.js`: the embed layout.
- `src/notify.js`: the notification panels: button and menu handling, role timers and `notify.json`.
- `src/panels.js`: the panel, form and request alert layouts.
- `test/`: unit tests.
- `worker/`: the send Worker (TypeScript, its own `package.json`). `src/index.ts` is the RPC entrypoint and queue consumer, `src/send.ts` checks and sends messages, `src/channels.ts` reads `SEND_CHANNELS`, `src/client/` holds the types callers import, `scripts/check-channels.ts` is the deploy's `SEND_CHANNELS` check, and `tests/` its unit tests (`npm test` in `worker/`).
- `Dockerfile`: the image, published as `ghcr.io/indy-center/vnas-discord-bot`.
- `deploy/docker-compose.yml`: what's deployed to `/home/deploy/apps/indy-larry/` on the VPS. Keeps `state.json` in the `bot-state` volume.
- `deploy/.env.example`: every setting the bot reads, with its default. Names only, no values.
- `.github/workflows/ci.yml`: tests, compose validation and an image build, plus the Worker's typecheck, tests and bundle, on every pull request.
- `.github/workflows/build-and-deploy.yml`: runs CI, pushes the image to GHCR, then rsyncs `deploy/` to the VPS and runs `docker compose up -d` over SSH. Alongside that it deploys the Worker to Cloudflare.

## Local development

```bash
npm install
cp deploy/.env.example .env # then fill in DISCORD_TOKEN, CHANNEL_ID and ARTCC_IDS=ZID
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

`build-and-deploy.yml` runs on every push to `main`, and by hand from **Actions → Build and Deploy → Run workflow**. It calls `ci.yml` and only deploys if it passes. It builds the image and pushes it to `ghcr.io/indy-center/vnas-discord-bot`, tagged `latest` and with the commit SHA. It then rsyncs `deploy/` to `/home/deploy/apps/indy-larry/`, writes `.env` there from the `ENV_*` secrets and variables, pulls and runs `docker compose up -d`, and fails if anything is restarting 15 seconds later.

The app directory and compose project are named after the repository, so renaming the repo deploys a second copy next to the old one, with its own empty volume. Two copies with the same token repost the panels and double up status embeds. After a rename, stop the old one on the VPS: `cd ~/apps/<old name> && docker compose down`.

Secrets:

- **Deploy credentials**: the `VANDERBILT_HOST` and `VANDERBILT_DEPLOY_USER` organization variables and the `VANDERBILT_DEPLOY_SSH_KEY` and `VANDERBILT_KNOWN_HOSTS` organization secrets. An org admin adds this repository to the repository access of all four.
- **Runtime settings**: one repository secret or variable per setting in [`deploy/.env.example`](deploy/.env.example), named `ENV_<NAME>`, plus a matching line in the **Write .env** step of `.github/workflows/build-and-deploy.yml`. Either kind works (a secret wins if both exist), except `ENV_DISCORD_TOKEN`, which must be a secret. Every deploy writes the settings that are set to `/home/deploy/apps/indy-larry/.env` as `NAME='value'`, readable only by `deploy`; unset ones are left out so the defaults apply. A value can't contain a single quote or a newline; the deploy fails with the setting's name before anything reaches the VPS.

| Name | Kind | Value |
| ---- | ---- | ----- |
| `ENV_DISCORD_TOKEN` | Secret | The bot's token |
| `ENV_CHANNEL_ID` | Variable | The status channel's ID |
| `ENV_ARTCC_IDS` | Variable | `ZID` |
| `ENV_PANEL_CHANNEL_ID`, `ENV_ALERT_CHANNEL_ID` | Variable | Optional; the notification panel and request channels |
| `ENV_RELIEF_ROLES`, `ENV_CAB_ROLES`, `ENV_TRACON_ROLES`, `ENV_ENROUTE_ROLES`, `ENV_IRON_MIC_ROLE_ID` | Variable | Optional; the production server's notification roles |
| `ENV_IRON_MIC_CHANNEL_ID` | Variable | Optional; posts the Iron Mic leaderboard outside `CHANNEL_ID`, e.g. while testing |
| `ENV_POLL_SECONDS`, `ENV_SHOW_NAMES`, … | Variable | Optional; leave unset for the defaults in `deploy/.env.example` |
| `ENV_SEND_CHANNELS` | Variable | Channels other apps may send to, e.g. `events:111,training:222`; the Worker deploy reads it (the VPS bot ignores its `.env` copy) |
| `CLOUDFLARE_WORKERS_API_KEY` | Secret | Cloudflare API token for the Worker deploy (Workers Scripts:Edit, Queues:Edit) |

To change a setting, update it under **Settings → Secrets and variables → Actions**, then run **Build and Deploy**. The deploy owns `.env` and rewrites it every time, so an edit made on the VPS lasts only until the next deploy.

### First deploy

1. An org admin adds this repository to the `VANDERBILT_*` secrets.
2. Add the `ENV_*` secret and variables from the table above.
3. Stop any other copy of the bot.
4. Run **Build and Deploy**. The first run pushes the image, then fails at the pull, because new GHCR packages start private.
5. Make the package public: **Indy-Center → Packages → vnas-discord-bot → Package settings → Change visibility → Public**.
6. Run **Build and Deploy** again, then check the run's log, or on the VPS:

   ```bash
   cd /home/deploy/apps/vnas-discord-bot && docker compose ps && docker compose logs --tail 50
   ```

## Disclaimer

We are not affiliated with the FAA or any aviation governing body. This software is for flight simulation use on the [VATSIM](https://www.vatsim.net) network.
