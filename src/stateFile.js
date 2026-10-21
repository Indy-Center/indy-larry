// Saving the bot's state files (state.json, notify.json, ironmic.json) so a stop, crash or power cut
// never leaves one half-written: the new contents go to a temporary file beside it, which is then renamed
// over it. A rename is all or nothing, so the file is always either the old version or the new one.

const fs = require('fs');
const path = require('path');

/**
 * Writes `contents` to `file`. In the image, /app/<name>.json is a link to /data/<name>.json, so the
 * rename happens in /data, where the file is: renaming over the link would replace the link instead.
 */
function saveStateFile(file, contents) {
  let target = file;
  try {
    target = path.resolve(path.dirname(file), fs.readlinkSync(file));
  } catch {
    // Not a link (or not there yet): write the file itself.
  }
  const temp = path.join(path.dirname(target), `.${path.basename(target)}.tmp`);
  // flush: the contents reach the disk before the rename, so a power cut can't keep the rename but not them.
  fs.writeFileSync(temp, contents, { flush: true });
  fs.renameSync(temp, target);
}

module.exports = { saveStateFile };
