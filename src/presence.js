// -----------------------------------------------------------------------------
// Presence of the network clients, from one reading of the router.
//
// A client is *seen* when it is associated and authorized on one of the
// router's access points right now (hostapd, or iwinfo), when the user
// enables it, when it holds a DHCP lease, and, with the LuCI RPC fallback,
// when its neighbour entry is reachable. A seen client is present at once; a
// client no longer seen becomes away only once the departure delay has
// passed since it was last seen: a phone asleep drops off the Wi-Fi for a
// few minutes without leaving home.
//
// When the router cannot be read, nothing changes: an outage of the router
// never sends the whole household away. (Adapted from guim31/gladys-mikrotik.)
// -----------------------------------------------------------------------------

export const SOURCES = Object.freeze({
  WIFI: 'wifi',
  DHCP: 'dhcp',
  ARP: 'arp',
});

/**
 * The clients a reading shows, by MAC address, with what each source says.
 * @param {object} reading { stations, leases, neighbours, names }
 * @param {object} options { dhcp: boolean, ignore: Set<string> MACs of the router itself }
 * @returns {Map<string, { mac, ip, hostName, ssid, ifname, seen: boolean, sources: string[] }>}
 */
export function collectClients(reading, { dhcp = false, ignore = new Set() } = {}) {
  const clients = new Map();
  const entry = (mac) => {
    let client = clients.get(mac);
    if (!client) {
      client = {
        mac,
        ip: null,
        hostName: null,
        ssid: null,
        ifname: null,
        seen: false,
        sources: [],
      };
      clients.set(mac, client);
    }
    return client;
  };
  const mark = (client, source) => {
    client.seen = true;
    if (!client.sources.includes(source)) {
      client.sources.push(source);
    }
  };

  for (const lease of [...(reading.leases ?? []), ...(reading.names ?? [])]) {
    if (ignore.has(lease.mac)) {
      continue;
    }
    const client = entry(lease.mac);
    client.ip ??= lease.ip;
    client.hostName ??= lease.hostName;
  }
  if (dhcp) {
    for (const lease of reading.leases ?? []) {
      if (!ignore.has(lease.mac)) {
        mark(entry(lease.mac), SOURCES.DHCP);
      }
    }
  }
  for (const station of reading.stations ?? []) {
    // A station still in the WPA handshake (wrong password) is not home.
    if (ignore.has(station.mac) || !station.authorized) {
      continue;
    }
    const client = entry(station.mac);
    client.ssid ??= station.ssid;
    client.ifname ??= station.ifname;
    mark(client, SOURCES.WIFI);
  }
  for (const neighbour of reading.neighbours ?? []) {
    if (ignore.has(neighbour.mac)) {
      continue;
    }
    const client = entry(neighbour.mac);
    client.ip ??= neighbour.ip;
    if (neighbour.reachable) {
      mark(client, SOURCES.ARP);
    }
  }
  return clients;
}

export class PresenceTracker {
  /**
   * @param {object} options
   * @param {number} options.awayDelayMs
   * @param {() => number} options.now
   */
  constructor({ awayDelayMs, now }) {
    this.awayDelayMs = awayDelayMs;
    this.now = now;
    this.startedAt = now();
    /** @type {Map<string, { present: 0|1|null, lastSeen: number|null, since: number|null }>} */
    this.records = new Map();
  }

  record(mac) {
    let record = this.records.get(mac);
    if (!record) {
      record = { present: null, lastSeen: null, since: null };
      this.records.set(mac, record);
    }
    return record;
  }

  /**
   * Apply one successful reading to the followed clients.
   * @param {string[]} followed MAC addresses of the clients added to Gladys
   * @param {Map<string, { seen: boolean }>} clients collectClients()
   * @returns {string[]} the MAC addresses whose presence changed
   */
  update(followed, clients) {
    const now = this.now();
    const changed = [];
    for (const mac of followed) {
      const record = this.record(mac);
      const before = record.present;
      if (clients.get(mac)?.seen) {
        record.lastSeen = now;
        record.present = 1;
      } else {
        // Never seen since the start: the delay counts from the start.
        const lastSeen = record.lastSeen ?? this.startedAt;
        if (record.present !== 0 && now - lastSeen >= this.awayDelayMs) {
          record.present = 0;
        }
      }
      if (record.present !== before) {
        record.since = now;
        changed.push(mac);
      }
    }
    return changed;
  }

  /** 1, 0, or null while unknown (not seen since the start, delay not over). */
  presence(mac) {
    return this.records.get(mac)?.present ?? null;
  }

  get(mac) {
    return this.records.get(mac) ?? null;
  }
}
