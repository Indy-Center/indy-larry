// Stands in for the bot in the backup round-trip test (it needs no Discord token).
// Like the real bot, it reads state.json once at start and then keeps rewriting the whole file in place
// (opening it empties it), through the same /app/state.json link into the volume.
// The real bot's write is quick, so it rarely leaves a half-written file for long. This one writes the file in
// two halves with 30 ms between them, every 100 ms, so about one copy in three lands mid-write and a backup
// has to notice and copy again.
const fs = require('fs');

const STATE_FILE = '/app/state.json';

// What it loaded at start. A missing or unreadable file starts it fresh, as the real bot does.
let loaded = { marker: 'fresh' };
try {
  loaded = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
} catch {}
delete loaded.seq;
delete loaded.padding;

const padding = 'x'.repeat(64 * 1024);
let seq = 0;

// Exit on a stop signal only between writes, so the test's checks with the stand-in stopped find whole files.
// Node runs this handler once the current write has finished.
process.on('SIGTERM', () => process.exit(0));

function write() {
  const text = JSON.stringify({ ...loaded, seq: seq++, padding }, null, 2);
  const half = Math.floor(text.length / 2);
  const fd = fs.openSync(STATE_FILE, 'w'); // empties the file, as fs.writeFileSync does
  fs.writeSync(fd, text.slice(0, half));
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30); // pause mid-write
  fs.writeSync(fd, text.slice(half));
  fs.closeSync(fd);
  setTimeout(write, 70);
}
write();
