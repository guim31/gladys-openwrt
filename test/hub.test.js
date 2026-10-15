// -----------------------------------------------------------------------------
// The hub end to end, against the SDK's fake Gladys and the fake OpenWrt:
// discovery, states, presence and its departure delay, the scene triggers,
// the commands (off by default), the read-only ACL, the LuCI RPC fallback, the
// router going away and coming back, the state kept in /data.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  FakeOpenwrt,
  baseConfig,
  createAll,
  createClock,
  createWorld,
  ids,
  later,
  readOnlyUser,
} from './helpers/world.js';

async function world(t, options) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

const PHONE = '00:00:5E:00:53:21';
const TABLET = '00:00:5E:00:53:22';
const NAS = '00:00:5E:00:53:31';
const presenceOf = (w, mac) => w.fake.lastState(ids(w.gladys).client(mac).feature('presence'));
const routerFeature = (w, key) => w.fake.lastState(ids(w.gladys).router().feature(key));

test('discovery: the router and the clients seen, never the router itself', async (t) => {
  const w = await world(t);
  const devices = w.fake.discoveredDevices;
  assert.equal(devices[0].external_id, ids(w.gladys).router().device);
  assert.equal(devices[0].name, 'OpenWrt Linksys E8450 (UBI)');
  const macs = devices.slice(1).map((device) => device.params[0].value);
  assert.ok(macs.includes(PHONE) && macs.includes(NAS));
  assert.ok(!macs.includes('00:00:5E:00:53:01'), 'not the MAC of the router');
  assert.equal(devices.find((d) => d.params[0].value === PHONE)?.name, 'Pixel-of-Alex');
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('states: published for the added devices only, then only when they change', async (t) => {
  const w = await world(t);
  assert.equal(w.fake.states.length, 0, 'nothing for devices not added');
  await createAll(w);
  assert.equal(routerFeature(w, 'load'), 42);
  assert.equal(routerFeature(w, 'memory_usage'), 45);
  assert.equal(routerFeature(w, 'uptime'), 114);
  assert.equal(routerFeature(w, 'openwrt_version'), '23.05.5');
  assert.equal(
    routerFeature(w, 'wifi_radio0_clients'),
    2,
    'the unauthorized station does not count',
  );
  assert.equal(routerFeature(w, 'wifi_radio1_clients'), 2);
  assert.equal(routerFeature(w, 'wan_wan_link'), 1);
  assert.equal(presenceOf(w, PHONE), 1);
  const count = w.fake.states.length;
  await later(w, 1);
  assert.equal(w.fake.states.length - count, 2, 'only the WAN rates, which appear now');
  w.router.traffic('wan', 75_000_000, 7_500_000);
  await later(w, 1);
  assert.equal(routerFeature(w, 'wan_wan_download'), 10);
  assert.equal(routerFeature(w, 'wan_wan_upload'), 1);
});

test('a heartbeat publishes an unchanged value again, a present client more often', async (t) => {
  const w = await world(t, { timings: { heartbeatMs: 30 * 60_000, presentRefreshMs: 2 * 60_000 } });
  await createAll(w);
  const published = (key) =>
    w.fake.states.filter((s) => s.device_feature_external_id === key).length;
  const version = ids(w.gladys).router().feature('openwrt_version');
  const phone = ids(w.gladys).client(PHONE).feature('presence');
  const before = { version: published(version), phone: published(phone) };
  for (let i = 0; i < 31; i += 1) {
    await later(w, 1);
  }
  assert.equal(published(version) - before.version, 1);
  assert.ok(published(phone) - before.phone >= 10);
});

test('presence: a departure counts after the delay, an outage of the router changes nothing', async (t) => {
  const w = await world(t, { config: baseConfig({ away_delay: 5 }) });
  await createAll(w);
  assert.equal(presenceOf(w, PHONE), 1);
  w.router.dissociate(PHONE);
  await later(w, 2);
  assert.equal(presenceOf(w, PHONE), 1, 'asleep for 2 minutes: still home');
  w.router.associate(PHONE);
  await later(w, 1);
  w.router.dissociate(PHONE);
  await later(w, 4);
  assert.equal(presenceOf(w, PHONE), 1);
  await later(w, 2);
  assert.equal(presenceOf(w, PHONE), 0, 'gone for more than 5 minutes');
  w.router.goOffline();
  for (let i = 0; i < 10; i += 1) {
    await later(w, 2);
  }
  assert.equal(presenceOf(w, TABLET), 1, 'the router down sends nobody away');
  assert.equal(w.fake.connectionStatus.connected, false);
  w.router.goOnline();
  w.router.associate(PHONE);
  await later(w, 1);
  assert.equal(presenceOf(w, PHONE), 1);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
});

test('presence: a wired device is present through its DHCP lease only when asked', async (t) => {
  const off = await world(t);
  await createAll(off);
  assert.equal(presenceOf(off, NAS), undefined, 'nothing until the delay is over');
  await later(off, 6);
  assert.equal(presenceOf(off, NAS), 0);
  const on = await world(t, { config: baseConfig({ presence_dhcp: true }) });
  await createAll(on);
  assert.equal(presenceOf(on, NAS), 1);
});

test('a device added in Gladys gets its values at once', async (t) => {
  const w = await world(t);
  const router = w.fake.discoveredDevices[0];
  await w.fake.deviceCreated(router);
  assert.equal(routerFeature(w, 'load'), 42);
  assert.ok(w.fake.widgetRefreshes.length > 0);
});

test('unknown device: the first reading learns the network, a new MAC fires once', async (t) => {
  const clock = createClock();
  const w = await world(t, { clock });
  assert.equal(w.fake.sceneEvents.length, 0, 'nothing at the first reading');
  w.router.associate('00:00:5E:00:53:66', 'phy0-ap1');
  await later(w, 1);
  await later(w, 1);
  const events = w.fake.sceneEvents.filter((e) => e.key === 'unknown_device_connected');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].data, {
    mac: '00:00:5E:00:53:66',
    ip: null,
    host_name: null,
    source: 'wifi',
    ssid: 'Home-Guests',
    interface: 'phy0-ap1',
  });
  // A station still in the handshake is not a connection.
  w.router.associate('00:00:5E:00:53:67', 'phy0-ap0', { authorized: false });
  // A lease of a wired device is one.
  w.router.addLease('00:00:5E:00:53:68', '192.0.2.168', 'printer');
  await later(w, 1);
  const after = w.fake.sceneEvents.filter((e) => e.key === 'unknown_device_connected');
  assert.deepEqual(
    after.map((e) => [e.data.mac, e.data.source, e.data.host_name]),
    [
      ['00:00:5E:00:53:66', 'wifi', null],
      ['00:00:5E:00:53:68', 'dhcp', 'printer'],
    ],
  );

  // After a restart, the MACs already seen are remembered.
  await w.app.stop();
  const again = await world(t, { clock, device: w.router, dataDir: w.dataDir });
  await later(again, 1);
  assert.equal(again.fake.sceneEvents.length, 0);
  const saved = JSON.parse(await readFile(join(w.dataDir, 'openwrt-state.json'), 'utf8'));
  assert.ok('00:00:5E:00:53:66' in saved.knownMacs);
});

test('unknown device: at most five events per reading', async (t) => {
  const w = await world(t);
  for (let i = 0; i < 9; i += 1) {
    w.router.associate(`00:00:5E:00:53:7${i}`, 'phy1-ap0');
  }
  await later(w, 1);
  assert.equal(w.fake.sceneEvents.length, 5);
});

test('WAN down and restored: one event each, with the length of the outage', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.router.setInterfaceUp('wan', false);
  await later(w, 1);
  await later(w, 1);
  assert.equal(routerFeature(w, 'wan_wan_link'), 0);
  await later(w, 10);
  w.router.setInterfaceUp('wan', true);
  await later(w, 1);
  assert.deepEqual(
    w.fake.sceneEvents.map((e) => [e.key, e.data]),
    [
      ['wan_down', { interface: 'wan' }],
      ['wan_up', { interface: 'wan', down_minutes: 12 }],
    ],
  );
  assert.equal(routerFeature(w, 'wan_wan_link'), 1);
});

test('the WAN: detected once, even when it loses its default route; or set by hand', async (t) => {
  const w = await world(t);
  assert.deepEqual(
    w.hub.router.wan.map((item) => item.name),
    ['wan'],
  );
  const pppoe = await world(t, {
    device: new FakeOpenwrt({ fixture: 'openwrt-18.06-pppoe', users: readOnlyUser() }),
  });
  assert.deepEqual(
    pppoe.hub.router.wan.map((item) => item.name),
    ['wan'],
  );
  pppoe.router.setInterfaceUp('wan', false);
  await later(pppoe, 1);
  assert.deepEqual(
    pppoe.hub.router.wan.map((item) => item.name),
    ['wan'],
  );
  const manual = await world(t, { config: baseConfig({ wan_interfaces: 'wan6, wwan' }) });
  await createAll(manual);
  assert.deepEqual(
    manual.hub.router.wan.map((item) => item.name),
    ['wan6', 'wwan'],
  );
  assert.equal(manual.fake.lastState(ids(manual.gladys).router().feature('wan_wan6_link')), 1);
  assert.equal(
    manual.fake.lastState(ids(manual.gladys).router().feature('wan_wwan_link')),
    undefined,
    'an interface the router does not have gets no value',
  );
});

test('PPPoE: the rates come from pppoe-wan; a new session resets nothing wrong', async (t) => {
  const w = await world(t, {
    device: new FakeOpenwrt({ fixture: 'openwrt-18.06-pppoe', users: readOnlyUser() }),
    config: baseConfig(),
  });
  await createAll(w);
  w.router.traffic('pppoe-wan', 30_000_000, 3_000_000);
  await later(w, 1);
  assert.equal(
    w.fake.lastState(ids(w.gladys).router('00-00-5e-00-53-a1').feature('wan_wan_download')),
    4,
  );
  // The counters start again at a new PPPoE session: no negative rate.
  w.router.ubusData['network.device status']['pppoe-wan'].statistics.rx_bytes = 1000;
  await later(w, 1);
  assert.equal(
    w.fake.lastState(ids(w.gladys).router('00-00-5e-00-53-a1').feature('wan_wan_download')),
    4,
  );
});

test('older OpenWrt: iwinfo stations, dnsmasq lease file, memory without `available`', async (t) => {
  const w = await world(t, {
    device: new FakeOpenwrt({ fixture: 'openwrt-18.06-pppoe', users: readOnlyUser() }),
  });
  await createAll(w);
  const router = ids(w.gladys).router('00-00-5e-00-53-a1');
  assert.equal(w.fake.discoveredDevices[0].name, 'gateway');
  assert.equal(w.fake.lastState(router.feature('memory_usage')), 37);
  assert.equal(w.fake.lastState(router.feature('load')), 100);
  assert.equal(w.fake.lastState(router.feature('wifi_radio0_clients')), 1);
  assert.equal(w.fake.lastState(router.feature('wifi_radio1_clients')), 1);
  const tablet = w.fake.discoveredDevices.find((d) => d.params[0].value === '00:00:5E:00:53:B1');
  assert.equal(tablet.name, 'Tablet-Kitchen');
  assert.equal(presenceOf(w, '00:00:5E:00:53:B1'), 1);
  assert.ok(w.router.calls.some((c) => c.object === 'file' && c.args.path === '/tmp/dhcp.leases'));
  assert.ok(!w.router.calls.some((c) => c.object.startsWith('hostapd.')));
});

test('a read-only ACL without hostapd: the gaps are reported, the rest works', async (t) => {
  const device = new FakeOpenwrt({
    users: {
      gladys: {
        password: 'secret-OpenWrt-pw',
        acl: ['system board', 'system info', 'network.interface dump', 'network.device status'],
      },
    },
  });
  const w = await world(t, { device });
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  const ack = await w.fake.action('test_connection', {});
  assert.match(
    ack.data.message.en,
    /Not readable \(ACL or missing package\): network\.wireless status/,
  );
  assert.match(ack.data.message.en, /luci-rpc getDHCPLeases/);
  assert.match(ack.data.message.en, /WAN: wan \(up\)/);
});

test('an ACL without system info is an error the user sees', async (t) => {
  const device = new FakeOpenwrt({
    users: { gladys: { password: 'secret-OpenWrt-pw', acl: ['system board'] } },
  });
  const w = await world(t, { device });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /ACL/);
});

test('a refused password is not tried again at every reading', async (t) => {
  const w = await world(t, { config: baseConfig({ password: 'wrong' }) });
  assert.match(w.fake.connectionStatus.message.en, /refused by rpcd/);
  for (let i = 0; i < 4; i += 1) {
    await later(w, 1);
  }
  assert.equal(w.router.logins.failed, 1);
  await later(w, 5);
  assert.equal(w.router.logins.failed, 2);
});

test('a session expired on the router (reboot) is renewed without an outage', async (t) => {
  const w = await world(t);
  await createAll(w);
  w.router.expireSessions();
  await later(w, 1);
  assert.deepEqual(w.fake.connectionStatus, { connected: true });
  assert.equal(w.router.logins.ok, 2);
});

test('commands are off by default', async (t) => {
  const w = await world(t, { config: baseConfig({ guest_wifi: 'guest' }) });
  for (const key of ['enable_guest_wifi', 'disable_guest_wifi', 'reboot_router']) {
    const ack = await w.fake.sceneAction(key, {});
    assert.equal(ack.success, false);
    assert.match(ack.error, /Allow commands/);
  }
  assert.ok(!w.router.calls.some((c) => ['set', 'commit', 'reboot'].includes(c.method)));
});

test('guest Wi-Fi: off and on again through uci, its state follows', async (t) => {
  const w = await world(t, { config: baseConfig({ guest_wifi: 'guest', allow_commands: true }) });
  await createAll(w);
  assert.equal(routerFeature(w, 'guest_wifi'), 1);
  const off = await w.fake.sceneAction('disable_guest_wifi', {});
  assert.deepEqual(off.data.outputs, { enabled: false });
  assert.equal(w.router.uci.wireless.guest.disabled, '1');
  assert.equal(w.router.commits, 1);
  assert.equal(routerFeature(w, 'guest_wifi'), 0);
  await later(w, 1);
  assert.equal(routerFeature(w, 'guest_wifi'), 0);
  assert.ok(!w.router.wirelessStatus().radio0.interfaces.some((i) => i.section === 'guest'));
  const on = await w.fake.sceneAction('enable_guest_wifi', {});
  assert.deepEqual(on.data.outputs, { enabled: true });
  assert.equal(w.router.uci.wireless.guest.disabled, '0');
  assert.equal(routerFeature(w, 'guest_wifi'), 1);
  const sets = w.router.calls.filter((c) => c.object === 'uci' && c.method === 'set');
  assert.ok(
    sets.every((c) => Object.keys(c.args.values).join() === 'disabled'),
    'nothing else',
  );
});

test('guest Wi-Fi: no section chosen, a section that does not exist, an ACL without write', async (t) => {
  const none = await world(t, { config: baseConfig({ allow_commands: true }) });
  assert.match((await none.fake.sceneAction('enable_guest_wifi', {})).error, /No guest Wi-Fi/);
  const missing = await world(t, {
    config: baseConfig({ guest_wifi: 'visitors', allow_commands: true }),
  });
  assert.match(
    (await missing.fake.sceneAction('enable_guest_wifi', {})).error,
    /no wifi-iface section/,
  );
  const report = await missing.fake.action('test_connection', {});
  assert.match(report.data.message.en, /Guest Wi-Fi: no wifi-iface section/);
  const readOnly = await world(t, {
    device: new FakeOpenwrt({ users: readOnlyUser() }),
    config: baseConfig({ guest_wifi: 'guest', allow_commands: true }),
  });
  assert.match(
    (await readOnly.fake.sceneAction('disable_guest_wifi', {})).error,
    /write rights of the documentation/,
  );
  assert.equal(readOnly.router.uci.wireless.guest.disabled, undefined);
});

test('reboot: asked once, the session is dropped', async (t) => {
  const w = await world(t, { config: baseConfig({ allow_commands: true }) });
  const ack = await w.fake.sceneAction('reboot_router', {});
  assert.equal(ack.success, true);
  assert.equal(w.router.rebooted, true);
  assert.equal(w.hub.session, null);
});

test('a router that hangs up while rebooting counts as rebooting', async (t) => {
  const w = await world(t, { config: baseConfig({ allow_commands: true }) });
  const original = w.router.invoke.bind(w.router);
  w.router.invoke = (object, method, ...rest) => {
    if (method === 'reboot') {
      w.router.goOffline();
    }
    return original(object, method, ...rest);
  };
  const request = w.network.request;
  w.hub.seams.request = async (url, options) => {
    const answer = await request(url, options);
    if (w.router.offline) {
      const error = new Error('socket hang up');
      error.code = 'ECONNRESET';
      throw error;
    }
    return answer;
  };
  const ack = await w.fake.sceneAction('reboot_router', {});
  assert.equal(ack.success, true, ack.error);
});

test('LuCI RPC fallback: presence from the neighbours of the LAN, the uptime, no WAN', async (t) => {
  const w = await world(t, {
    device: new FakeOpenwrt({ fixture: 'luci-rpc-18.06', users: readOnlyUser() }),
    config: baseConfig({ guest_wifi: 'guest', allow_commands: true }),
  });
  await createAll(w);
  const [router, ...clients] = w.fake.discoveredDevices;
  assert.equal(router.name, 'attic-ap');
  assert.deepEqual(
    router.features.map((f) => f.external_id.split(':').pop()),
    ['uptime'],
  );
  assert.deepEqual(
    clients.map((c) => [c.name, c.params[0].value]),
    [
      ['laptop-sam', '00:00:5E:00:53:E1'],
      ['Device 00:00:5E:00:53:E2', '00:00:5E:00:53:E2'],
    ],
    'the ISP box on the WAN side is not a client',
  );
  assert.equal(presenceOf(w, '00:00:5E:00:53:E1'), 1);
  assert.equal(w.fake.lastState(ids(w.gladys).router('00-00-5e-00-53-d1').feature('uptime')), 24);
  assert.match((await w.fake.sceneAction('enable_guest_wifi', {})).error, /needs ubus/);
  const report = await w.fake.action('test_connection', {});
  assert.match(report.data.message.en, /Connected with LuCI RPC/);
  assert.match(report.data.message.en, /LuCI RPC fallback/);
  const networks = await w.fake.action('list_wifi_networks', {});
  assert.match(networks.data.message.en, /needs ubus/);
});

test('reconfiguration: a new address starts over, a new delay does not', async (t) => {
  const w = await world(t);
  await createAll(w);
  const logins = w.router.logins.ok;
  await w.fake.configUpdated({ ...w.fake.config, away_delay: 10 });
  assert.equal(w.router.logins.ok, logins, 'the same session');
  assert.equal(w.hub.presence.awayDelayMs, 10 * 60_000);
  await w.fake.configUpdated({ ...w.fake.config, host: '192.0.2.99' });
  assert.equal(w.fake.connectionStatus.connected, false);
  assert.match(w.fake.connectionStatus.message.en, /does not answer/);
});

test('no address: a clear message, nothing read', async (t) => {
  const w = await world(t, { config: { language: 'fr' } });
  assert.deepEqual(w.fake.connectionStatus, {
    connected: false,
    message: {
      en: 'Enter the address of your OpenWrt router in the configuration.',
      fr: "Saisissez l'adresse de votre routeur OpenWrt dans la configuration.",
      de: 'Gib die Adresse deines OpenWrt-Routers in der Konfiguration ein.',
      es: 'Introduzca la dirección de su router OpenWrt en la configuración.',
    },
  });
  assert.equal(w.router.requests.length, 0);
});

test('HTTPS: the self-signed certificate is accepted only when ticked', async (t) => {
  const device = () =>
    new FakeOpenwrt({ users: readOnlyUser(), https: true, http: true, redirectHttps: true });
  const refused = await world(t, { device: device() });
  assert.match(refused.fake.connectionStatus.message.en, /self-signed/);
  const accepted = await world(t, {
    device: device(),
    config: baseConfig({ allow_self_signed: true }),
  });
  assert.deepEqual(accepted.fake.connectionStatus, { connected: true });
  const report = await accepted.fake.action('test_connection', {});
  assert.match(report.data.message.en, /Connected with ubus \(HTTPS\)/);
  assert.doesNotMatch(report.data.message.en, /unencrypted/);
});

test('the Wi-Fi networks list names the sections, marks the guest one', async (t) => {
  const w = await world(t, { config: baseConfig({ guest_wifi: 'guest' }) });
  const ack = await w.fake.action('list_wifi_networks', {});
  const lines = ack.data.message.en.split('\n');
  assert.equal(lines.length, 4);
  assert.match(
    lines[2],
    /^guest ✓ guest Wi-Fi — "Home-Guests", 2\.4 GHz, ap, guest, 1 client\(s\)$/,
  );
  assert.ok(!ack.data.message.en.includes('not-a-real-wifi-key'));
});
