// -----------------------------------------------------------------------------
// The OpenWrt hub: one session on the router, read on a timer of the
// container (the interval chosen in the configuration), its states published
// to Gladys when they change, its scene events fired on transitions, and the
// commands (guest Wi-Fi, reboot) of the scene actions and the widgets.
//
// Gladys never polls these devices (should_poll: false): Gladys 5.2 does not
// reliably poll external devices (GladysAssistant/Gladys#3198), and the scene
// events must fire even for a router whose device was not added.
// (Adapted from guim31/gladys-mikrotik.)
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import {
  DEVICE_TYPES,
  FEATURE_KEYS,
  WAN_FEATURES,
  buildClientDevice,
  buildRouterDevice,
  clientIds,
  paramOf,
  parseDeviceId,
  radioFeatureKey,
  radioLabels,
  routerIds,
  routerName,
  slugify,
  slugs,
  wanFeatureKey,
} from './devices.js';
import { PresenceTracker, SOURCES, collectClients } from './presence.js';
import { API_LABELS, openSession } from './openwrt/client.js';
import { ERROR_KINDS, OpenwrtError } from './openwrt/errors.js';
import { normalizeMac } from './openwrt/model.js';
import {
  ACTION_TEXT,
  CONNECTION_TEXT,
  ERROR_TEXT,
  NETWORKS_TEXT,
  REPORT_TEXT,
  labelled,
  pick,
} from './texts.js';

const logger = createLogger({ name: 'openwrt-hub' });

export const WIDGET_KEYS = Object.freeze({
  ROUTER: 'router',
  PRESENCE: 'presence',
});

// Scene trigger keys (manifest `scene_triggers`): permanent once published.
export const TRIGGERS = Object.freeze({
  UNKNOWN_DEVICE: 'unknown_device_connected',
  WAN_DOWN: 'wan_down',
  WAN_UP: 'wan_up',
});

export const HUB_TIMINGS = {
  // The discovery list follows the clients seen, at most this often.
  discoveryMs: 5 * 60_000,
  // A refused password is tried again this late, not at every reading: each
  // try is a failed login in the router log.
  authRetryMs: 5 * 60_000,
  // A present client is published again this often: the "Check presence"
  // scene action of Gladys reads the date of the last value received.
  presentRefreshMs: 2 * 60_000,
  // Any other unchanged value is published again this often, so Gladys never
  // shows it as "no recent value".
  heartbeatMs: 6 * 60 * 60_000,
  // A client seen this long ago leaves the discovery list.
  clientMemoryMs: 7 * 24 * 60 * 60_000,
  // A reboot answers before restarting, or hangs up: never wait long.
  commandTimeoutMs: 15_000,
};

const MAX_STATES_PER_REQUEST = 100;
const MAX_DISCOVERED_CLIENTS = 250;
const MAX_KNOWN_MACS = 5000;
const MAX_WAN = 4;
// "Unknown device connected" events per reading at most: a reset of the
// router or a new guest network never floods the scenes.
const MAX_UNKNOWN_EVENTS = 5;

const sessionSignature = (config) =>
  JSON.stringify([
    config.host,
    config.port,
    config.https,
    config.username,
    config.password,
    config.api,
    config.allowSelfSigned,
  ]);

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export class OpenwrtHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake Gladys)
   * @param {object} options.store persistence (src/store.js)
   * @param {object} [options.seams] { request, timeoutMs } network seams (tests)
   * @param {boolean} [options.timers] periodic timer (off in tests)
   * @param {object} [options.timings] HUB_TIMINGS overrides
   * @param {() => number} [options.now]
   */
  constructor({ gladys, store, seams = {}, timers = true, timings, now }) {
    this.gladys = gladys;
    this.store = store;
    this.seams = seams;
    this.timersEnabled = timers;
    this.timings = { ...HUB_TIMINGS, ...timings };
    this.now = now ?? (() => Date.now());
    this.config = null;
    this.session = null;
    this.signature = null;
    this.attempts = [];
    this.router = null;
    this.resetReading();
    this.saved = { knownMacs: {}, baselined: false };
    /** Last value published per feature external id: { key, at }. */
    this.published = new Map();
    this.transports = new Map();
    this.connection = null;
    this.discoveryKey = null;
    this.discoveryAt = 0;
    this.pollTimer = null;
    this.polling = null;
    this.stopped = false;
    /** Problems already logged, by key: repeats go to debug. */
    this.warned = new Set();
  }

  /** Forget what was read from the router (a new router, new credentials). */
  resetReading() {
    this.snapshot = {
      reachable: null,
      error: null,
      system: null,
      wan: new Map(),
      radios: new Map(),
      guest: null,
      counts: { wifi: 0, leases: 0, neighbours: 0 },
      gaps: [],
    };
    this.counters = new Map();
    this.wanDownSince = new Map();
    this.autoWan = [];
    this.clients = new Map();
    this.lastClients = new Map();
    this.retryAfter = 0;
    this.presence = new PresenceTracker({
      awayDelayMs: this.config?.awayDelayMs ?? 0,
      now: () => this.now(),
    });
  }

  // --- Logs ------------------------------------------------------------------
  // Info keeps the lifecycle only (router connected, lost, back, user
  // commands). A problem that repeats every reading is logged once at its own
  // level, then at debug until it clears. LOG_LEVEL=debug shows everything.
  // Never a raw answer of the router: `network.wireless status` carries the
  // Wi-Fi keys.

  problem(key, message, level = 'warn') {
    if (this.warned.has(key)) {
      logger.debug(message);
      return;
    }
    this.warned.add(key);
    logger[level](message);
  }

  resolved(key, message) {
    if (this.warned.delete(key) && message) {
      logger.info(message);
    }
  }

  // --- Lifecycle -------------------------------------------------------------

  async start(config) {
    const saved = await this.store.load();
    this.saved = {
      knownMacs:
        saved.knownMacs && typeof saved.knownMacs === 'object' && !Array.isArray(saved.knownMacs)
          ? saved.knownMacs
          : {},
      baselined: saved.baselined === true,
    };
    await this.reconfigure(config);
  }

  /** Gladys reconnected (it restarted): send everything again. */
  async resync(config) {
    this.published.clear();
    this.transports.clear();
    this.connection = null;
    this.discoveryKey = null;
    await this.reconfigure(config);
  }

  async reconfigure(config) {
    const previous = this.config;
    this.config = config;
    const signature = sessionSignature(config);
    if (signature !== this.signature) {
      this.signature = signature;
      await this.polling?.catch(() => {});
      await this.closeSession();
      if (previous?.host !== config.host) {
        this.router = null;
      }
      this.resetReading();
      this.warned.clear();
    }
    this.presence.awayDelayMs = config.awayDelayMs;
    // The WAN list, the guest Wi-Fi or the names may have changed.
    this.discoveryKey = null;
    await this.pollAll();
    this.schedulePoll();
  }

  async closeSession() {
    const session = this.session;
    this.session = null;
    if (session) {
      await session.backend.close().catch(() => {});
    }
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pollTimer);
    await this.polling?.catch(() => {});
    await this.closeSession();
    await this.store.flush();
  }

  schedulePoll() {
    clearTimeout(this.pollTimer);
    if (!this.timersEnabled || this.stopped || !this.config?.host) {
      return;
    }
    this.pollTimer = setTimeout(async () => {
      try {
        await this.pollAll();
        this.resolved('poll');
      } catch (err) {
        this.problem('poll', `Reading failed: ${err.message}`, 'error');
      }
      this.schedulePoll();
    }, this.config.pollIntervalMs);
  }

  // --- Reading the router ------------------------------------------------------

  /** One reading; concurrent calls share it. */
  pollAll() {
    this.polling ??= this.poll().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  /** Gladys asks for a refresh (onPoll): a reading covers every device. */
  async pollDevice() {
    if (!this.timersEnabled || !this.pollTimer) {
      await this.pollAll();
    }
  }

  async poll() {
    if (!this.config.host) {
      await this.publishConnectionStatus();
      return;
    }
    if (this.now() < this.retryAfter) {
      return;
    }
    let reading;
    try {
      if (!this.session) {
        await this.connect();
      }
      reading = await this.session.backend.read({
        guestSection: this.session.backend.kind === 'ubus' ? this.config.guestSection : null,
      });
      reading.at = this.now();
    } catch (err) {
      if (!(err instanceof OpenwrtError)) {
        throw err;
      }
      await this.applyFailure(err);
      return;
    }
    await this.applyReading(reading);
  }

  sessionOptions() {
    return {
      api: this.config.api,
      host: this.config.host,
      port: this.config.port,
      https: this.config.https,
      insecure: this.config.allowSelfSigned,
      username: this.config.username,
      password: this.config.password,
      request: this.seams.request,
      timeoutMs: this.seams.timeoutMs,
    };
  }

  async connect() {
    let opened;
    try {
      opened = await openSession(this.sessionOptions());
    } catch (err) {
      this.attempts = err.attempts ?? [];
      throw err;
    }
    this.attempts = opened.attempts;
    this.session = { backend: opened.backend, kind: opened.backend.kind, https: opened.https };
    try {
      await this.readIdentity();
    } catch (err) {
      await this.closeSession();
      throw err;
    }
  }

  /** What identifies the router, read once per session. */
  async readIdentity() {
    const identity = await this.session.backend.identity();
    const routerId = identity.mac ? slugify(identity.mac) : `host-${slugify(this.config.host)}`;
    const same = this.router?.id === routerId;
    if (this.router && !same) {
      // Another router at the same address: start over.
      this.resetReading();
    }
    this.router = {
      id: routerId,
      kind: this.session.kind,
      host: this.config.host,
      hostname: identity.hostname,
      model: identity.model,
      version: identity.version,
      revision: identity.revision,
      description: identity.description,
      hasSystem: same ? this.router.hasSystem : false,
      hasVersion: Boolean(identity.version) || (same && this.router.hasVersion),
      guest: false,
      wan: same ? this.router.wan : [],
      wanSource: same ? this.router.wanSource : null,
      radios: same ? this.router.radios : [],
    };
  }

  label() {
    return this.router ? `Router ${routerName(this.router)}` : `Router ${this.config.host}`;
  }

  async applyFailure(err) {
    const wasError = this.snapshot.error?.kind;
    const wasReachable = this.snapshot.reachable;
    this.snapshot.error = { kind: err.kind, message: err.message };
    this.snapshot.reachable = false;
    // One warning when the problem starts (or changes), not one per reading.
    if (wasError !== err.kind) {
      logger.warn(`${this.label()}: ${err.message}`);
    } else {
      logger.debug(`${this.label()}: ${err.message} (again)`);
    }
    if (err.kind === ERROR_KINDS.AUTH || err.kind === ERROR_KINDS.PERMISSION) {
      this.retryAfter = this.now() + this.timings.authRetryMs;
    }
    if (err.kind !== ERROR_KINDS.UNREACHABLE) {
      // A configuration problem: detect the interface again next time.
      await this.closeSession();
    }
    await this.publishTransports();
    await this.publishConnectionStatus();
    if (wasReachable !== false) {
      this.refreshWidgets();
    }
  }

  /** The WAN interfaces: the configured ones, else `wan` and those holding an IPv4 default route. */
  selectWan(interfaces) {
    if (this.config.wanInterfaces.length > 0) {
      return { names: this.config.wanInterfaces, source: 'config' };
    }
    const detected = [];
    if (interfaces.some((item) => item.name === 'wan')) {
      detected.push('wan');
    }
    for (const item of interfaces) {
      if (item.defaultRoute4 && item.name !== 'loopback' && !detected.includes(item.name)) {
        detected.push(item.name);
      }
    }
    // A WAN that lost its default route (down) stays one: the list never flaps.
    for (const name of detected) {
      if (!this.autoWan.includes(name)) {
        this.autoWan.push(name);
      }
    }
    return { names: this.autoWan.slice(0, MAX_WAN), source: 'auto' };
  }

  async applyReading(reading) {
    const now = reading.at;
    const wasError = this.snapshot.error;
    if (wasError || this.snapshot.reachable !== true) {
      if (wasError) {
        logger.info(`${this.label()}: connection restored`);
      } else {
        logger.info(
          `${this.label()}: connected with ${API_LABELS[this.session.kind]}` +
            `${this.session.https ? ' over HTTPS' : ''} (OpenWrt ${this.router.version ?? '?'})`,
        );
      }
    }
    this.snapshot.error = null;
    this.snapshot.reachable = true;
    this.retryAfter = 0;

    // Gaps: what this router or this ACL does not offer. A refusal is worth
    // one warning (the ACL of the documentation was not installed whole).
    for (const gap of reading.gaps) {
      const message = `${this.label()}: ${gap.what} not readable (${gap.kind})`;
      if (gap.kind === ERROR_KINDS.PERMISSION) {
        this.problem(`gap:${gap.what}`, message);
      } else {
        logger.debug(message);
      }
    }
    this.snapshot.gaps = reading.gaps;

    // The structure of the router device: a feature seen once stays.
    if (reading.system.load1 !== null) {
      this.router.hasSystem = true;
    }
    const { names: wanNames, source } = this.selectWan(reading.interfaces);
    this.router.wan = slugs(wanNames);
    this.router.wanSource = wanNames.length ? source : null;
    const radios = new Map(this.router.radios.map((radio) => [radio.name, radio]));
    for (const radio of reading.radios) {
      if (!radio.disabled) {
        radios.set(radio.name, {
          name: radio.name,
          band: radio.band ?? radios.get(radio.name)?.band,
        });
      }
    }
    this.router.radios = radioLabels(
      [...radios.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ).map((radio) => ({ ...radio, slug: slugify(radio.name) }));
    this.router.guest = this.session.kind === 'ubus' && Boolean(this.config.guestSection);

    this.snapshot.system = reading.system;
    const widgetsChanged = new Set();
    await this.applyWan(reading, widgetsChanged);

    const counts = new Map();
    const perRadio = new Map();
    for (const station of reading.stations) {
      if (!station.authorized) {
        continue;
      }
      const set = perRadio.get(station.radio) ?? new Set();
      set.add(station.mac);
      perRadio.set(station.radio, set);
    }
    for (const radio of this.router.radios) {
      const live = reading.radios.find((item) => item.name === radio.name);
      // A radio switched off has no client; one missing from the reading is unknown.
      counts.set(radio.name, live ? (perRadio.get(radio.name)?.size ?? 0) : null);
    }
    this.snapshot.radios = counts;

    const guestBefore = this.snapshot.guest?.enabled;
    this.snapshot.guest = reading.guest;
    if (reading.guest?.enabled !== guestBefore) {
      widgetsChanged.add(WIDGET_KEYS.ROUTER);
    }

    // The router's own interfaces are not clients.
    const ignore = new Set([...reading.devices.values()].map((item) => item.mac).filter(Boolean));
    const clients = collectClients(reading, { dhcp: this.config.presenceDhcp, ignore });
    this.lastClients = clients;
    for (const client of clients.values()) {
      const known = this.clients.get(client.mac);
      this.clients.set(client.mac, {
        ...known,
        ...Object.fromEntries(Object.entries(client).filter(([, value]) => value !== null)),
        lastSeenAt: client.seen ? now : (known?.lastSeenAt ?? null),
        listedAt: now,
      });
    }
    for (const [mac, client] of this.clients) {
      if (now - (client.listedAt ?? 0) > this.timings.clientMemoryMs) {
        this.clients.delete(mac);
      }
    }
    this.snapshot.counts = {
      wifi: new Set(reading.stations.filter((s) => s.authorized).map((s) => s.mac)).size,
      leases: reading.leases.length,
      neighbours: reading.neighbours.filter((entry) => entry.reachable).length,
    };
    if (this.presence.update(this.followedClients(), clients).length > 0) {
      widgetsChanged.add(WIDGET_KEYS.PRESENCE);
    }

    await this.detectUnknownDevices(reading, ignore);
    await this.publishDevices();
    await this.publishStates();
    await this.publishTransports();
    await this.publishConnectionStatus();
    for (const key of widgetsChanged) {
      this.gladys.requestWidgetRefresh(key);
    }
  }

  async applyWan(reading, widgetsChanged) {
    const now = reading.at;
    const byName = new Map(reading.interfaces.map((item) => [item.name, item]));
    const wan = new Map();
    for (const { name } of this.router.wan) {
      const item = byName.get(name);
      if (!item) {
        wan.set(name, { found: false, up: null, download: null, upload: null });
        continue;
      }
      // The counters of the layer-3 device (pppoe-wan) when the link is up,
      // else of the underlying device (eth1, wan).
      const deviceName = item.l3Device ?? item.device;
      const device = deviceName ? reading.devices.get(deviceName) : null;
      const previous = this.counters.get(name);
      const before = this.snapshot.wan.get(name);
      let download = null;
      let upload = null;
      if (previous && now - previous.at < 1000) {
        // A reading right after another (a connection test): the rates of
        // the previous interval stand, the counters keep their reference.
        download = before?.download ?? null;
        upload = before?.upload ?? null;
      } else {
        if (
          device &&
          previous &&
          previous.device === deviceName &&
          device.rxBytes !== null &&
          device.txBytes !== null
        ) {
          const seconds = (now - previous.at) / 1000;
          const rx = device.rxBytes - previous.rx;
          const tx = device.txBytes - previous.tx;
          // A counter that went back (reboot, new PPPoE session) gives no rate this time.
          download = rx >= 0 ? round((rx * 8) / seconds / 1e6, 2) : null;
          upload = tx >= 0 ? round((tx * 8) / seconds / 1e6, 2) : null;
        }
        if (device && device.rxBytes !== null && device.txBytes !== null) {
          this.counters.set(name, {
            device: deviceName,
            rx: device.rxBytes,
            tx: device.txBytes,
            at: now,
          });
        } else {
          this.counters.delete(name);
        }
      }
      // A cable unplugged takes the interface down in netifd; the carrier of
      // the device says it too when netifd keeps the interface up.
      const up = item.up && device?.carrier !== false;
      wan.set(name, { found: true, up, download, upload, proto: item.proto });

      const was = before?.up;
      if (was === true && up === false) {
        this.wanDownSince.set(name, now);
        logger.info(`${this.label()}: WAN ${name} is down`);
        widgetsChanged.add(WIDGET_KEYS.ROUTER);
        await this.fire(TRIGGERS.WAN_DOWN, { interface: name });
      } else if (was === false && up === true) {
        const since = this.wanDownSince.get(name) ?? now;
        this.wanDownSince.delete(name);
        const downMinutes = Math.round((now - since) / 60_000);
        logger.info(`${this.label()}: WAN ${name} is back after ${downMinutes} min`);
        widgetsChanged.add(WIDGET_KEYS.ROUTER);
        await this.fire(TRIGGERS.WAN_UP, { interface: name, down_minutes: downMinutes });
      } else if (was === undefined && up === false) {
        this.wanDownSince.set(name, now);
      }
    }
    this.snapshot.wan = wan;
  }

  /** Fire "unknown device connected" for a MAC address never seen before. */
  async detectUnknownDevices(reading, ignore) {
    const known = this.saved.knownMacs;
    const now = reading.at;
    // Wi-Fi associations and DHCP leases: a device that joined the network.
    // Not the neighbour table: the WAN side (the ISP box) is in it too.
    const candidates = new Map();
    for (const station of reading.stations) {
      if (station.authorized && !candidates.has(station.mac)) {
        candidates.set(station.mac, {
          source: SOURCES.WIFI,
          ssid: station.ssid,
          interface: station.ifname,
        });
      }
    }
    for (const lease of reading.leases) {
      if (!candidates.has(lease.mac)) {
        candidates.set(lease.mac, { source: SOURCES.DHCP, ssid: null, interface: null });
      }
    }
    let changed = false;
    let fired = 0;
    for (const [mac, candidate] of candidates) {
      if (ignore.has(mac) || mac in known) {
        continue;
      }
      known[mac] = now;
      changed = true;
      if (!this.saved.baselined) {
        continue; // the first reading learns the network as it is
      }
      const client = this.clients.get(mac);
      logger.info(`${this.label()}: new device on the network (${candidate.source})`);
      if (fired < MAX_UNKNOWN_EVENTS) {
        fired += 1;
        await this.fire(TRIGGERS.UNKNOWN_DEVICE, {
          mac,
          ip: client?.ip ?? null,
          host_name: client?.hostName ?? null,
          source: candidate.source,
          ssid: candidate.ssid ?? null,
          interface: candidate.interface ?? null,
        });
      }
    }
    if (!this.saved.baselined && candidates.size > 0) {
      this.saved.baselined = true;
      changed = true;
    }
    const macs = Object.keys(known);
    if (macs.length > MAX_KNOWN_MACS) {
      // The oldest first.
      macs
        .sort((a, b) => known[a] - known[b])
        .slice(0, macs.length - MAX_KNOWN_MACS)
        .forEach((mac) => delete known[mac]);
    }
    if (changed) {
      this.store.save(this.saved);
    }
  }

  async fire(key, data) {
    try {
      await this.gladys.publishSceneEvent(key, data);
      this.resolved('scene-event');
    } catch (err) {
      this.problem('scene-event', `Scene event ${key} refused: ${err.message}`);
    }
  }

  // --- Devices -------------------------------------------------------------------

  /** The devices the user added to Gladys, by type. */
  createdDevices(type) {
    return (this.gladys.devices ?? []).filter(
      (device) => parseDeviceId(this.gladys, device.external_id)?.type === type,
    );
  }

  /** MAC addresses of the clients added to Gladys. */
  followedClients() {
    const macs = [];
    for (const device of this.createdDevices(DEVICE_TYPES.CLIENT)) {
      const mac =
        normalizeMac(paramOf(device, 'MAC_ADDRESS')) ??
        normalizeMac(parseDeviceId(this.gladys, device.external_id).id);
      if (mac) {
        macs.push(mac);
      }
    }
    return macs;
  }

  discoveredClients() {
    const followed = new Set(this.followedClients());
    const list = [...this.clients.values()];
    // The followed ones first (always listed), then the most recently seen.
    list.sort(
      (a, b) =>
        Number(followed.has(b.mac)) - Number(followed.has(a.mac)) ||
        (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0) ||
        a.mac.localeCompare(b.mac),
    );
    const result = list.slice(0, MAX_DISCOVERED_CLIENTS);
    for (const mac of followed) {
      if (!this.clients.has(mac)) {
        result.push({ mac, ip: null, hostName: null });
      }
    }
    return result;
  }

  async publishDevices({ force = false } = {}) {
    const language = this.config.language;
    const devices = [];
    if (this.router) {
      devices.push(buildRouterDevice(this.gladys, this.router, language));
    }
    const clients = this.discoveredClients();
    devices.push(...clients.map((client) => buildClientDevice(this.gladys, client, language)));

    // The router publishes at once; the client list at most every few minutes.
    const structure = JSON.stringify(devices.slice(0, devices.length - clients.length));
    const members = clients
      .map((client) => client.mac)
      .sort()
      .join(',');
    const key = `${structure}|${members}`;
    if (!force && key === this.discoveryKey) {
      return;
    }
    const structureChanged = !this.discoveryKey?.startsWith(`${structure}|`);
    if (!force && !structureChanged && this.now() - this.discoveryAt < this.timings.discoveryMs) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.discoveryKey = key;
      this.discoveryAt = this.now();
      this.resolved('discovery');
    } catch (err) {
      this.problem('discovery', `Discovered devices refused: ${err.message}`);
    }
  }

  /** "Search" in the Discovery tab: read the router, publish everything again. */
  async rediscover() {
    await this.pollAll();
    await this.publishDevices({ force: true });
  }

  /** The user added a device: its states sent before were dropped by Gladys. */
  async onDeviceCreated(device) {
    for (const feature of device.features ?? []) {
      this.published.delete(feature.external_id);
    }
    const parsed = parseDeviceId(this.gladys, device.external_id);
    if (parsed?.type === DEVICE_TYPES.CLIENT && this.snapshot.reachable) {
      // Follow it at once, from the last reading.
      this.presence.update(this.followedClients(), this.lastClients);
    }
    await this.publishStates();
    if (parsed) {
      this.gladys.requestWidgetRefresh(
        parsed.type === DEVICE_TYPES.CLIENT ? WIDGET_KEYS.PRESENCE : WIDGET_KEYS.ROUTER,
      );
    }
  }

  // --- Publishing to Gladys ------------------------------------------------------------

  /** Every value to publish: { externalId, value, heartbeat }. */
  stateEntries() {
    const entries = [];
    const add = (externalId, value, heartbeat = this.timings.heartbeatMs) => {
      if (value === null || value === undefined) {
        return;
      }
      entries.push({ externalId, value, heartbeat });
    };
    if (this.router && this.snapshot.reachable) {
      const ids = routerIds(this.gladys, this.router.id);
      const { system, guest } = this.snapshot;
      if (this.router.hasSystem && system?.load1 !== null && system?.load1 !== undefined) {
        add(ids.feature(FEATURE_KEYS.LOAD), Math.round(system.load1 * 100));
      }
      if (this.router.hasSystem) {
        add(ids.feature(FEATURE_KEYS.MEMORY), system?.memoryUsage);
      }
      if (system?.uptimeSeconds !== null && system?.uptimeSeconds !== undefined) {
        add(ids.feature(FEATURE_KEYS.UPTIME), Math.floor(system.uptimeSeconds / 3600));
      }
      if (this.router.version) {
        add(ids.feature(FEATURE_KEYS.VERSION), { text: this.router.version });
      }
      for (const radio of this.router.radios) {
        add(ids.feature(radioFeatureKey(radio.slug)), this.snapshot.radios.get(radio.name));
      }
      if (this.router.guest && guest?.found) {
        add(ids.feature(FEATURE_KEYS.GUEST), guest.enabled ? 1 : 0);
      }
      for (const { name, slug } of this.router.wan) {
        const wan = this.snapshot.wan.get(name);
        if (!wan?.found) {
          continue;
        }
        add(ids.feature(wanFeatureKey(slug, WAN_FEATURES.DOWNLOAD)), wan.download);
        add(ids.feature(wanFeatureKey(slug, WAN_FEATURES.UPLOAD)), wan.upload);
        add(ids.feature(wanFeatureKey(slug, WAN_FEATURES.LINK)), wan.up ? 1 : 0);
      }
    }
    for (const mac of this.followedClients()) {
      const present = this.presence.presence(mac);
      add(
        clientIds(this.gladys, mac).feature(FEATURE_KEYS.PRESENCE),
        present,
        present === 1 ? this.timings.presentRefreshMs : this.timings.heartbeatMs,
      );
    }
    return entries;
  }

  /** Publish the values that changed (or whose heartbeat is due), for the added devices only. */
  async publishStates() {
    const created = new Set(
      (this.gladys.devices ?? []).flatMap((device) =>
        (device.features ?? []).map((feature) => feature.external_id),
      ),
    );
    const now = this.now();
    const keyOf = (value) => (typeof value === 'object' ? `text:${value.text}` : value);
    const due = this.stateEntries().filter(({ externalId, value, heartbeat }) => {
      if (!created.has(externalId)) {
        return false; // Gladys would drop it, and count it in its quota
      }
      const last = this.published.get(externalId);
      return !last || last.key !== keyOf(value) || now - last.at >= heartbeat;
    });
    for (let at = 0; at < due.length; at += MAX_STATES_PER_REQUEST) {
      const batch = due.slice(at, at + MAX_STATES_PER_REQUEST);
      try {
        await this.gladys.publishStates(
          batch.map(({ externalId, value }) =>
            typeof value === 'object'
              ? { device_feature_external_id: externalId, text: value.text }
              : { device_feature_external_id: externalId, state: value },
          ),
        );
        for (const { externalId, value } of batch) {
          this.published.set(externalId, { key: keyOf(value), at: now });
        }
        this.resolved('states');
      } catch (err) {
        this.problem('states', `States refused by Gladys: ${err.message}`);
      }
    }
  }

  async publishTransports() {
    if (this.snapshot.reachable === null || !this.router) {
      return;
    }
    const transport = this.snapshot.reachable
      ? DEVICE_TRANSPORTS.LOCAL
      : DEVICE_TRANSPORTS.UNREACHABLE;
    const id = routerIds(this.gladys, this.router.id).device;
    if (this.transports.get(id) === transport) {
      return;
    }
    try {
      await this.gladys.publishTransports([{ external_id: id, transport }]);
      this.transports.set(id, transport);
      this.resolved('transports');
    } catch (err) {
      this.problem('transports', `Transports refused: ${err.message}`);
    }
  }

  /** The status under the integration name. */
  connectionStatus() {
    if (!this.config.host) {
      return {
        connected: false,
        message: this.config.invalidHost ? CONNECTION_TEXT.invalidHost : CONNECTION_TEXT.noHost,
      };
    }
    if (this.snapshot.error) {
      return { connected: false, message: ERROR_TEXT[this.snapshot.error.kind] };
    }
    if (this.snapshot.reachable) {
      return { connected: true };
    }
    return { connected: false, message: CONNECTION_TEXT.connecting };
  }

  async publishConnectionStatus() {
    const status = this.connectionStatus();
    const key = JSON.stringify(status);
    if (key === this.connection) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.connection = key;
      this.resolved('connection-status');
    } catch (err) {
      this.problem('connection-status', `Connection status refused: ${err.message}`);
    }
  }

  refreshWidgets() {
    for (const key of Object.values(WIDGET_KEYS)) {
      this.gladys.requestWidgetRefresh(key);
    }
  }

  // --- Commands --------------------------------------------------------------------------

  text(table) {
    return pick(table, this.config?.language);
  }

  assertCommands() {
    if (!this.config?.allowCommands) {
      throw new Error(this.text(ACTION_TEXT.disabled));
    }
  }

  /** A session for a command: the current one, or a new one. */
  async commandSession() {
    if (!this.config.host) {
      throw new Error(this.text(CONNECTION_TEXT.noHost));
    }
    if (!this.session) {
      await this.pollAll();
    }
    if (!this.session) {
      const kind = this.snapshot.error?.kind ?? ERROR_KINDS.UNREACHABLE;
      throw new Error(this.text(ERROR_TEXT[kind]));
    }
    return this.session.backend;
  }

  commandError(err) {
    if (err instanceof OpenwrtError && err.kind === ERROR_KINDS.PERMISSION) {
      return new Error(this.text(ACTION_TEXT.permission));
    }
    if (err instanceof OpenwrtError) {
      return new Error(this.text(ERROR_TEXT[err.kind] ?? ERROR_TEXT[ERROR_KINDS.PROTOCOL]));
    }
    return err;
  }

  /**
   * Enable or disable the guest Wi-Fi chosen in the configuration. The only
   * configuration change the integration makes.
   * @returns {Promise<{ enabled: boolean }>}
   */
  async setGuest(enabled) {
    this.assertCommands();
    const section = this.config.guestSection;
    if (!section) {
      throw new Error(this.text(ACTION_TEXT.noGuest));
    }
    const backend = await this.commandSession();
    if (backend.kind !== 'ubus') {
      throw new Error(this.text(ACTION_TEXT.needsUbus));
    }
    try {
      const guest = await backend.readGuest(section, { list: [] });
      if (guest.found === false) {
        throw new Error(this.text(ACTION_TEXT.guestNotFound));
      }
      await backend.setGuest(section, enabled);
    } catch (err) {
      logger.warn(`Guest Wi-Fi "${section}": command failed: ${err.message}`);
      throw this.commandError(err);
    }
    logger.info(`Guest Wi-Fi "${section}" ${enabled ? 'enabled' : 'disabled'}`);
    try {
      this.snapshot.guest = await backend.readGuest(section, { list: [] });
      await this.publishStates();
      this.gladys.requestWidgetRefresh(WIDGET_KEYS.ROUTER);
    } catch (err) {
      logger.debug(`Guest Wi-Fi not read again: ${err.message}`);
    }
    return { enabled };
  }

  /** Restart the router. */
  async reboot() {
    this.assertCommands();
    const backend = await this.commandSession();
    try {
      await backend.reboot({ timeoutMs: this.timings.commandTimeoutMs });
    } catch (err) {
      // The router may hang up before answering: it is restarting.
      if (!(err instanceof OpenwrtError && err.kind === ERROR_KINDS.UNREACHABLE)) {
        logger.warn(`Reboot refused: ${err.message}`);
        throw this.commandError(err);
      }
    }
    logger.info(`${this.label()}: reboot requested`);
    await this.closeSession();
    return { rebooting: true };
  }

  // --- Reports ---------------------------------------------------------------------------

  /** "Test the connection": detect the interface again, then read everything. */
  async testConnection() {
    await this.polling?.catch(() => {});
    await this.closeSession();
    this.retryAfter = 0;
    await this.pollAll();
    const message = {};
    for (const language of Object.keys(REPORT_TEXT)) {
      message[language] = this.report(language);
    }
    return message;
  }

  report(language) {
    const text = REPORT_TEXT[language];
    const colon = language === 'fr' ? ' : ' : ': ';
    if (!this.config.host) {
      return pick(this.connectionStatus().message, language);
    }
    const lines = [];
    const tlsRefused = this.attempts.some((attempt) => attempt.error?.kind === ERROR_KINDS.TLS);
    if (!this.snapshot.reachable) {
      lines.push(pick(ERROR_TEXT[this.snapshot.error?.kind ?? ERROR_KINDS.UNREACHABLE], language));
      for (const attempt of this.attempts) {
        if (attempt.error) {
          lines.push(
            labelled(
              API_LABELS[attempt.kind],
              pick(ERROR_TEXT[attempt.error.kind] ?? ERROR_TEXT.protocol, language),
              language,
            ),
          );
        }
      }
      return lines.join('\n').slice(0, 2000);
    }
    lines.push(
      text.connected(
        `${API_LABELS[this.session?.kind] ?? '?'}${this.session?.https ? ' (HTTPS)' : ''}`,
        routerName(this.router),
        this.router.version ?? '?',
      ),
    );
    if (this.session?.kind === 'luci') {
      lines.push(text.luciFallback);
    } else {
      const wan = this.router.wan.map(({ name }) => {
        const state = this.snapshot.wan.get(name);
        return `${name} (${!state?.found ? text.missing : state.up ? text.up : text.down})`;
      });
      lines.push(
        wan.length
          ? `${text.wan}${colon}${wan.join(', ')} · ${text.wanSource[this.router.wanSource]}`
          : text.noWan,
      );
      lines.push(
        this.router.radios.length
          ? text.radios(
              this.router.radios
                .map((radio) => `${radio.label} (${this.snapshot.radios.get(radio.name) ?? '–'})`)
                .join(', '),
            )
          : text.noRadio,
      );
      if (this.config.invalidGuest) {
        lines.push(text.guestInvalid);
      } else if (this.config.guestSection) {
        const guest = this.snapshot.guest;
        const name = guest?.ssid ?? this.config.guestSection;
        lines.push(
          guest?.found === false
            ? text.guestMissing
            : guest?.found === null
              ? text.guestDenied
              : guest?.enabled
                ? text.guestOn(name)
                : text.guestOff(name),
        );
      }
    }
    lines.push(text.clients(this.snapshot.counts));
    const gaps = [...new Set(this.snapshot.gaps.map((gap) => gap.what))];
    if (gaps.length) {
      lines.push(`${text.notRead}${colon}${gaps.slice(0, 6).join(', ')}`);
    }
    lines.push(this.config.allowCommands ? text.commandsOn : text.commandsOff);
    if (this.session && !this.session.https) {
      lines.push(tlsRefused ? text.tlsHint : text.plainHint);
    }
    return lines.join('\n').slice(0, 2000);
  }

  /** "List the Wi-Fi networks": the enabled wifi-iface sections, to pick the guest one. */
  async listNetworks() {
    const backend = await this.commandSession().catch((err) => {
      throw this.commandError(err);
    });
    if (backend.kind !== 'ubus') {
      return Object.fromEntries(
        Object.entries(NETWORKS_TEXT).map(([language, text]) => [language, text.needsUbus]),
      );
    }
    let reading;
    try {
      reading = await backend.read({ guestSection: null });
    } catch (err) {
      throw this.commandError(err);
    }
    const counts = new Map();
    for (const station of reading.stations.filter((s) => s.authorized)) {
      counts.set(station.ifname, (counts.get(station.ifname) ?? 0) + 1);
    }
    const message = {};
    for (const [language, text] of Object.entries(NETWORKS_TEXT)) {
      const lines = [];
      for (const radio of radioLabels(reading.radios)) {
        for (const iface of radio.ifaces) {
          if (!iface.section) {
            continue;
          }
          const guest = iface.section === this.config.guestSection ? ` ✓ ${text.guest}` : '';
          lines.push(
            `${iface.section}${guest} — "${iface.ssid ?? '?'}", ${radio.label || radio.name}, ${iface.mode}` +
              `, ${(iface.network ?? []).join('+') || '-'}, ${text.clients(counts.get(iface.ifname) ?? 0)}`,
          );
        }
      }
      message[language] = lines.length
        ? [text.intro, ...lines.slice(0, 20)].join('\n').slice(0, 2000)
        : text.none;
    }
    return message;
  }
}
