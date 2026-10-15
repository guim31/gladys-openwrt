// -----------------------------------------------------------------------------
// The two OpenWrt clients (ubus over HTTP, LuCI RPC) and the session opener,
// against the fake OpenWrt: login, error kinds, the renewal of an expired
// session, the ACL refusals remembered, the fallback from /ubus to LuCI RPC,
// HTTPS and its redirection.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LuciRpcClient } from '../src/openwrt/luci.js';
import { UbusClient } from '../src/openwrt/ubus.js';
import { openSession } from '../src/openwrt/client.js';
import { ERROR_KINDS } from '../src/openwrt/errors.js';
import { FakeOpenwrt, READ_ACL, createNetwork } from './helpers/fakeOpenwrt.js';

const HOST = '192.0.2.1';
const users = (acl = READ_ACL) => ({ gladys: { password: 'secret', acl, uciRead: ['wireless'] } });

function setup(options = {}) {
  const device = new FakeOpenwrt({ users: users(options.acl), ...options });
  const network = createNetwork({ [HOST]: device });
  return { device, request: network.request };
}

const ubus = (request, extra = {}) =>
  new UbusClient({
    baseUrl: `http://${HOST}`,
    username: 'gladys',
    password: 'secret',
    request,
    ...extra,
  });

const kindOf = async (promise) => {
  try {
    await promise;
  } catch (err) {
    return err.kind;
  }
  return 'resolved';
};

test('ubus: login, then calls with the session token', async () => {
  const { device, request } = setup();
  const client = ubus(request);
  await client.open();
  assert.equal(device.logins.ok, 1);
  const board = await client.call('system', 'board');
  assert.equal(board.release.version, '23.05.5');
  assert.deepEqual(device.calls.at(-1), { object: 'system', method: 'board', args: {} });
});

test('ubus: a refused password, an unknown object, a refused object, a missing method', async () => {
  const { request } = setup({ acl: ['system board', 'system info'] });
  assert.equal(await kindOf(ubus(request, { password: 'wrong' }).open()), ERROR_KINDS.AUTH);
  const client = ubus(request);
  assert.equal(await kindOf(client.call('hostapd.phy9-ap0', 'get_clients')), ERROR_KINDS.NOT_FOUND);
  assert.equal(await kindOf(client.call('network.wireless', 'status')), ERROR_KINDS.PERMISSION);
  assert.equal(await kindOf(client.call('system', 'info')), 'resolved');
});

test('ubus: an expired session is renewed once, transparently', async () => {
  const { device, request } = setup();
  const client = ubus(request);
  await client.call('system', 'info');
  device.expireSessions();
  await client.call('system', 'info');
  assert.equal(device.logins.ok, 2);
});

test('ubus: an object refused by the ACL is not worth a new login at every call', async () => {
  const { device, request } = setup({ acl: ['system board', 'system info'] });
  const client = ubus(request);
  await client.open();
  for (let i = 0; i < 3; i += 1) {
    assert.equal(await kindOf(client.call('network.wireless', 'status')), ERROR_KINDS.PERMISSION);
    assert.equal(await kindOf(client.call('network.device', 'status')), ERROR_KINDS.PERMISSION);
  }
  // The first refusal of each object tries a fresh session, once.
  assert.equal(device.logins.ok, 3);
});

test('ubus: no /ubus, not JSON, unreachable, certificate', async () => {
  const noUbus = setup({ ubus: false });
  assert.equal(await kindOf(ubus(noUbus.request).open()), ERROR_KINDS.NOT_OPENWRT);
  const html = async () => ({ status: 200, headers: {}, body: '<html>router login</html>' });
  assert.equal(await kindOf(ubus(html).open()), ERROR_KINDS.NOT_OPENWRT);
  const { device, request } = setup();
  device.goOffline();
  assert.equal(await kindOf(ubus(request).open()), ERROR_KINDS.UNREACHABLE);
  const tls = setup({ https: true, http: false });
  const secure = { baseUrl: `https://${HOST}` };
  assert.equal(await kindOf(ubus(tls.request, secure).open()), ERROR_KINDS.TLS);
  assert.equal(await kindOf(ubus(tls.request, { ...secure, insecure: true }).open()), 'resolved');
});

test('ubus: the uci options are read one by one, never the key', async () => {
  const { device, request } = setup();
  const client = ubus(request);
  const value = await client.call('uci', 'get', {
    config: 'wireless',
    section: 'guest',
    option: 'ssid',
  });
  assert.deepEqual(value, { value: 'Home-Guests' });
  assert.equal(
    await kindOf(
      client.call('uci', 'get', { config: 'wireless', section: 'nope', option: 'device' }),
    ),
    ERROR_KINDS.NOT_FOUND,
  );
  assert.ok(device.calls.every((call) => call.args.option !== 'key'));
});

test('LuCI RPC: login, calls with the token, renewal, refusal', async () => {
  const { device, request } = setup({ fixture: 'luci-rpc-18.06' });
  const client = new LuciRpcClient({
    baseUrl: `http://${HOST}`,
    username: 'gladys',
    password: 'secret',
    request,
  });
  assert.equal(await client.call('sys', 'hostname'), 'attic-ap');
  device.expireSessions();
  assert.equal(await client.call('sys', 'uptime'), 86500);
  assert.equal(device.logins.ok, 2);
  assert.equal(await kindOf(client.call('sys', 'nothing')), ERROR_KINDS.NOT_FOUND);
  const wrong = new LuciRpcClient({
    baseUrl: `http://${HOST}`,
    username: 'gladys',
    password: 'nope',
    request,
  });
  assert.equal(await kindOf(wrong.open()), ERROR_KINDS.AUTH);
});

const session = (request, extra = {}) =>
  openSession({
    api: 'auto',
    host: HOST,
    username: 'gladys',
    password: 'secret',
    request,
    ...extra,
  });

test('auto: ubus first, LuCI RPC only when /ubus does not exist', async () => {
  const both = setup({ luci: true });
  assert.equal((await session(both.request)).backend.kind, 'ubus');
  const luciOnly = setup({ fixture: 'luci-rpc-18.06' });
  const opened = await session(luciOnly.request);
  assert.equal(opened.backend.kind, 'luci');
  assert.deepEqual(
    opened.attempts.map((attempt) => [attempt.kind, attempt.error?.kind ?? null]),
    [
      ['ubus', ERROR_KINDS.NOT_OPENWRT],
      ['luci', null],
    ],
  );
  // A refused password on /ubus is not tried again on LuCI RPC.
  const wrong = setup({ luci: true });
  const err = await session(wrong.request, { password: 'nope' }).catch((error) => error);
  assert.equal(err.kind, ERROR_KINDS.AUTH);
  assert.equal(err.attempts.length, 1);
  // Nothing at all: the error of ubus, which says what to install.
  const nothing = setup({ ubus: false, luci: false });
  assert.equal(await kindOf(session(nothing.request)), ERROR_KINDS.NOT_OPENWRT);
});

test('a forced interface is the only one tried', async () => {
  const luciOnly = setup({ fixture: 'luci-rpc-18.06' });
  assert.equal(await kindOf(session(luciOnly.request, { api: 'ubus' })), ERROR_KINDS.NOT_OPENWRT);
  const both = setup({ luci: true });
  assert.equal((await session(both.request, { api: 'luci_rpc' })).backend.kind, 'luci');
});

test('plain HTTP redirected to HTTPS switches to HTTPS', async () => {
  const { device, request } = setup({ https: true, redirectHttps: true });
  const refused = await session(request).catch((error) => error);
  assert.equal(refused.kind, ERROR_KINDS.TLS, 'the self-signed certificate still needs the box');
  const opened = await session(request, { insecure: true });
  assert.equal(opened.https, true);
  assert.equal(device.logins.ok, 1);
});

test('the IPv6 address of the router is bracketed in the URL', async () => {
  const device = new FakeOpenwrt({ users: users() });
  const network = createNetwork({ '2001:db8::1': device });
  const opened = await openSession({
    api: 'ubus',
    host: '2001:db8::1',
    username: 'gladys',
    password: 'secret',
    request: network.request,
  });
  assert.equal(opened.backend.kind, 'ubus');
});
