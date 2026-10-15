// -----------------------------------------------------------------------------
// The probe script (scripts/probe.mjs) against the fake OpenWrt: it reads
// only, and its report carries no address, MAC, name, SSID, key nor password.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe } from '../scripts/probe.mjs';
import { FakeOpenwrt, READ_ACL, WRITE_ACL, createNetwork } from './helpers/fakeOpenwrt.js';

const users = {
  gladys: {
    password: 'secret',
    acl: [...READ_ACL, ...WRITE_ACL],
    uciRead: ['wireless'],
    uciWrite: ['wireless'],
  },
};
const run = (device, extra) => {
  const network = createNetwork({ '192.0.2.1': device });
  return probe({ host: '192.0.2.1', request: network.request, ...extra });
};

test('without credentials: ubus and LuCI RPC refuse an invented account', async () => {
  const device = new FakeOpenwrt({ users, luci: true });
  const lines = await run(device, {});
  assert.match(lines.join('\n'), /ubus: auth/);
  assert.match(lines.join('\n'), /LuCI RPC: auth/);
  assert.equal(device.logins.ok, 0);
});

test('with credentials: reads only, and nothing private in the report', async () => {
  const device = new FakeOpenwrt({ users });
  const lines = await run(device, { username: 'gladys', password: 'secret' });
  const text = lines.join('\n');
  assert.match(text, /Interface: ubus/);
  assert.match(text, /OpenWrt 23\.05\.5 \(r24106-10cc5fcd00\)/);
  assert.match(text, /Stations: 5 \(4 authorized\), readers: hostapd/);
  assert.ok(device.calls.every((call) => !['set', 'commit', 'reboot'].includes(call.method)));
  for (const secret of [
    'secret',
    '192.0.2',
    '203.0.113',
    '00:00:5',
    'Pixel',
    'Home-Network',
    'Home-Guests',
    'not-a-real-wifi-key',
    ...device.sessions.keys(),
  ]) {
    assert.ok(!text.includes(secret), `"${secret}" in the report`);
  }
});

test('the LuCI RPC fallback is probed too', async () => {
  const device = new FakeOpenwrt({ fixture: 'luci-rpc-18.06', users });
  const text = (await run(device, { username: 'gladys', password: 'secret' })).join('\n');
  assert.match(text, /Interface: LuCI RPC/);
  assert.match(text, /Neighbours: 2 \(1 reachable\); static hosts: 1/);
  assert.ok(!text.includes('laptop-sam') && !text.includes('192.0.2'));
});
