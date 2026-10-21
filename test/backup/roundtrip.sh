#!/usr/bin/env bash
# Round trip of deploy/backup.sh and deploy/restore.sh against a real bot-state volume:
# seed sample state, back up while the bot is writing, wipe the volume, restore, and check the state is back.
# Needs Docker and node. Run from anywhere: bash test/backup/roundtrip.sh
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
sample="$root/test/backup/sample"

# The scripts run from the app's folder, as the backup runner runs them. The test compose file swaps the bot
# for fake-bot.js, and the project name keeps the test's volume apart from any real one on this machine.
cd "$root/deploy"
export COMPOSE_FILE=docker-compose.yml:../test/backup/compose.test.yml
export COMPOSE_PROJECT_NAME=indy-larry-backup-test

work=$(mktemp -d)
cleanup() {
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# Waits until the bot has loaded state.json and rewritten it at least once, and prints the marker it kept.
# Read through the running container; a read that lands mid-write fails to parse and is tried again.
wait_for_writes() {
  local marker
  for _ in $(seq 1 30); do
    marker=$(docker compose exec -T bot node -e '
      try {
        const s = JSON.parse(require("fs").readFileSync("/app/state.json", "utf8"));
        if (typeof s.seq === "number") process.stdout.write(s.marker);
      } catch {}' 2>/dev/null || true)
    if [ -n "$marker" ]; then
      echo "$marker"
      return
    fi
    sleep 1
  done
  fail "the bot never wrote state.json"
}

# Copies the volume's files into a folder, with the bot stopped so nothing changes under the copy.
copy_volume() {
  docker compose stop bot >/dev/null 2>&1
  mkdir "$1"
  docker compose run --rm --no-deps -T --entrypoint tar bot -C /data -cf - . | tar -C "$1" -xf -
  docker compose start bot >/dev/null 2>&1
}

# Checks a folder holds the three sample files: state.json with the sample's fields (the fake bot adds seq
# and padding), notify.json and ironmic.json unchanged.
check_state() {
  node -e '
    const fs = require("fs");
    const [dir, sample] = process.argv.slice(1);
    const got = JSON.parse(fs.readFileSync(dir + "/state.json", "utf8"));
    delete got.seq; delete got.padding;
    const want = JSON.parse(fs.readFileSync(sample + "/state.json", "utf8"));
    if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error("state.json is " + JSON.stringify(got).slice(0, 200));
  ' "$1" "$sample" || fail "$2: state.json does not match the sample"
  cmp -s "$1/notify.json" "$sample/notify.json" || fail "$2: notify.json does not match the sample"
  cmp -s "$1/ironmic.json" "$sample/ironmic.json" || fail "$2: ironmic.json does not match the sample"
}

echo "--- build the image"
docker build -q -t vnas-discord-bot:backup-test "$root" >/dev/null

echo "--- seed the volume with the sample state and start the bot"
docker compose down -v --remove-orphans >/dev/null 2>&1 || true
tar -C "$sample" -cf - . | docker compose run --rm --no-deps -T --entrypoint tar bot -C /data -xf -
docker compose up -d --quiet-pull bot
[ "$(wait_for_writes)" = sample-state ] || fail "the bot did not load the sample state"

echo "--- back up while the bot rewrites state.json, five times"
for i in 1 2 3 4 5; do
  out="$work/out$i"
  mkdir "$out"
  bash backup.sh "$out" 2>"$work/backup$i.log" || { cat "$work/backup$i.log" >&2; fail "backup.sh exited non-zero"; }
  files=("$out"/*)
  [ "${#files[@]}" -eq 1 ] && [ -f "${files[0]}" ] || fail "backup.sh must write exactly one file, wrote: $(ls -A "$out")"
  mkdir "$work/got$i"
  tar -C "$work/got$i" -xzf "${files[0]}" || fail "backup $i is not a gzipped tar"
  check_state "$work/got$i" "backup $i"
done
archive="$work/out1/$(ls "$work/out1")"
echo "ok: five backups, each a whole copy of the state ($(cat "$work"/backup*.log | grep -c "trying again" || true) copies caught mid-write and taken again)"

echo "--- wipe the volume"
docker compose down -v >/dev/null 2>&1
docker compose up -d --quiet-pull bot
[ "$(wait_for_writes)" = fresh ] || fail "the volume was not wiped"

echo "--- a bad archive is refused, and the bot and its state are left alone"
echo "not an archive" >"$work/bad.tar.gz"
if bash restore.sh "$work/bad.tar.gz"; then fail "restore.sh accepted a bad archive"; fi
[ "$(docker compose ps -q --status running bot)" ] || fail "restore.sh stopped the bot for a bad archive"
copy_volume "$work/after-bad"
[ ! -e "$work/after-bad/notify.json" ] || fail "restore.sh changed the volume for a bad archive"
echo "ok"

echo "--- restore"
bash restore.sh "$archive" || fail "restore.sh exited non-zero"
[ "$(docker compose ps -q --status running bot)" ] || fail "the bot is not running after restore"
# The bot reads state.json only at start, so seeing the sample's marker here means it was stopped while the
# volume was replaced and started again after: had it kept running, it would have rewritten its fresh state.
[ "$(wait_for_writes)" = sample-state ] || fail "the bot did not start with the restored state"
copy_volume "$work/restored"
check_state "$work/restored" "after restore"
echo "ok: the bot is running with the backed-up state"

echo "PASS"
