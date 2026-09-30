const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRoles, parseAreas, reliefAction, expiredGrants, isPanelMessage } = require('../src/notify');
const { reliefPanel, hoursModal, parseHours, requestPanel, ironMicPanel, requestModal, requestAlert, alertStatus } = require('../src/panels');

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
  assert.equal(reliefAction(false, undefined, 'temp'), 'add');
  assert.equal(reliefAction(false, { duration: 'perm' }, 'perm'), 'add'); // role was taken off by hand
  // Permanent: Temporary switches to timed, Permanent again opts out.
  assert.equal(reliefAction(true, { duration: 'perm' }, 'temp'), 'change');
  assert.equal(reliefAction(true, { duration: 'perm' }, 'perm'), 'remove');
  // Temporary: Temporary again sets a new time, Permanent switches to it.
  assert.equal(reliefAction(true, { duration: 'temp' }, 'temp'), 'change');
  assert.equal(reliefAction(true, { duration: 'temp' }, 'perm'), 'change');
  assert.equal(reliefAction(true, { duration: '3' }, 'perm'), 'change'); // saved before custom hours
  // A role with no record counts as permanent.
  assert.equal(reliefAction(true, undefined, 'perm'), 'remove');
  assert.equal(reliefAction(true, undefined, 'temp'), 'change');
  // Opt out removes the role, or does nothing if there isn't one.
  assert.equal(reliefAction(true, { duration: 'temp' }, 'off'), 'remove');
  assert.equal(reliefAction(false, undefined, 'off'), 'none');
});

test('parseHours takes whole hours from 1 to 24', () => {
  assert.equal(parseHours('1'), 1);
  assert.equal(parseHours(' 24 '), 24);
  assert.equal(parseHours('08'), 8);
  for (const bad of ['0', '25', '-1', '1.5', '4h', '', 'abc']) assert.equal(parseHours(bad), null, bad);
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
  // One menu per position, named after it, with Temporary, Permanent and Opt out.
  const rows = reliefPanel(positions).toJSON().components.filter((c) => c.type === 1);
  assert.deepEqual(rows.map((r) => r.components[0].placeholder), positions.map((p) => p.label));
  assert.deepEqual(rows[0].components[0].options.map((o) => o.value), ['temp', 'perm', 'off']);
  const hours = hoursModal(positions[0]).toJSON();
  assert.equal(hours.custom_id, 'relief:hours:1');
  assert.equal(hours.components[0].component.custom_id, 'hours');
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

const record = (over = {}) => ({
  channelId: '9',
  type: 'staffing',
  area: 'CAB',
  userId: '42',
  fields: { position: 'IND_TWR', reason: '' },
  roleIds: ['1', '2'],
  createdAt: 1_000_000,
  expiresAt: 4_600_000,
  status: 'open',
  claimedBy: null,
  ...over,
});
const buttons = (msg) => msg.components.flatMap((row) => row.toJSON().components.map((c) => [c.custom_id, c.label]));

test('requestAlert pings only the picked roles', () => {
  const alert = requestAlert(record());
  assert.equal(alert.content, '<@&1> <@&2>');
  assert.deepEqual(alert.allowedMentions, { roles: ['1', '2'] });
  const embed = alert.embeds[0].toJSON();
  assert.equal(embed.title, 'Staffing requested · CAB');
  assert.equal(embed.fields.length, 2); // blank reason left out
});

test('an open alert has Claim and Cancel and says when it expires', () => {
  const alert = requestAlert(record());
  assert.deepEqual(buttons(alert), [['alert:claim', 'Claim'], ['alert:cancel', 'Cancel']]);
  assert.match(alert.embeds[0].toJSON().description, /<t:4600:R>/);
  assert.equal(requestAlert(record({ expiresAt: null })).embeds[0].toJSON().description, undefined);
});

test('a claimed alert is green, names the claimer and offers Unclaim', () => {
  const alert = requestAlert(record({ status: 'claimed', claimedBy: '7' }));
  const embed = alert.embeds[0].toJSON();
  assert.equal(embed.color, 0x2ecc71);
  assert.equal(embed.title, '✅ Claimed · Staffing requested · CAB');
  assert.deepEqual(embed.fields.at(-1), { name: 'Claimed by', value: '<@7>' });
  assert.deepEqual(buttons(alert), [['alert:claim', 'Unclaim'], ['alert:cancel', 'Cancel']]);
  assert.deepEqual(requestAlert(record({ status: 'claimed', claimedBy: '7' }), { final: true }).components, []);
});

test('cancelled and expired alerts are grey with no buttons', () => {
  for (const [status, word] of [['cancelled', 'Cancelled'], ['expired', 'Expired']]) {
    const alert = requestAlert(record({ status, type: 'break', fields: { position: 'IND_GND', stay: '30m' } }));
    const embed = alert.embeds[0].toJSON();
    assert.equal(embed.color, 0x95a5a6);
    assert.equal(embed.title, `${word} · Break requested · CAB`);
    assert.deepEqual(alert.components, []);
    assert.equal(alert.content, '<@&1> <@&2>');
  }
});

test('alertStatus expires only open alerts past their time', () => {
  assert.equal(alertStatus(record(), 4_599_999), 'open');
  assert.equal(alertStatus(record(), 4_600_000), 'expired');
  assert.equal(alertStatus(record({ status: 'claimed', claimedBy: '7' }), 9_000_000), 'claimed');
  assert.equal(alertStatus(record({ expiresAt: null }), 9_000_000), 'open');
});

test('isPanelMessage matches the panels but not request alerts', () => {
  const json = (components) => components.map((c) => c.toJSON());
  for (const panel of [reliefPanel(positions), requestPanel(areas), ironMicPanel()]) assert.ok(isPanelMessage(json([panel])));
  assert.equal(isPanelMessage(json(requestAlert(record()).components)), false);
  assert.equal(isPanelMessage([]), false);
});
