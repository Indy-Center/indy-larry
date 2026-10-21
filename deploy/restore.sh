# indy-larry's restore, the reverse of backup.sh (see docker-infrastructure's README, "What an app ships").
# Called as `bash restore.sh <file>` from ~/apps/indy-larry/, with a decrypted indy-larry-state.tar.gz.
# It stops the bot, replaces everything in the bot-state volume with the archive's files, and starts the bot.
set -euo pipefail

archive=${1:?usage: bash restore.sh <indy-larry-state.tar.gz>}
[ -f "$archive" ] || { echo "No such file: $archive" >&2; exit 1; }

# Unpacks the archive (read from stdin) into /tmp/new and checks every JSON file in it parses, so a damaged
# backup is refused before anything is changed. Runs in a throwaway container of the bot's image (for node).
unpack='
set -eu
mkdir /tmp/new
tar -C /tmp/new -xzf -
for f in /tmp/new/*.json; do
  [ -e "$f" ] || continue
  node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1], \"utf8\"))" "$f" ||
    { echo "${f#/tmp/new/} in the archive is not whole JSON" >&2; exit 1; }
done
'

# `docker compose run` uses this folder's compose file, so it gets the bot's image and volume.
# --no-deps leaves other services alone, -T passes the archive in untouched, --rm removes the container after.
run() {
  docker compose run --rm --no-deps -T --entrypoint sh bot -c "$1" <"$archive"
}

# 1. Check the archive while the bot keeps running.
echo "Checking $archive"
run "$unpack"

# 2. Stop the bot. It only reads its files when it starts, and rewrites them from memory while running, so a
# running bot would overwrite the restored files. From here on, the bot is started again however this ends.
echo "Stopping the bot"
docker compose stop bot
trap 'echo "Starting the bot"; docker compose up -d bot' EXIT

# 3. Unpack and check again, then empty the volume and copy the archive's files in. They are written as the
# image's user (node), as the bot writes them.
echo "Replacing the bot-state volume's files"
run "$unpack
find /data -mindepth 1 -delete
cp -a /tmp/new/. /data/
"

echo "Restored $archive"
