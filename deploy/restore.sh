#!/usr/bin/env bash
# indy-larry's restore, the reverse of backup.sh (see docker-infrastructure's README, "What an app ships").
# Called as `bash restore.sh <file>` from ~/apps/indy-larry/, with a decrypted indy-larry-state.tar.gz.
# It stops the bot, replaces everything in the bot-state volume with the archive's files, and starts the bot.
set -euo pipefail

archive=${1:?usage: bash restore.sh <indy-larry-state.tar.gz>}
[ -f "$archive" ] || { echo "No such file: $archive" >&2; exit 1; }
# Made absolute before the cd below, so a file given relative to where it was called still works.
archive="$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")"

# Compose finds docker-compose.yml, and the bot's volume, from this script's folder.
cd "$(dirname "$0")"

# Shell for the throwaway containers below. unpack_to unpacks the archive (read from stdin) into a folder and
# checks every JSON file in it parses, so a damaged backup is refused before anything is changed.
unpack_to='
set -eu
# Each step returns on failure itself, as set -e does not apply inside a function called with ||.
unpack_to() {
  mkdir "$1" || return 1
  tar -C "$1" -xzf - || return 1
  for f in "$1"/*.json; do
    [ -e "$f" ] || continue
    node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\"))" "$f" ||
      { echo "${f##*/} in the archive is not whole JSON" >&2; return 1; }
  done
}
'

# Swaps the archive's files into the volume (/data). Everything is first unpacked inside the volume, then put
# in place by renames, which copy nothing, so they can't run out of space or stop half-way through a file.
# If any step fails, the files from before the restore are put back.
swap='
cd /data
new=.restore-new # the archive, unpacked and checked
old=.restore-old # the files from before the restore, kept until the new ones are in

# Left by a restore that was killed part-way. .restore-old may hold the only copy of the old files.
if [ -e "$new" ] || [ -e "$old" ]; then
  echo "/data/$new or /data/$old is left from a restore that did not finish. Check them by hand first." >&2
  exit 1
fi

unpack_to "$new" || { rm -rf "$new"; exit 1; }

# Runs however this script ends. Unless the swap finished, it puts the old files back. Files in /data are
# removed first only once files from the archive have started moving in; before that they are old files not yet
# moved aside.
phase=aside # aside: moving old files out; in: moving new files in; done: finished
undo() {
  set +e
  if [ "$phase" != done ]; then
    echo "The restore failed; putting the old files back" >&2
    if [ "$phase" = in ]; then
      for name in * .[!.]*; do
        [ -e "$name" ] || continue
        case "$name" in "$new" | "$old") continue ;; esac
        rm -rf "$name"
      done
    fi
    for name in "$old"/* "$old"/.[!.]*; do
      [ -e "$name" ] || continue
      mv "$name" . || echo "Could not put $name back; it is still in /data/$old" >&2
    done
    rm -rf "$new"
    rmdir "$old" # only once it is empty, so nothing that could not be put back is lost
  else
    rm -rf "$new" "$old"
  fi
}
trap undo EXIT

# Move the live files aside, then move the files from the archive in.
# (A pattern that matches nothing stays as itself, so each loop skips names that do not exist.)
mkdir "$old"
for name in * .[!.]*; do
  [ -e "$name" ] || continue
  case "$name" in "$new" | "$old") continue ;; esac
  mv "$name" "$old"/
done
phase=in
for name in "$new"/* "$new"/.[!.]*; do
  [ -e "$name" ] || continue
  mv "$name" .
done
phase=done
'

# `docker compose run` uses this folder's compose file, so it gets the bot's image and volume, and runs as the
# image's user (node), who owns the bot's files. --no-deps leaves other services alone, -T passes the archive in
# untouched, and --rm removes the container after.
run() {
  docker compose run --rm --no-deps -T --entrypoint sh bot -c "$unpack_to$1" <"$archive"
}

# 1. Check the archive while the bot keeps running.
echo "Checking $archive"
run 'unpack_to /tmp/new'

# 2. Stop the bot. It only reads its files when it starts, and rewrites them from memory while running, so a
# running bot would overwrite the restored files. From here on, the bot is started again however this ends.
echo "Stopping the bot"
docker compose stop bot
trap 'echo "Starting the bot"; docker compose up -d bot' EXIT

# 3. Swap the archive's files into the volume.
echo "Replacing the bot-state volume's files"
run "$swap"

echo "Restored $archive"
