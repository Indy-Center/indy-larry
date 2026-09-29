const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRoles, parseAreas, reliefAction, expiredGrants } = require('../src/notify');
const { reliefPanel, requestPanel, ironMicPanel, requestModal, requestAlert } = require('../src/panels');

const positions = parseRoles('S Ground:1, A Ground:2, S Local:3, A Local:4, T Radar:5, E Radar:6');
const areas = parseAreas({ CAB_ROLES: 'S-GC:1,A-GC:2,S-LC:3,A-LC:4', TRACON_ROLES: 'T-RC:5', ENROUTE_ROLES: 'E-RC:6' });
const [cab, tracon] = areas;

test('parseAreas keeps the areas that have roles, in order', () => {
  assert.deepEqual(areas.map((a) => [a.label, a.roles.length]), [['CAB', 4], ['TRACON', 1], ['ENROUTE', 1]]);
  assert.deepEqual(parseAreas({ TRACON_ROLES: 'T-RC:5' }).map((a) => a.key), ['tracon']);
  assert.throws(() => parseAreas({ CAB_ROLES: 'S-GC' }), /CAB_ROLES entry "S-GC"/);
});

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
  for (const panel of [reliefPanel(positions), requestPanel(areas), ironMicPanel()]) panel.toJSON();
  // One menu per position, named after it, with the lengths plus Opt out.
  const rows = reliefPanel(positions).toJSON().components.filter((c) => c.type === 1);
  assert.deepEqual(rows.map((r) => r.components[0].placeholder), positions.map((p) => p.label));
  assert.deepEqual(rows[0].components[0].options.map((o) => o.value), ['3', '6', '9', '12', 'perm', 'off']);
  const requestRows = requestPanel(areas).toJSON().components.filter((c) => c.type === 1);
  assert.deepEqual(requestRows.map((r) => r.components[0].custom_id), ['request:area:cab', 'request:area:tracon', 'request:area:enroute']);
});

test('request forms ask who to notify only when the area has a choice', () => {
  const picker = (modal) => modal.toJSON().components.find((c) => c.component?.custom_id === 'notify')?.component;
  const cabBreak = picker(requestModal('break', cab));
  assert.deepEqual(cabBreak.options.map((o) => o.label), ['S-GC', 'A-GC', 'S-LC', 'A-LC']);
  assert.deepEqual([cabBreak.min_values, cabBreak.max_values], [1, 4]);
  assert.ok(picker(requestModal('staffing', cab)));
  assert.equal(picker(requestModal('break', tracon)), undefined);
  assert.equal(picker(requestModal('staffing', tracon)), undefined);
});

test('requestAlert pings only the picked roles', () => {
  const alert = requestAlert('staffing', cab, cab.roles.slice(0, 2), '42', { position: 'IND_TWR', reason: '' });
  assert.equal(alert.content, '<@&1> <@&2>');
  assert.deepEqual(alert.allowedMentions, { roles: ['1', '2'] });
  const embed = alert.embeds[0].toJSON();
  assert.equal(embed.title, 'Staffing requested · CAB');
  assert.equal(embed.fields.length, 2); // blank reason left out
});
