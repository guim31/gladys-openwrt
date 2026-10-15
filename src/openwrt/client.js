// -----------------------------------------------------------------------------
// The session with the OpenWrt device, whatever its interface:
//
//   - `ubus`: ubus over HTTP (/ubus), present by default since OpenWrt 18.06
//     (rpcd + uhttpd-mod-ubus). Everything the integration offers.
//   - `luci`: the LuCI RPC API (luci-mod-rpc), the fallback of a device
//     without /ubus: presence from the neighbour table, the uptime, a reboot.
//
// `auto` tries ubus, then LuCI RPC only when /ubus does not exist. Plain HTTP
// redirected to HTTPS by uhttpd (`redirect_https`) switches to HTTPS.
//
// Both backends return the same normalized reading (see `read()`), so the
// hub never deals with ubus or LuCI.
// -----------------------------------------------------------------------------

import { ERROR_KINDS, OpenwrtError } from './errors.js';
import { LuciRpcClient } from './luci.js';
import {
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
} from './model.js';
import { UbusClient } from './ubus.js';

export const APIS = ['auto', 'ubus', 'luci_rpc'];
export const API_LABELS = Object.freeze({ ubus: 'ubus', luci: 'LuCI RPC' });

export const LEASE_FILE = '/tmp/dhcp.leases';

/** A missing object or a refused one: skipped, never an outage. */
export const optionalError = (err) =>
  err instanceof OpenwrtError &&
  (err.kind === ERROR_KINDS.NOT_FOUND || err.kind === ERROR_KINDS.PERMISSION);

/** `http://192.0.2.1`, `https://[2001:db8::1]:8443`. */
export function baseUrlOf({ host, port = null, https = false }) {
  const name = host.includes(':') ? `[${host}]` : host;
  return `${https ? 'https' : 'http'}://${name}${port ? `:${port}` : ''}`;
}

function createClient(kind, options, https) {
  const common = {
    baseUrl: baseUrlOf({ host: options.host, port: options.port, https }),
    username: options.username,
    password: options.password,
    insecure: options.insecure,
    request: options.request,
    timeoutMs: options.timeoutMs,
  };
  return kind === 'luci' ? new LuciRpcClient(common) : new UbusClient(common);
}

/** Log in with one interface, following a redirection to HTTPS once. */
async function openClient(kind, options) {
  let https = options.https === true;
  for (;;) {
    const client = createClient(kind, options, https);
    try {
      await client.open();
      return { client, https };
    } catch (err) {
      if (err.httpsRedirect && !https) {
        https = true;
        continue;
      }
      throw err;
    }
  }
}

/**
 * Open a session.
 * @param {object} options { api, host, port, https, insecure, username, password, request, timeoutMs }
 * @returns {Promise<{ backend: UbusBackend|LuciBackend, https: boolean, attempts: Array }>}
 * @throws {OpenwrtError} with `attempts` ({ kind, error }) when nothing logs in
 */
export async function openSession(options) {
  const order =
    options.api === 'luci_rpc' ? ['luci'] : options.api === 'ubus' ? ['ubus'] : ['ubus', 'luci'];
  const attempts = [];
  for (const kind of order) {
    try {
      const { client, https } = await openClient(kind, options);
      attempts.push({ kind, error: null });
      const backend = kind === 'luci' ? new LuciBackend(client) : new UbusBackend(client);
      return { backend, https, attempts };
    } catch (err) {
      attempts.push({ kind, error: { kind: err.kind, message: err.message } });
      // Only a missing interface makes the next one worth a try: a refused
      // password or an unreachable device would be the same there.
      if (err.kind !== ERROR_KINDS.NOT_OPENWRT) {
        err.attempts = attempts;
        throw err;
      }
    }
  }
  const first = attempts[0].error;
  const error = new OpenwrtError(first.kind, first.message);
  error.attempts = attempts;
  throw error;
}

/** Records what could not be read (missing or refused), for the connection report. */
class Gaps {
  constructor() {
    this.list = [];
  }

  async soft(what, promise, fallback) {
    try {
      return await promise;
    } catch (err) {
      if (!optionalError(err)) {
        throw err;
      }
      this.list.push({ what, kind: err.kind });
      return fallback;
    }
  }
}

/**
 * The router identity: the MAC address of its first Ethernet device (eth0 on
 * most targets, the CPU port of a DSA switch), else of its LAN bridge. A
 * permanent value of the hardware, never the address typed by the user.
 * @param {Map} devices parseDevices()
 */
export function hardwareId(devices) {
  const eth0 = devices.get('eth0');
  if (eth0?.mac) {
    return eth0.mac;
  }
  const ethernet = [...devices.values()]
    .filter((device) => device.mac && (device.devtype ?? 'ethernet') === 'ethernet')
    .filter((device) => /^(eth|lan|wan|enp|eno)/.test(device.name))
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (ethernet) {
    return ethernet.mac;
  }
  return devices.get('br-lan')?.mac ?? null;
}

export class UbusBackend {
  constructor(client) {
    this.kind = 'ubus';
    this.client = client;
    /** ifname → 'hostapd' | 'iwinfo' | false (nothing works). */
    this.stationReaders = new Map();
    /** 'luci' | 'file' | false, decided at the first reading. */
    this.leaseReader = null;
    this.guestSsid = new Map();
  }

  call(object, method, args, options) {
    return this.client.call(object, method, args, options);
  }

  /** Who the device is: read once per session. */
  async identity() {
    const board = parseBoard(await this.call('system', 'board'));
    let mac = null;
    try {
      mac = hardwareId(parseDevices(await this.call('network.device', 'status')));
    } catch (err) {
      if (!optionalError(err)) {
        throw err;
      }
    }
    return { mac, ...board };
  }

  /**
   * One reading.
   * @param {object} [options] { guestSection }
   */
  async read({ guestSection = null } = {}) {
    const gaps = new Gaps();
    const system = parseInfo(await this.call('system', 'info'));
    const interfaces = parseInterfaces(
      await gaps.soft('network.interface dump', this.call('network.interface', 'dump'), {}),
    );
    const devices = parseDevices(
      await gaps.soft('network.device status', this.call('network.device', 'status'), {}),
    );
    const radios = parseWireless(
      await gaps.soft('network.wireless status', this.call('network.wireless', 'status'), {}),
    );
    const stations = [];
    for (const radio of radios) {
      for (const iface of radio.ifaces) {
        if (!iface.ifname || iface.mode !== 'ap') {
          continue;
        }
        const list = await this.readStations(iface.ifname, gaps);
        for (const station of list) {
          stations.push({ ...station, ifname: iface.ifname, ssid: iface.ssid, radio: radio.name });
        }
      }
    }
    const leases = await this.readLeases(gaps);
    const guest = guestSection ? await this.readGuest(guestSection, gaps) : null;
    return {
      system,
      interfaces,
      devices,
      radios,
      stations,
      leases,
      neighbours: [],
      names: [],
      guest,
      gaps: gaps.list,
    };
  }

  /** The stations of one access point: hostapd, else iwinfo (rpcd-mod-iwinfo). */
  async readStations(ifname, gaps) {
    const known = this.stationReaders.get(ifname);
    const tries = known ? [known] : known === false ? [] : ['hostapd', 'iwinfo'];
    let lastError = null;
    for (const reader of tries) {
      try {
        const list =
          reader === 'hostapd'
            ? parseHostapdClients(await this.call(`hostapd.${ifname}`, 'get_clients'))
            : parseAssoclist(await this.call('iwinfo', 'assoclist', { device: ifname }));
        this.stationReaders.set(ifname, reader);
        return list;
      } catch (err) {
        if (!optionalError(err)) {
          throw err;
        }
        lastError = err;
      }
    }
    if (lastError) {
      // Not tried again in this session: a missing object stays missing.
      this.stationReaders.set(ifname, false);
      gaps.list.push({ what: `hostapd.${ifname} get_clients`, kind: lastError.kind });
    }
    return [];
  }

  /** The DHCP leases: rpcd-mod-luci (dnsmasq and odhcpd), else the dnsmasq lease file. */
  async readLeases(gaps) {
    const tries =
      this.leaseReader === null ? ['luci', 'file'] : this.leaseReader ? [this.leaseReader] : [];
    let lastError = null;
    for (const reader of tries) {
      try {
        const leases =
          reader === 'luci'
            ? parseDhcpLeases(await this.call('luci-rpc', 'getDHCPLeases', { family: 4 }))
            : parseLeaseFile((await this.call('file', 'read', { path: LEASE_FILE })).data);
        this.leaseReader = reader;
        return leases;
      } catch (err) {
        if (!optionalError(err)) {
          throw err;
        }
        lastError = err;
      }
    }
    if (lastError) {
      this.leaseReader = false;
      gaps.list.push({ what: 'luci-rpc getDHCPLeases', kind: lastError.kind });
    }
    return [];
  }

  async uciOption(section, option) {
    const data = await this.call('uci', 'get', { config: 'wireless', section, option });
    return Array.isArray(data.value) ? data.value.join(' ') : (data.value ?? null);
  }

  /**
   * The guest Wi-Fi: a wifi-iface section of /etc/config/wireless, enabled
   * unless its `disabled` option is set. Only `device`, `disabled` and `ssid`
   * are read: never the key.
   */
  async readGuest(section, gaps) {
    let radio;
    try {
      radio = await this.uciOption(section, 'device');
    } catch (err) {
      if (!optionalError(err)) {
        throw err;
      }
      if (err.kind === ERROR_KINDS.PERMISSION) {
        gaps.list.push({ what: 'uci get wireless', kind: err.kind });
        return { section, found: null, enabled: null, ssid: null, radio: null };
      }
      return { section, found: false, enabled: null, ssid: null, radio: null };
    }
    let disabled = null;
    try {
      disabled = await this.uciOption(section, 'disabled');
    } catch (err) {
      if (!optionalError(err)) {
        throw err;
      }
    }
    if (!this.guestSsid.has(section)) {
      this.guestSsid.set(section, await this.uciOption(section, 'ssid').catch(() => null));
    }
    return {
      section,
      found: true,
      enabled: !['1', 'true', 'yes', 'on'].includes(String(disabled ?? '0').toLowerCase()),
      ssid: this.guestSsid.get(section),
      radio,
    };
  }

  /**
   * Enable or disable the guest Wi-Fi: `uci set` then `uci commit`, which
   * makes procd reload the network (and the Wi-Fi) like LuCI's Save & Apply
   * without the rollback.
   */
  async setGuest(section, enabled) {
    await this.call('uci', 'set', {
      config: 'wireless',
      section,
      values: { disabled: enabled ? '0' : '1' },
    });
    await this.call('uci', 'commit', { config: 'wireless' });
  }

  async reboot({ timeoutMs } = {}) {
    await this.call('system', 'reboot', {}, { timeoutMs });
  }

  close() {
    return this.client.close();
  }
}

export class LuciBackend {
  constructor(client) {
    this.kind = 'luci';
    this.client = client;
    this.neighbourReader = null;
  }

  call(library, method, params) {
    return this.client.call(library, method, params);
  }

  async identity() {
    const hostname = await this.call('sys', 'hostname').catch((err) => {
      if (!optionalError(err)) {
        throw err;
      }
      return null;
    });
    let mac = null;
    for (const device of ['eth0', 'br-lan']) {
      try {
        const link = await this.call('ip', 'link', [device]);
        mac = parseDevices({ [device]: { macaddr: link?.mac } }).get(device).mac;
      } catch (err) {
        if (!optionalError(err)) {
          throw err;
        }
      }
      if (mac) {
        break;
      }
    }
    return {
      mac,
      hostname: typeof hostname === 'string' ? hostname : null,
      model: null,
      boardName: null,
      kernel: null,
      distribution: 'OpenWrt',
      version: null,
      revision: null,
      target: null,
      description: null,
    };
  }

  async read() {
    const gaps = new Gaps();
    const uptime = Number(await this.call('sys', 'uptime'));
    const all = await this.readNeighbours(gaps);
    // The WAN side (the ISP box) is in the neighbour table too: when the LAN
    // is a bridge, as on every default OpenWrt, only its neighbours count.
    const bridged = all.filter((entry) => entry.interface?.startsWith('br-'));
    const neighbours = bridged.length > 0 ? bridged : all;
    const names = parseStaticHosts(
      await gaps.soft('uci get_all dhcp', this.call('uci', 'get_all', ['dhcp']), {}),
    );
    return {
      system: {
        uptimeSeconds: Number.isFinite(uptime) ? uptime : null,
        load1: null,
        load5: null,
        load15: null,
        memoryUsage: null,
        memoryTotalBytes: null,
      },
      interfaces: [],
      devices: new Map(),
      radios: [],
      stations: [],
      leases: [],
      neighbours,
      names,
      guest: null,
      gaps: gaps.list,
    };
  }

  /** `ip.neighbors` (LuCI 18.06+), else `sys.net.arptable` (older LuCI). */
  async readNeighbours(gaps) {
    const tries =
      this.neighbourReader === null
        ? ['ip', 'arptable']
        : this.neighbourReader
          ? [this.neighbourReader]
          : [];
    let lastError = null;
    for (const reader of tries) {
      try {
        const list =
          reader === 'ip'
            ? await this.call('ip', 'neighbors', [{ family: 4 }])
            : await this.call('sys', 'net.arptable');
        this.neighbourReader = reader;
        return parseNeighbors(list);
      } catch (err) {
        if (!optionalError(err)) {
          throw err;
        }
        lastError = err;
      }
    }
    if (lastError) {
      this.neighbourReader = false;
      gaps.list.push({ what: 'ip.neighbors', kind: lastError.kind });
    }
    return [];
  }

  async setGuest() {
    throw new OpenwrtError(ERROR_KINDS.NOT_FOUND, 'LuCI RPC: the guest Wi-Fi needs ubus');
  }

  async reboot() {
    await this.call('sys', 'reboot');
  }

  close() {
    return this.client.close();
  }
}
