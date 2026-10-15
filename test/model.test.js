// -----------------------------------------------------------------------------
// The readers of the OpenWrt answers (src/openwrt/model.js), on the fixtures
// and on the edge cases the sources of procd, netifd, hostapd and rpcd allow.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeMac,
  parseAssoclist,
  parseBoard,
  parseDevices,
  parseDhcpLeases,
  parseHostapdClients,
  parseInfo,
  parseInterfaces,
  parseLeaseFile,
  parseNeighbors,
  parseStaticHosts,
  parseWireless,
  radioBand,
} from '../src/openwrt/model.js';
import { hardwareId } from '../src/openwrt/client.js';
import { fixture } from './helpers/fakeOpenwrt.js';

const e8450 = fixture('openwrt-23.05-e8450').ubus;
const wdr = fixture('openwrt-18.06-pppoe').ubus;
const luci = fixture('luci-rpc-18.06').luci;

test('MAC addresses are normalized, the empty one refused', () => {
  assert.equal(normalizeMac('00:00:5e:00:53:21'), '00:00:5E:00:53:21');
  assert.equal(normalizeMac('00-00-5E-00-53-21'), '00:00:5E:00:53:21');
  assert.equal(normalizeMac('00005e005321'), '00:00:5E:00:53:21');
  assert.equal(normalizeMac('00:00:00:00:00:00'), null);
  assert.equal(normalizeMac('not a mac'), null);
  assert.equal(normalizeMac(undefined), null);
});

test('system board: model, host name and release', () => {
  const board = parseBoard(e8450['system board']);
  assert.equal(board.hostname, 'OpenWrt');
  assert.equal(board.model, 'Linksys E8450 (UBI)');
  assert.equal(board.version, '23.05.5');
  assert.equal(board.revision, 'r24106-10cc5fcd00');
  assert.deepEqual(parseBoard(null).version, null);
});

test('system info: load averages in fixed point, memory with or without `available`', () => {
  const info = parseInfo(e8450['system info']);
  assert.equal(info.uptimeSeconds, 412345);
  assert.equal(Math.round(info.load1 * 100), 42);
  assert.equal(Math.round(info.load15 * 100), 20);
  // (total - available) / total
  assert.equal(info.memoryUsage, 45);
  const old = parseInfo(wdr['system info']);
  assert.equal(old.load1, 1);
  // (total - free - buffered - cached) / total, without `available` (18.06)
  assert.equal(old.memoryUsage, 37);
  assert.deepEqual(parseInfo({}), {
    uptimeSeconds: null,
    load1: null,
    load5: null,
    load15: null,
    memoryUsage: null,
    memoryTotalBytes: null,
  });
});

test('network.interface dump: state, devices and default routes', () => {
  const interfaces = parseInterfaces(e8450['network.interface dump']);
  const wan = interfaces.find((item) => item.name === 'wan');
  assert.deepEqual(
    { up: wan.up, l3: wan.l3Device, route4: wan.defaultRoute4, route6: wan.defaultRoute6 },
    { up: true, l3: 'wan', route4: true, route6: false },
  );
  const wan6 = interfaces.find((item) => item.name === 'wan6');
  assert.equal(wan6.defaultRoute4, false);
  assert.equal(wan6.defaultRoute6, true);
  const pppoe = parseInterfaces(wdr['network.interface dump']).find((item) => item.name === 'wan');
  assert.equal(pppoe.l3Device, 'pppoe-wan');
  assert.equal(pppoe.device, 'eth0.2');
  assert.deepEqual(parseInterfaces(null), []);
});

test('network.device status: counters, carrier and MAC of every device', () => {
  const devices = parseDevices(e8450['network.device status']);
  assert.equal(devices.get('wan').rxBytes, 87654321098);
  assert.equal(devices.get('lan2').carrier, false);
  assert.equal(devices.get('eth0').mac, '00:00:5E:00:53:01');
  assert.equal(devices.get('lo').mac, null);
});

test('the router identity is the MAC of eth0, else of the first Ethernet port, else of br-lan', () => {
  assert.equal(hardwareId(parseDevices(e8450['network.device status'])), '00:00:5E:00:53:01');
  const noEth0 = structuredClone(e8450['network.device status']);
  delete noEth0.eth0;
  assert.equal(hardwareId(parseDevices(noEth0)), '00:00:5E:00:53:01'); // lan1 (dsa) is skipped: br-lan
  const bridgeOnly = { 'br-lan': { macaddr: '00:00:5e:00:53:99', devtype: 'bridge' } };
  assert.equal(hardwareId(parseDevices(bridgeOnly)), '00:00:5E:00:53:99');
  assert.equal(hardwareId(new Map()), null);
});

test('network.wireless status: radios, bands, interfaces, and never the key', () => {
  const radios = parseWireless(e8450['network.wireless status']);
  assert.deepEqual(
    radios.map((radio) => [radio.name, radio.band, radio.ifaces.map((i) => i.section)]),
    [
      ['radio0', '2.4 GHz', ['default_radio0', 'guest']],
      ['radio1', '5 GHz', ['default_radio1']],
    ],
  );
  assert.deepEqual(radios[0].ifaces[1], {
    section: 'guest',
    ifname: 'phy0-ap1',
    ssid: 'Home-Guests',
    mode: 'ap',
    network: ['guest'],
  });
  assert.ok(!JSON.stringify(radios).includes('not-a-real-wifi-key'), 'the keys are dropped');
  const old = parseWireless(wdr['network.wireless status']);
  assert.deepEqual(
    old.map((radio) => radio.band),
    ['2.4 GHz', '5 GHz'],
  );
});

test('radio bands from band, hwmode or channel', () => {
  assert.equal(radioBand({ band: '6g' }), '6 GHz');
  assert.equal(radioBand({ hwmode: '11a' }), '5 GHz');
  assert.equal(radioBand({ hwmode: '11g' }), '2.4 GHz');
  assert.equal(radioBand({ channel: '149' }), '5 GHz');
  assert.equal(radioBand({ channel: '6' }), '2.4 GHz');
  assert.equal(radioBand({ channel: 'auto' }), null);
});

test('hostapd get_clients: MACs and the authorized flag', () => {
  const clients = parseHostapdClients(e8450['hostapd.phy0-ap0 get_clients']);
  assert.deepEqual(clients, [
    { mac: '00:00:5E:00:53:21', authorized: true, signal: -61 },
    { mac: '00:00:5E:00:53:29', authorized: false, signal: -80 },
  ]);
  assert.deepEqual(parseHostapdClients({ freq: 2412 }), []);
});

test('iwinfo assoclist: a station without the authorized field counts', () => {
  assert.deepEqual(parseAssoclist(wdr['iwinfo assoclist'].wlan1), [
    { mac: '00:00:5E:00:53:B2', authorized: true, signal: -66 },
  ]);
  assert.deepEqual(parseAssoclist({ results: [{ mac: 'x' }] }), []);
});

test('DHCP leases from rpcd-mod-luci and from the dnsmasq lease file', () => {
  const leases = parseDhcpLeases(e8450['luci-rpc getDHCPLeases']);
  assert.equal(leases.length, 5);
  assert.deepEqual(leases[2], { mac: '00:00:5E:00:53:23', ip: '192.0.2.123', hostName: null });
  const file = parseLeaseFile(wdr['file read']['/tmp/dhcp.leases']);
  assert.deepEqual(file, [
    { mac: '00:00:5E:00:53:B1', ip: '192.0.2.151', hostName: 'Tablet-Kitchen' },
    { mac: '00:00:5E:00:53:B2', ip: '192.0.2.152', hostName: null },
    { mac: '00:00:5E:00:53:C1', ip: '192.0.2.20', hostName: 'printer' },
  ]);
  assert.deepEqual(parseLeaseFile(''), []);
});

test('LuCI RPC: neighbours (18.06+ and older arptable) and static hosts', () => {
  const neighbours = parseNeighbors(luci['ip neighbors']);
  assert.deepEqual(
    neighbours.map((n) => [n.mac, n.reachable]),
    [
      ['00:00:5E:00:53:E1', true],
      ['00:00:5E:00:53:E2', false],
      ['00:00:5E:00:53:F1', true],
    ],
  );
  assert.deepEqual(
    parseNeighbors([
      {
        'IP address': '192.0.2.9',
        'HW address': '00:00:5e:00:53:09',
        Flags: '0x2',
        Device: 'br-lan',
      },
      {
        'IP address': '192.0.2.8',
        'HW address': '00:00:5e:00:53:08',
        Flags: '0x0',
        Device: 'br-lan',
      },
    ]).map((n) => n.reachable),
    [true, false],
  );
  assert.deepEqual(parseStaticHosts(luci['uci get_all'].dhcp), [
    { mac: '00:00:5E:00:53:E1', ip: '192.0.2.161', hostName: 'laptop-sam' },
  ]);
});
