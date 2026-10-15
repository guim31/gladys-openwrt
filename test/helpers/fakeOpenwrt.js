// -----------------------------------------------------------------------------
// An in-memory OpenWrt device for the tests: the ubus JSON-RPC endpoint of
// uhttpd-mod-ubus (/ubus) with rpcd sessions and ACLs, and the LuCI RPC API of
// luci-mod-rpc (/cgi-bin/luci/rpc/*), served from the fixtures of
// test/fixtures/openwrt/. It answers like the real code paths of uhttpd
// (ubus.c: -32000 object not found, -32002 access denied) and rpcd
// (session.c: a refused login is status 6; uci.c: the config ACL is status 6).
//
// `createNetwork({ host: device })` gives the `request` seam of
// src/openwrt/http.js, with the socket errors a real network raises.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const fixture = (name) =>
  JSON.parse(readFileSync(new URL(`../fixtures/openwrt/${name}.json`, import.meta.url), 'utf8'));

// The rpcd ACL of the documentation (docs/en.md): the read part, and the
// write part for the commands.
export const READ_ACL = [
  'system board',
  'system info',
  'network.interface dump',
  'network.device status',
  'network.wireless status',
  'hostapd.* get_clients',
  'iwinfo assoclist',
  'luci-rpc getDHCPLeases',
  'file read',
  'uci get',
];
export const WRITE_ACL = ['system reboot', 'uci set', 'uci commit'];

const NULL_SESSION = '00000000000000000000000000000000';
const SESSION_TIMEOUT_MS = 300_000;

const json = (status, body, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const globMatch = (pattern, value) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(value);

export class FakeOpenwrt {
  /**
   * @param {object} [options]
   * @param {string} [options.fixture] a file of test/fixtures/openwrt/
   * @param {Record<string, { password: string, acl?: string[], uciRead?: string[], uciWrite?: string[] }>} [options.users]
   * @param {boolean} [options.ubus] serve /ubus (uhttpd-mod-ubus installed)
   * @param {boolean} [options.luci] serve the LuCI RPC API (luci-mod-rpc installed)
   * @param {boolean} [options.https] serve HTTPS (a self-signed certificate unless `trusted`)
   * @param {boolean} [options.http] serve plain HTTP
   * @param {boolean} [options.redirectHttps] plain HTTP answers 301 to HTTPS (uhttpd `redirect_https`)
   * @param {boolean} [options.trusted] the HTTPS certificate verifies
   * @param {() => number} [options.now]
   */
  constructor({
    fixture: name = 'openwrt-23.05-e8450',
    users = {
      gladys: {
        password: 'secret',
        acl: [...READ_ACL, ...WRITE_ACL],
        uciRead: ['wireless'],
        uciWrite: ['wireless'],
      },
    },
    ubus = true,
    luci = false,
    https = false,
    http = true,
    redirectHttps = false,
    trusted = false,
    now = () => Date.now(),
  } = {}) {
    const data = fixture(name);
    this.ubusData = structuredClone(data.ubus ?? {});
    this.luciData = structuredClone(data.luci ?? {});
    this.uci = structuredClone(data.uci ?? {});
    this.users = users;
    this.serveUbus = ubus && Boolean(data.ubus);
    this.serveLuci = luci || !data.ubus;
    this.https = https;
    this.http = http;
    this.redirectHttps = redirectHttps;
    this.trusted = trusted;
    this.now = now;
    this.offline = false;
    /** token → { user, last, staged: { config: { section: values } } } */
    this.sessions = new Map();
    this.luciTokens = new Set();
    this.logins = { ok: 0, failed: 0 };
    /** Every ubus call that reached an object: { object, method, args }. */
    this.calls = [];
    this.requests = [];
  }

  // --- Test controls ----------------------------------------------------------------

  goOffline() {
    this.offline = true;
  }

  goOnline() {
    this.offline = false;
  }

  /** rpcd forgets every session (a reboot, or 300 s without use). */
  expireSessions() {
    this.sessions.clear();
    this.luciTokens.clear();
  }

  /** A station joins an access point (lowercase in hostapd, uppercase in iwinfo). */
  associate(mac, ifname = 'phy0-ap0', { authorized = true } = {}) {
    const hostapd = this.ubusData[`hostapd.${ifname} get_clients`];
    if (hostapd) {
      hostapd.clients[mac.toLowerCase()] = { auth: true, assoc: true, authorized, signal: -60 };
      return;
    }
    const assoc = this.ubusData['iwinfo assoclist']?.[ifname];
    if (assoc) {
      assoc.results.push({ mac: mac.toUpperCase(), signal: -60, authorized });
      return;
    }
    throw new Error(`No access point ${ifname} in the fixture`);
  }

  dissociate(mac) {
    for (const [key, value] of Object.entries(this.ubusData)) {
      if (key.startsWith('hostapd.')) {
        delete value.clients[mac.toLowerCase()];
      }
    }
    for (const list of Object.values(this.ubusData['iwinfo assoclist'] ?? {})) {
      list.results = list.results.filter((item) => item.mac.toUpperCase() !== mac.toUpperCase());
    }
  }

  addLease(mac, ip, hostname) {
    this.ubusData['luci-rpc getDHCPLeases'].dhcp_leases.push({
      expires: 43200,
      hostname,
      macaddr: mac.toUpperCase(),
      ipaddr: ip,
    });
  }

  removeLease(mac) {
    const leases = this.ubusData['luci-rpc getDHCPLeases'];
    leases.dhcp_leases = leases.dhcp_leases.filter(
      (lease) => lease.macaddr.toUpperCase() !== mac.toUpperCase(),
    );
  }

  /** A logical interface up or down (netifd), its default route with it. */
  setInterfaceUp(name, up) {
    const item = this.ubusData['network.interface dump'].interface.find(
      (i) => i.interface === name,
    );
    item.up = up;
    if (!up) {
      item.savedRoute ??= item.route;
      item.route = [];
    } else if (item.savedRoute) {
      item.route = item.savedRoute;
      delete item.savedRoute;
    }
  }

  /** Bytes through a device since the last reading. */
  traffic(device, rxBytes, txBytes) {
    const stats = this.ubusData['network.device status'][device].statistics;
    stats.rx_bytes += rxBytes;
    stats.tx_bytes += txBytes;
  }

  setLoad(load1) {
    this.ubusData['system info'].load[0] = Math.round(load1 * 65536);
  }

  // --- The network ----------------------------------------------------------------------

  /**
   * One HTTP request, as uhttpd would answer it.
   * @returns {{ status, headers, body }}
   */
  handle(url, { method = 'GET', json: body } = {}) {
    const target = new URL(url);
    this.requests.push({ path: target.pathname, method });
    if (target.protocol === 'http:' && this.redirectHttps) {
      return {
        status: 301,
        headers: { location: `https://${target.host}${target.pathname}` },
        body: '',
      };
    }
    if (target.pathname === '/ubus') {
      if (!this.serveUbus) {
        return {
          status: 404,
          headers: { 'content-type': 'text/html' },
          body: '<h1>Not Found</h1>',
        };
      }
      return this.ubus(body);
    }
    if (target.pathname.startsWith('/cgi-bin/luci/rpc/')) {
      if (!this.serveLuci) {
        return { status: 404, headers: { 'content-type': 'text/html' }, body: 'Not Found' };
      }
      return this.luci(target, body);
    }
    return { status: 404, headers: { 'content-type': 'text/html' }, body: 'Not Found' };
  }

  // --- ubus (uhttpd-mod-ubus + rpcd) -------------------------------------------------------

  ubus(body) {
    if (!body || body.jsonrpc !== '2.0' || body.method !== 'call' || !Array.isArray(body.params)) {
      return json(200, {
        jsonrpc: '2.0',
        id: body?.id ?? null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
    const [sid, object, method, args = {}] = body.params;
    const reply = (result) => json(200, { jsonrpc: '2.0', id: body.id, result });
    const error = (code, message) =>
      json(200, { jsonrpc: '2.0', id: body.id, error: { code, message } });

    if (object === 'session' && method === 'login') {
      if (sid !== NULL_SESSION) {
        return error(-32002, 'Access denied');
      }
      const user = this.users[args.username];
      if (!user || user.password !== args.password) {
        this.logins.failed += 1;
        return reply([6]);
      }
      this.logins.ok += 1;
      const token = randomBytes(16).toString('hex');
      this.sessions.set(token, { user: args.username, last: this.now(), staged: {} });
      return reply([
        0,
        {
          ubus_rpc_session: token,
          timeout: 300,
          expires: 300,
          acls: {},
          data: { username: args.username },
        },
      ]);
    }
    if (!this.objectExists(object)) {
      return error(-32000, 'Object not found');
    }
    const session = this.sessions.get(sid);
    if (!session || this.now() - session.last > SESSION_TIMEOUT_MS) {
      this.sessions.delete(sid);
      return error(-32002, 'Access denied');
    }
    const user = this.users[session.user];
    if (!(user.acl ?? []).some((rule) => globMatch(rule, `${object} ${method}`))) {
      return error(-32002, 'Access denied');
    }
    session.last = this.now();
    this.calls.push({ object, method, args });
    return reply(this.invoke(object, method, args, session, user));
  }

  objectExists(object) {
    if (
      [
        'system',
        'network.interface',
        'network.device',
        'network.wireless',
        'uci',
        'file',
        'session',
      ].includes(object)
    ) {
      return true;
    }
    if (object === 'iwinfo') {
      return Boolean(this.ubusData['iwinfo assoclist']);
    }
    if (object === 'luci-rpc') {
      return Boolean(this.ubusData['luci-rpc getDHCPLeases']);
    }
    if (object.startsWith('hostapd.')) {
      // A disabled wifi-iface has no hostapd object.
      const ifname = object.slice('hostapd.'.length);
      return Boolean(this.ubusData[`${object} get_clients`]) && this.ifaceEnabled(ifname);
    }
    return false;
  }

  ifaceEnabled(ifname) {
    for (const radio of Object.values(this.ubusData['network.wireless status'] ?? {})) {
      for (const iface of radio.interfaces ?? []) {
        if (iface.ifname === ifname) {
          return this.uci.wireless?.[iface.section]?.disabled !== '1';
        }
      }
    }
    return true;
  }

  /** The `network.wireless status` of the current configuration: disabled sections are not listed. */
  wirelessStatus() {
    const status = structuredClone(this.ubusData['network.wireless status'] ?? {});
    for (const radio of Object.values(status)) {
      radio.interfaces = (radio.interfaces ?? []).filter(
        (iface) => this.uci.wireless?.[iface.section]?.disabled !== '1',
      );
    }
    return status;
  }

  invoke(object, method, args, session, user) {
    const key = `${object} ${method}`;
    if (object === 'network.wireless' && method === 'status') {
      return [0, this.wirelessStatus()];
    }
    if (key === 'system reboot') {
      this.rebooted = true;
      this.expireSessions();
      return [0];
    }
    if (key === 'iwinfo assoclist') {
      const list = this.ubusData['iwinfo assoclist'][args.device];
      return list ? [0, list] : [4];
    }
    if (key === 'file read') {
      const content = this.ubusData['file read']?.[args.path];
      return content === undefined ? [4] : [0, { data: content }];
    }
    if (object === 'uci') {
      return this.uciCall(method, args, session, user);
    }
    if (key in this.ubusData) {
      return [0, structuredClone(this.ubusData[key])];
    }
    return [3]; // UBUS_STATUS_METHOD_NOT_FOUND
  }

  uciCall(method, args, session, user) {
    const config = args.config;
    if (method === 'get') {
      if (!(user.uciRead ?? []).includes(config)) {
        return [6];
      }
      const section = this.uci[config]?.[args.section];
      if (!section) {
        return [4];
      }
      if (args.option) {
        const value = section[args.option];
        return value === undefined ? [4] : [0, { value }];
      }
      return [0, { values: structuredClone(section) }];
    }
    if (method === 'set') {
      if (!(user.uciWrite ?? []).includes(config)) {
        return [6];
      }
      if (!this.uci[config]?.[args.section]) {
        return [4];
      }
      session.staged[config] ??= {};
      session.staged[config][args.section] = {
        ...session.staged[config][args.section],
        ...args.values,
      };
      return [0];
    }
    if (method === 'commit') {
      if (!(user.uciWrite ?? []).includes(config)) {
        return [6];
      }
      for (const [section, values] of Object.entries(session.staged[config] ?? {})) {
        Object.assign(this.uci[config][section], values);
      }
      delete session.staged[config];
      this.commits = (this.commits ?? 0) + 1;
      return [0];
    }
    return [3];
  }

  // --- LuCI RPC (luci-mod-rpc) ---------------------------------------------------------------

  luci(target, body) {
    const library = target.pathname.slice('/cgi-bin/luci/rpc/'.length);
    const reply = (result) => json(200, { id: body?.id ?? null, result, error: null });
    if (library === 'auth') {
      const [username, password] = body?.params ?? [];
      const user = this.users[username];
      if (body?.method !== 'login' || !user || user.password !== password) {
        this.logins.failed += 1;
        return reply(null);
      }
      this.logins.ok += 1;
      const token = randomBytes(16).toString('hex');
      this.luciTokens.add(token);
      return reply(token);
    }
    const token = target.searchParams.get('auth');
    if (!token || !this.luciTokens.has(token)) {
      return { status: 403, headers: { 'content-type': 'text/plain' }, body: 'Forbidden' };
    }
    const key = `${library} ${body.method}`;
    this.calls.push({ object: library, method: body.method, args: body.params });
    if (key === 'sys reboot') {
      this.rebooted = true;
      this.expireSessions();
      return reply(null);
    }
    if (key === 'ip link') {
      const link = this.luciData['ip link']?.[body.params?.[0]];
      return reply(link ?? null);
    }
    if (key === 'uci get_all') {
      return reply(this.luciData['uci get_all']?.[body.params?.[0]] ?? null);
    }
    if (key in this.luciData) {
      return reply(structuredClone(this.luciData[key]));
    }
    return json(200, {
      id: body.id,
      result: null,
      error: { code: -32601, message: 'Method not found.' },
    });
  }
}

/**
 * The `request` seam of src/openwrt/http.js over fake devices, by host.
 * @param {Record<string, FakeOpenwrt>} devices
 */
export function createNetwork(devices) {
  const fail = (code, message = code) => {
    const error = new Error(message);
    error.code = code;
    return error;
  };
  return {
    async request(url, options = {}) {
      const target = new URL(url);
      const device = devices[target.hostname.replace(/^\[(.*)\]$/, '$1')];
      if (!device) {
        throw fail('EHOSTUNREACH');
      }
      if (device.offline) {
        throw fail('ETIMEDOUT');
      }
      if (target.protocol === 'https:') {
        if (!device.https) {
          throw fail('ECONNREFUSED');
        }
        if (!device.trusted && !options.insecure) {
          throw fail('DEPTH_ZERO_SELF_SIGNED_CERT', 'self-signed certificate');
        }
      } else if (!device.http) {
        throw fail('ECONNREFUSED');
      }
      return device.handle(url, options);
    },
  };
}
