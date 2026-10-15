// -----------------------------------------------------------------------------
// The dashboard widgets (src/widgets.js): every content passes the SDK
// validator (vocabulary and budget of the core) in every language and state,
// the buttons exist only when the commands are allowed, and their actions do
// what they say. (Adapted from guim31/gladys-mikrotik.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateWidgetContent } from '@gladysassistant/integration-sdk';
import { shortDuration } from '../src/widgets.js';
import {
  FakeOpenwrt,
  baseConfig,
  createAll,
  createWorld,
  later,
  readOnlyUser,
} from './helpers/world.js';

const LANGS = ['en', 'fr', 'de', 'es'];

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

async function content(w, key, { settings = {}, language = 'en' } = {}) {
  const ack = await w.fake.widgetGet(key, { settings, language, units: 'metric' });
  assert.equal(ack.success, true, ack.error);
  const result = ack.data.content;
  assert.deepEqual(validateWidgetContent(result), [], `${key} (${language}) is valid`);
  return result;
}

const types = (result) => result.components.map((component) => component.type);

test('router: health tiles, links, radios, uptime, version; no button by default', async (t) => {
  const w = await world(t, { config: baseConfig({ guest_wifi: 'guest' }) });
  w.router.traffic('wan', 75_000_000, 7_500_000);
  await later(w, 1);
  for (const language of LANGS) {
    const result = await content(w, 'router', { language });
    assert.deepEqual(types(result), ['value', 'value', 'value', 'value', 'value', 'status']);
    assert.equal(result.ttl_seconds, 30);
  }
  const result = await content(w, 'router');
  assert.deepEqual(
    result.components.slice(0, 5).map((c) => c.value),
    ['0.42', 45, '10.0', '1.0', 4],
  );
  assert.deepEqual(
    result.components[5].items.map((item) => [item.label, item.value]),
    [
      ['WAN wan', 'Up'],
      ['Wi-Fi 2.4 GHz', '2 clients'],
      ['Wi-Fi 5 GHz', '2 clients'],
      ['Guest Wi-Fi · Home-Guests', 'Enabled'],
      ['Uptime', '4 d 18 h'],
      ['OpenWrt', '23.05.5'],
    ],
  );
});

test('router: the guest Wi-Fi and reboot buttons ask for a confirmation and act', async (t) => {
  const w = await world(t, { config: baseConfig({ guest_wifi: 'guest', allow_commands: true }) });
  const result = await content(w, 'router');
  const buttons = result.components.filter((c) => c.type === 'button');
  assert.deepEqual(
    buttons.map((b) => [b.label, b.icon, b.style, b.action]),
    [
      [
        'Guest Wi-Fi',
        'check-circle',
        'secondary',
        { key: 'guest_wifi', params: { enabled: false }, confirm: true },
      ],
      ['Reboot', 'refresh-cw', 'danger', { key: 'reboot', confirm: true }],
    ],
  );
  const off = await w.fake.widgetAction('router', 'guest_wifi', { enabled: false }, {});
  assert.equal(off.success, true, off.error);
  assert.equal(off.data.message.fr, 'Wi-Fi invité désactivé.');
  assert.equal(w.router.uci.wireless.guest.disabled, '1');
  const after = await content(w, 'router');
  const guest = after.components.find((c) => c.type === 'button' && c.action.key === 'guest_wifi');
  assert.deepEqual([guest.icon, guest.action.params], ['circle', { enabled: true }]);
  const reboot = await w.fake.widgetAction('router', 'reboot', {}, {});
  assert.equal(reboot.success, true, reboot.error);
  assert.equal(w.router.rebooted, true);
  const unknown = await w.fake.widgetAction('router', 'factory_reset', {}, {});
  assert.equal(unknown.success, false);
});

test('router: no guest button when no guest Wi-Fi is chosen', async (t) => {
  const w = await world(t, { config: baseConfig({ allow_commands: true }) });
  const result = await content(w, 'router');
  assert.deepEqual(
    result.components.filter((c) => c.type === 'button').map((b) => b.action.key),
    ['reboot'],
  );
});

test('router: waiting, no address, unreachable, the LuCI fallback', async (t) => {
  const none = await world(t, { config: { language: 'en' } });
  assert.match((await content(none, 'router')).components[0].text, /Enter the address/);
  const w = await world(t);
  w.router.goOffline();
  await later(w, 1);
  for (const language of LANGS) {
    const result = await content(w, 'router', { language });
    assert.deepEqual(types(result), ['text', 'status']);
  }
  const luci = await world(t, {
    device: new FakeOpenwrt({ fixture: 'luci-rpc-18.06', users: readOnlyUser() }),
  });
  const result = await content(luci, 'router');
  assert.deepEqual(types(result), ['status']);
  assert.deepEqual(
    result.components[0].items.map((i) => i.label),
    ['Uptime'],
  );
});

test('presence: present first, away with the time since, the filter', async (t) => {
  const w = await world(t, { config: baseConfig({ away_delay: 0 }) });
  assert.match((await content(w, 'presence')).components[0].text, /No device followed/);
  await createAll(w, (device) => device.external_id.includes(':client:'));
  w.router.dissociate('00:00:5E:00:53:22');
  await later(w, 90);
  const result = await content(w, 'presence', { language: 'fr' });
  assert.deepEqual(types(result), ['value', 'status']);
  assert.equal(result.components[0].value, 3);
  const rows = result.components[1].items.map((item) => [item.label, item.value]);
  assert.ok(rows.some(([label, value]) => label === 'iPhone' && value === 'Absent · 1 h'));
  assert.equal(rows[0][1], 'Présent');
  const present = await content(w, 'presence', { settings: { show: 'present' } });
  assert.equal(present.components[1].items.length, 3);
  for (const language of LANGS) {
    await content(w, 'presence', { language });
  }
});

test('presence: the router unreachable is said, nobody is sent away', async (t) => {
  const w = await world(t);
  await createAll(w, (device) => device.external_id.includes(':client:'));
  w.router.goOffline();
  await later(w, 30);
  const result = await content(w, 'presence');
  assert.deepEqual(types(result), ['value', 'text', 'status']);
  assert.match(result.components[1].text, /^Unreachable/);
});

test('short durations', () => {
  assert.equal(shortDuration(59, 'en'), '0 min');
  assert.equal(shortDuration(3600 * 5, 'fr'), '5 h');
  assert.equal(shortDuration(3600 * 49, 'fr'), '2 j 1 h');
  assert.equal(shortDuration(3600 * 48, 'de'), '2 T');
});
