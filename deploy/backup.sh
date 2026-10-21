# indy-larry's backup recipe (see docker-infrastructure's README, "What an app ships").
# The backup runner calls it as `bash backup.sh <empty folder>` from ~/apps/indy-larry/, and it writes one file
# there: indy-larry-state.tar.gz, everything in the bot-state volume (state.json, notify.json, ironmic.json).
#
# The bot stays up. It saves each file with fs.writeFileSync, which empties the file and then writes it again
# in place, so a copy taken at the wrong moment holds an empty or half-written file. Each JSON file is copied,
# then parsed; one that doesn't parse was caught mid-write and is copied again.
set -euo pipefail

out=${1:?usage: bash backup.sh <empty output folder>}

# Runs inside a throwaway container of the bot's own image (it has node to parse the JSON), with the bot's
# volume at /data. It prints the archive to stdout.
copy='
set -eu

# Copies one file and checks the copy is whole JSON, trying again up to 10 times.
copy_json() {
  for try in 1 2 3 4 5 6 7 8 9 10; do
    if cp "/data/$1" "/tmp/copy/$1" &&
      node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\"))" "/tmp/copy/$1" 2>/dev/null; then
      return 0
    fi
    echo "$1 was being written, trying again" >&2
    sleep 1
  done
  echo "$1 never read as whole JSON" >&2
  exit 1
}

mkdir /tmp/copy
cd /data
for name in * .[!.]*; do
  [ -e "$name" ] || continue # the pattern matched nothing
  case "$name" in
    .restore-new | .restore-old) ;; # left by a restore.sh that did not finish, not state of the bot
    *.json) copy_json "$name" ;;
    *) cp -a "$name" /tmp/copy/ ;; # anything else the bot keeps, copied as it is
  esac
done

# The archive goes to stdout, so the file on the host is written by the user running this script.
tar -C /tmp/copy -czf - .
'

# `docker compose run` starts the container from this folder's compose file, so it gets the right image and
# the right volume (named after the folder: indy-larry_bot-state on the VPS). --no-deps leaves the running bot
# alone, -T passes the archive through untouched, and --rm removes the container afterwards.
# The archive is written under a temporary name, readable only by its owner, and renamed once complete, so a
# failed or stopped backup never leaves a partial archive where the runner would take it for a backup.
partial="$out/.indy-larry-state.tar.gz.partial"
trap 'rm -f "$partial"' EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
umask 077
docker compose run --rm --no-deps -T --entrypoint sh bot -c "$copy" >"$partial"
mv "$partial" "$out/indy-larry-state.tar.gz"
