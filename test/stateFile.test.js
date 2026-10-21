const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { saveStateFile } = require('../src/stateFile');

/** A fresh folder laid out like the image: /app/<name> links to /data/<name>. */
function layout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'state-file-'));
  const app = path.join(root, 'app');
  const data = path.join(root, 'data');
  fs.mkdirSync(app);
  fs.mkdirSync(data);
  fs.symlinkSync(path.join(data, 'state.json'), path.join(app, 'state.json'));
  return { link: path.join(app, 'state.json'), target: path.join(data, 'state.json'), data };
}

test('saveStateFile writes through the link into the data folder, keeping the link', () => {
  const { link, target } = layout();
  saveStateFile(link, '{"a":1}');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  saveStateFile(link, '{"a":2}');
  assert.equal(fs.readFileSync(link, 'utf8'), '{"a":2}');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
});

test('saveStateFile leaves no temporary file behind', () => {
  const { link, data } = layout();
  saveStateFile(link, '{}');
  assert.deepEqual(fs.readdirSync(data), ['state.json']);
});

test('saveStateFile that fails part-way leaves the earlier file whole', () => {
  const { link, target, data } = layout();
  saveStateFile(link, '{"a":1}');
  // A folder where the temporary file goes makes the write fail before the file is replaced.
  fs.mkdirSync(path.join(data, '.state.json.tmp'));
  assert.throws(() => saveStateFile(link, '{"a":2}'));
  assert.equal(fs.readFileSync(target, 'utf8'), '{"a":1}');
});

test('saveStateFile writes a plain file where there is no link', () => {
  const { data } = layout();
  const file = path.join(data, 'plain.json');
  saveStateFile(file, '{}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{}');
});
