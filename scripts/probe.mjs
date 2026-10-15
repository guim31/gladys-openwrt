#!/usr/bin/env node
// -----------------------------------------------------------------------------
// Read-only probe of a real OpenWrt device, with the very clients of the
// integration: `node scripts/probe.mjs <address> [--https] [--insecure]`.
//
//   - Without credentials, it logs in with an invented account on ubus and on
//     the LuCI RPC API and reports how each one refuses it: it checks the
//     detection and the error reading against a real OpenWrt.
//   - With OPENWRT_USER and OPENWRT_PASSWORD in the environment, it opens a
//     session like the integration does and calls every method the
//     integration reads (never `uci set`, `uci commit` nor `reboot`).
//
// The output never shows a password, a session token, a Wi-Fi key, a MAC or
// IP address, a host name nor an SSID: only versions, models, counts, field
// names and error kinds, so it can be pasted in an issue.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { parseAddress } from '../src/config.js';
import { LuciRpcClient } from '../src/openwrt/luci.js';
import { UbusClient } from '../src/openwrt/ubus.js';
import { API_LABELS, LEASE_FILE, baseUrlOf, openSession } from '../src/openwrt/client.js';
import {
  parseBoard,
  parseDevices,
  parseInfo,
  parseInterfaces,
  parseWireless,
} from '../src/openwrt/model.js';

/** The keys of an answer, never its values. */
const shape = (value) =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? Object.keys(value).sort().join(', ') || '-'
    : Array.isArray(value)
      ? `array of ${value.length}`
      : typeof value;

/**
 * @param {object} options { host, port, https, insecure, username, password, request }
 * @returns {Promise<string[]>} the report lines
 */
export async function probe({
  host,
  port = null,
  https = false,
  insecure = false,
  username,
  password,
  request,
}) {
  const lines = [];
  const common = { host, port, https, insecure, request, timeoutMs: 8000 };
  if (!username) {
    lines.push('No OPENWRT_USER: logging in with an invented account.');
    const fake = {
      baseUrl: baseUrlOf(common),
      username: `probe-${randomBytes(4).toString('hex')}`,
      password: randomBytes(12).toString('hex'),
      insecure,
      request,
      timeoutMs: 8000,
    };
    for (const client of [new UbusClient(fake), new LuciRpcClient(fake)]) {
      try {
        await client.open();
        lines.push(`${API_LABELS[client.kind]}: the invented account was ACCEPTED (unexpected)`);
      } catch (err) {
        lines.push(`${API_LABELS[client.kind]}: ${err.kind ?? 'error'} — ${err.message}`);
      }
    }
    return lines;
  }

  let opened;
  try {
    opened = await openSession({ ...common, api: 'auto', username, password });
  } catch (err) {
    lines.push(`No session: ${err.kind} — ${err.message}`);
    for (const attempt of err.attempts ?? []) {
      lines.push(
        `  ${API_LABELS[attempt.kind]}: ${attempt.error?.kind} — ${attempt.error?.message}`,
      );
    }
    return lines;
  }
  const { backend } = opened;
  lines.push(`Interface: ${API_LABELS[backend.kind]}${opened.https ? ' over HTTPS' : ''}`);
  if (backend.kind === 'luci') {
    const identity = await backend.identity();
    const reading = await backend.read();
    lines.push(
      `Hardware id found: ${identity.mac ? 'yes' : 'no'}; uptime read: ${reading.system.uptimeSeconds !== null}`,
      `Neighbours: ${reading.neighbours.length} (${reading.neighbours.filter((n) => n.reachable).length} reachable); static hosts: ${reading.names.length}`,
      ...reading.gaps.map((gap) => `Not readable: ${gap.what} (${gap.kind})`),
    );
    return lines;
  }

  const raw = {};
  const calls = [
    ['system', 'board'],
    ['system', 'info'],
    ['network.interface', 'dump'],
    ['network.device', 'status'],
    ['network.wireless', 'status'],
    ['luci-rpc', 'getDHCPLeases', { family: 4 }],
    ['file', 'read', { path: LEASE_FILE }],
  ];
  for (const [object, method, args] of calls) {
    try {
      raw[`${object} ${method}`] = await backend.call(object, method, args ?? {});
      lines.push(`${object} ${method}: ok; fields: ${shape(raw[`${object} ${method}`])}`);
    } catch (err) {
      lines.push(`${object} ${method}: ${err.kind} — ${err.message}`);
    }
  }
  const board = parseBoard(raw['system board']);
  const info = parseInfo(raw['system info']);
  const interfaces = parseInterfaces(raw['network.interface dump']);
  const devices = parseDevices(raw['network.device status']);
  const radios = parseWireless(raw['network.wireless status']);
  lines.push(
    `OpenWrt ${board.version} (${board.revision}), target ${board.target}, model ${board.model}`,
    `Load ${info.load1?.toFixed(2)}, memory ${info.memoryUsage} %, uptime ${info.uptimeSeconds} s`,
    `Interfaces: ${interfaces.map((i) => `${i.name}/${i.proto}${i.up ? '' : ' down'}${i.defaultRoute4 ? ' default' : ''}`).join(', ')}`,
    `Devices: ${devices.size}, with counters: ${[...devices.values()].filter((d) => d.rxBytes !== null).length}, eth0 MAC present: ${Boolean(devices.get('eth0')?.mac)}`,
    `Radios: ${radios.map((r) => `${r.name} ${r.band} (${r.ifaces.length} interface(s))`).join(', ') || 'none'}`,
  );
  const reading = await backend.read({ guestSection: null });
  lines.push(
    `Stations: ${reading.stations.length} (${reading.stations.filter((s) => s.authorized).length} authorized), readers: ${[...backend.stationReaders.values()].join(', ') || '-'}`,
    `DHCP leases: ${reading.leases.length}, reader: ${backend.leaseReader}`,
    ...reading.gaps.map((gap) => `Not readable: ${gap.what} (${gap.kind})`),
  );
  return lines;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [address, ...flags] = process.argv.slice(2);
  const parsed = parseAddress(address ?? '');
  if (!parsed) {
    console.error(
      'Usage: OPENWRT_USER=… OPENWRT_PASSWORD=… node scripts/probe.mjs <address> [--https] [--insecure]',
    );
    process.exit(2);
  }
  const lines = await probe({
    host: parsed.host,
    port: parsed.port,
    https: parsed.https || flags.includes('--https'),
    insecure: flags.includes('--insecure'),
    username: process.env.OPENWRT_USER,
    password: process.env.OPENWRT_PASSWORD ?? '',
  });
  console.log(lines.join('\n'));
}
