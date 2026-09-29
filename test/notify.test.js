const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRoles, reliefAction, expiredGrants } = require('../src/notify');
const { reliefPanel, requestPanel, ironMicPanel, requestModal, requestAlert } = require('../src/panels');

const positions = parseRoles('S Ground:1, A Ground:2, S Local:3, A Local:4, T Radar:5, E Radar:6');

test('parseRoles reads label:roleId pairs', () => {
  assert.deepEqual(positions[0], { label: 'S Ground', roleId: '1' });
  assert.equal(positions.length, 6);
  assert.deepEqual(parseRoles(''), []);
  assert.deepEqual(parseRoles(undefined), []);
  assert.throws(() => parseRoles('S Ground'), /S Ground/);
  assert.throws(() => parseRoles('S Ground:abc'), /S Ground:abc/);
});

test('reliefAction adds, changes and removes', () => {
  assert.equal(reliefAction(false, undefined, '3'), 'add');
  assert.equal(reliefAction(false, { duration: 'perm' }, 'perm'), 'add'); // role was taken off by hand
  // Permanent: any timed pick switches to timed, Permanent again opts out.
  assert.equal(reliefAction(true, { duration: 'perm' }, '6'), 'change');
  assert.equal(reliefAction(true, { duration: 'perm' }, 'perm'), 'remove');
  // Timed: a different length restarts the clock, the same length opts out.
  assert.equal(reliefAction(true, { duration: '3' }, '12'), 'change');
  assert.equal(reliefAction(true, { duration: '3' }, 'perm'), 'change');
  assert.equal(reliefAction(true, { duration: '3' }, '3'), 'remove');
  // A role with no record counts as permanent.
  assert.equal(reliefAction(true, undefined, 'perm'), 'remove');
  assert.equal(reliefAction(true, undefined, '9'), 'change');
  // Opt out removes the role, or does nothing if there isn't one.
  assert.equal(reliefAction(true, { duration: '6' }, 'off'), 'remove');
  assert.equal(reliefAction(false, undefined, 'off'), 'none');
});

test('expiredGrants skips permanent and future grants', () => {
  const grants = {
    a: { expiresAt: 1000 },
    b: { expiresAt: 3000 },
    c: { expiresAt: null },
  };
  assert.deepEqual(expiredGrants(grants, 2000).map(([k]) => k), ['a']);
});

test('panels and modals pass discord.js validation', () => {
  for (const panel of [reliefPanel(positions), requestPanel(positions), ironMicPanel()]) panel.toJSON();
  // One menu per position, named after it, with the lengths plus Opt out.
  const rows = reliefPanel(positions).toJSON().components.filter((c) => c.type === 1);
  assert.deepEqual(rows.map((r) => r.components[0].placeholder), positions.map((p) => p.label));
  assert.deepEqual(rows[0].components[0].options.map((o) => o.value), ['3', '6', '9', '12', 'perm', 'off']);
  const requestRows = requestPanel(positions).toJSON().components.filter((c) => c.type === 1);
  assert.deepEqual(requestRows[5].components[0].custom_id, 'request:pos:6');
  requestModal('break', positions[0]).toJSON();
  requestModal('staffing', positions[4]).toJSON();
});

test('requestAlert only pings the position role', () => {
  const alert = requestAlert('staffing', positions[4], '42', { position: 'IND_APP', area: 'TRACON sector', reason: '' });
  assert.equal(alert.content, '<@&5>');
  assert.deepEqual(alert.allowedMentions, { roles: ['5'] });
  assert.equal(alert.embeds[0].toJSON().fields.length, 3); // blank reason left out
});
