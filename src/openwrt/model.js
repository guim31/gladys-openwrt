// -----------------------------------------------------------------------------
// Readers of the OpenWrt answers: they turn the raw data of ubus (and of the
// LuCI RPC fallback) into the few plain values the integration uses, and
// never keep anything else — `network.wireless status` carries the Wi-Fi keys
// in its `config`, which never leave this file.
//
// Formats checked in the sources: procd (system board/info), netifd
// (network.interface dump, network.device status, wireless status), hostapd
// (ubus.c, get_clients), rpcd (iwinfo.c, file.c), rpcd-mod-luci (luci.c,
// getDHCPLeases), dnsmasq (lease file), luci-lib-ip (neighbors).
// -----------------------------------------------------------------------------

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const number = (value) => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
};

/** `aa:bb:cc:dd:ee:ff`, `AA-BB-…`, `aabbccddeeff` → `AA:BB:CC:DD:EE:FF`, else null. */
export function normalizeMac(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const hex = raw.trim().replace(/[:\-.]/g, '');
  if (!/^[0-9a-f]{12}$/i.test(hex) || /^0{12}$/.test(hex)) {
    return null;
  }
  return hex.toUpperCase().match(/../g).join(':');
}

/** `system board` (procd). */
export function parseBoard(data) {
  const board = isObject(data) ? data : {};
  const release = isObject(board.release) ? board.release : {};
  return {
    hostname: text(board.hostname),
    model: text(board.model),
    boardName: text(board.board_name),
    kernel: text(board.kernel),
    distribution: text(release.distribution),
    version: text(release.version),
    revision: text(release.revision),
    target: text(release.target),
    description: text(release.description),
  };
}

/** `system info` (procd): the load averages are fixed-point, 65536 = 1.00. */
export function parseInfo(data) {
  const info = isObject(data) ? data : {};
  const load = Array.isArray(info.load) ? info.load.map((value) => number(value)) : [];
  const toLoad = (value) => (value === null || value === undefined ? null : value / 65536);
  const memory = isObject(info.memory) ? info.memory : {};
  const total = number(memory.total);
  // `available` (OpenWrt 21.02+) counts the reclaimable cache; older releases
  // only give free, buffered and cached.
  let used = null;
  if (total && total > 0) {
    const available = number(memory.available);
    const free = number(memory.free);
    if (available !== null) {
      used = total - available;
    } else if (free !== null) {
      used = total - free - (number(memory.buffered) ?? 0) - (number(memory.cached) ?? 0);
    }
  }
  const load1 = toLoad(load[0]);
  return {
    uptimeSeconds: number(info.uptime),
    load1,
    load5: toLoad(load[1]),
    load15: toLoad(load[2]),
    memoryUsage:
      used === null ? null : Math.max(0, Math.min(100, Math.round((used / total) * 100))),
    memoryTotalBytes: total,
  };
}

const isDefaultRoute = (route) =>
  isObject(route) && Number(route.mask) === 0 && ['0.0.0.0', '::'].includes(route.target);

/** `network.interface dump` (netifd): the logical interfaces (wan, lan, wan6…). */
export function parseInterfaces(data) {
  const list = Array.isArray(data?.interface) ? data.interface : [];
  return list
    .filter((item) => isObject(item) && text(item.interface))
    .map((item) => {
      const routes = Array.isArray(item.route) ? item.route : [];
      return {
        name: item.interface,
        up: item.up === true,
        available: item.available !== false,
        proto: text(item.proto),
        device: text(item.device),
        l3Device: text(item.l3_device),
        uptimeSeconds: number(item.uptime),
        defaultRoute4: routes.some((route) => isDefaultRoute(route) && route.target === '0.0.0.0'),
        defaultRoute6: routes.some((route) => isDefaultRoute(route) && route.target === '::'),
      };
    });
}

/** `network.device status` without a name (netifd): every device, by name. */
export function parseDevices(data) {
  const devices = new Map();
  if (!isObject(data)) {
    return devices;
  }
  for (const [name, device] of Object.entries(data)) {
    if (!isObject(device)) {
      continue;
    }
    const statistics = isObject(device.statistics) ? device.statistics : {};
    devices.set(name, {
      name,
      type: text(device.type),
      devtype: text(device.devtype),
      present: device.present !== false,
      up: device.up === true,
      carrier: typeof device.carrier === 'boolean' ? device.carrier : null,
      mac: normalizeMac(device.macaddr),
      rxBytes: number(statistics.rx_bytes),
      txBytes: number(statistics.tx_bytes),
    });
  }
  return devices;
}

const BANDS = { '2g': '2.4 GHz', '5g': '5 GHz', '6g': '6 GHz', '60g': '60 GHz' };

/** The band of a radio, from `band` (21.02+), `hwmode` (older) or the channel. */
export function radioBand(config = {}) {
  if (BANDS[config.band]) {
    return BANDS[config.band];
  }
  if (config.hwmode === '11a' || config.hwmode === '11ac') {
    return '5 GHz';
  }
  if (['11b', '11g'].includes(config.hwmode)) {
    return '2.4 GHz';
  }
  const channel = number(config.channel);
  if (channel !== null && channel > 0) {
    return channel <= 14 ? '2.4 GHz' : '5 GHz';
  }
  return null;
}

/**
 * `network.wireless status` (netifd): the radios and their enabled
 * interfaces (a disabled wifi-iface section is not listed at all). Only the
 * names, SSIDs and modes are kept: never the `key` of the config.
 */
export function parseWireless(data) {
  if (!isObject(data)) {
    return [];
  }
  return Object.entries(data)
    .filter(([, radio]) => isObject(radio))
    .map(([name, radio]) => {
      const config = isObject(radio.config) ? radio.config : {};
      const interfaces = Array.isArray(radio.interfaces) ? radio.interfaces : [];
      return {
        name,
        band: radioBand(config),
        up: radio.up === true,
        disabled: radio.disabled === true,
        ifaces: interfaces
          .filter((iface) => isObject(iface))
          .map((iface) => {
            const ifaceConfig = isObject(iface.config) ? iface.config : {};
            return {
              section: text(iface.section),
              ifname: text(iface.ifname),
              ssid: text(ifaceConfig.ssid),
              mode: text(ifaceConfig.mode) ?? 'ap',
              network: Array.isArray(ifaceConfig.network)
                ? ifaceConfig.network.filter((item) => typeof item === 'string')
                : typeof ifaceConfig.network === 'string'
                  ? ifaceConfig.network.split(/\s+/).filter(Boolean)
                  : [],
            };
          }),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** `hostapd.<ifname> get_clients`: the stations of one access point, by MAC. */
export function parseHostapdClients(data) {
  const clients = isObject(data?.clients) ? data.clients : {};
  const result = [];
  for (const [rawMac, client] of Object.entries(clients)) {
    const mac = normalizeMac(rawMac);
    if (!mac || !isObject(client)) {
      continue;
    }
    result.push({
      mac,
      // A station still in the WPA handshake (or refused) is not authorized.
      authorized: client.authorized === true,
      signal: number(client.signal),
    });
  }
  return result;
}

/** `iwinfo assoclist` (rpcd-mod-iwinfo): the fallback when hostapd has no ubus object. */
export function parseAssoclist(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  const result = [];
  for (const station of results) {
    const mac = normalizeMac(station?.mac);
    if (!mac) {
      continue;
    }
    result.push({
      mac,
      // Older rpcd versions do not report it: an associated station counts.
      authorized: station.authorized !== false,
      signal: number(station.signal),
    });
  }
  return result;
}

const cleanHostName = (name) => {
  const value = text(name);
  return value && value !== '*' && value !== '-' ? value.slice(0, 63) : null;
};

/** `luci-rpc getDHCPLeases` (rpcd-mod-luci): the IPv4 leases, `expires` in seconds left. */
export function parseDhcpLeases(data) {
  const leases = Array.isArray(data?.dhcp_leases) ? data.dhcp_leases : [];
  const result = [];
  for (const lease of leases) {
    const mac = normalizeMac(lease?.macaddr);
    if (!mac) {
      continue;
    }
    result.push({
      mac,
      ip: text(lease.ipaddr),
      hostName: cleanHostName(lease.hostname),
    });
  }
  return result;
}

/**
 * The dnsmasq lease file (`/tmp/dhcp.leases`), read with `file read`:
 * `<expiry epoch|0> <mac> <ip> <hostname|*> <client id|*>` per line.
 * dnsmasq removes the line when the lease ends, so every line is a lease in
 * use; its expiry is not compared with our clock (the router's may differ).
 * @param {string} content
 */
export function parseLeaseFile(content) {
  if (typeof content !== 'string') {
    return [];
  }
  const result = [];
  for (const line of content.split('\n')) {
    const [, rawMac, ip, hostName] = line.trim().split(/\s+/);
    const mac = normalizeMac(rawMac);
    if (!mac) {
      continue;
    }
    result.push({ mac, ip: text(ip), hostName: cleanHostName(hostName) });
  }
  return result;
}

/**
 * The neighbour table of the LuCI RPC fallback: `ip.neighbors({ family: 4 })`
 * (18.06+: `dest`, `mac`, `dev`, `reachable`, `stale`) or the older
 * `sys.net.arptable()` (`IP address`, `HW address`, `Flags`, `Device`).
 */
export function parseNeighbors(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const result = [];
  for (const entry of list) {
    if (!isObject(entry)) {
      continue;
    }
    const mac = normalizeMac(entry.mac ?? entry['HW address']);
    if (!mac) {
      continue;
    }
    let reachable;
    if ('reachable' in entry || 'stale' in entry) {
      reachable = entry.reachable === true;
    } else {
      // NUD flags of /proc/net/arp: 0x2 is a complete entry.
      reachable = (parseInt(entry.Flags ?? '0', 16) & 0x2) === 0x2;
    }
    result.push({
      mac,
      ip: text(entry.dest ?? entry['IP address']),
      interface: text(entry.dev ?? entry.Device),
      reachable,
    });
  }
  return result;
}

/** The static leases of `uci.get_all("dhcp")` (LuCI RPC fallback): names for the MACs. */
export function parseStaticHosts(config) {
  if (!isObject(config)) {
    return [];
  }
  const result = [];
  for (const section of Object.values(config)) {
    if (!isObject(section) || section['.type'] !== 'host') {
      continue;
    }
    const macs = Array.isArray(section.mac) ? section.mac : String(section.mac ?? '').split(/\s+/);
    for (const raw of macs) {
      const mac = normalizeMac(raw);
      if (mac) {
        result.push({ mac, ip: text(section.ip), hostName: cleanHostName(section.name) });
      }
    }
  }
  return result;
}
