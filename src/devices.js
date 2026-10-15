// -----------------------------------------------------------------------------
// The Gladys devices of the integration (category/type couples of the core
// table, see test/gladys-rules.test.js):
//
//   - the router: system load and memory used, uptime, OpenWrt version, the
//     number of Wi-Fi clients of each radio, the state of the guest Wi-Fi
//     (when one is chosen in the configuration), and for each WAN interface
//     its download and upload rates and its link state;
//   - one presence sensor per network client the user adds from the
//     Discovery tab (presence-sensor/binary: 1 present, 0 away once the
//     departure delay has passed).
//
// Nothing is controllable as a device feature: the guest Wi-Fi state is
// input/binary, read-only on purpose. The commands go through the scene
// actions and the widget buttons, never through a switch a voice assistant
// could flip.
//
// Identities (external ids, permanent):
//   - the router: the MAC address of its first Ethernet device (eth0, the CPU
//     port of a DSA switch), else of its LAN bridge. Never the address typed
//     in the configuration;
//   - a client: its MAC address.
// Feature keys are permanent too; a WAN feature carries the logical interface
// name (`wan`, `wan6`, `wwan`), a Wi-Fi one the radio name (`radio0`).
//
// Every device is published with should_poll: false: the integration reads
// the router on its own timer (src/hub.js).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

export const DEVICE_TYPES = Object.freeze({
  ROUTER: 'router',
  CLIENT: 'client',
});

// Suffixes of the feature external ids: permanent once published.
export const FEATURE_KEYS = Object.freeze({
  LOAD: 'load',
  MEMORY: 'memory_usage',
  UPTIME: 'uptime',
  VERSION: 'openwrt_version',
  GUEST: 'guest_wifi',
  PRESENCE: 'presence',
});

export const WAN_FEATURES = Object.freeze({
  DOWNLOAD: 'download',
  UPLOAD: 'upload',
  LINK: 'link',
});

export const wanFeatureKey = (slug, what) => `wan_${slug}_${what}`;
export const radioFeatureKey = (slug) => `wifi_${slug}_clients`;

// Feature and device names, in the language chosen in the configuration
// (Gladys does not tell a device integration the user's language). Frozen at
// creation in Gladys.
export const NAMES = {
  en: {
    [FEATURE_KEYS.LOAD]: 'System load (1 min)',
    [FEATURE_KEYS.MEMORY]: 'Memory used',
    [FEATURE_KEYS.UPTIME]: 'Uptime',
    [FEATURE_KEYS.VERSION]: 'OpenWrt version',
    [FEATURE_KEYS.GUEST]: 'Guest Wi-Fi enabled',
    [FEATURE_KEYS.PRESENCE]: 'Presence',
    download: (name) => `Download ${name}`,
    upload: (name) => `Upload ${name}`,
    link: (name) => `WAN link ${name}`,
    wifiClients: (radio) => `Wi-Fi clients ${radio}`,
    client: (mac) => `Device ${mac}`,
  },
  fr: {
    [FEATURE_KEYS.LOAD]: 'Charge système (1 min)',
    [FEATURE_KEYS.MEMORY]: 'Mémoire utilisée',
    [FEATURE_KEYS.UPTIME]: 'Temps de fonctionnement',
    [FEATURE_KEYS.VERSION]: "Version d'OpenWrt",
    [FEATURE_KEYS.GUEST]: 'Wi-Fi invité activé',
    [FEATURE_KEYS.PRESENCE]: 'Présence',
    download: (name) => `Débit descendant ${name}`,
    upload: (name) => `Débit montant ${name}`,
    link: (name) => `Lien WAN ${name}`,
    wifiClients: (radio) => `Clients Wi-Fi ${radio}`,
    client: (mac) => `Appareil ${mac}`,
  },
  de: {
    [FEATURE_KEYS.LOAD]: 'Systemlast (1 min)',
    [FEATURE_KEYS.MEMORY]: 'Belegter Speicher',
    [FEATURE_KEYS.UPTIME]: 'Betriebszeit',
    [FEATURE_KEYS.VERSION]: 'OpenWrt-Version',
    [FEATURE_KEYS.GUEST]: 'Gäste-WLAN aktiviert',
    [FEATURE_KEYS.PRESENCE]: 'Anwesenheit',
    download: (name) => `Download ${name}`,
    upload: (name) => `Upload ${name}`,
    link: (name) => `WAN-Verbindung ${name}`,
    wifiClients: (radio) => `WLAN-Clients ${radio}`,
    client: (mac) => `Gerät ${mac}`,
  },
  es: {
    [FEATURE_KEYS.LOAD]: 'Carga del sistema (1 min)',
    [FEATURE_KEYS.MEMORY]: 'Memoria usada',
    [FEATURE_KEYS.UPTIME]: 'Tiempo de funcionamiento',
    [FEATURE_KEYS.VERSION]: 'Versión de OpenWrt',
    [FEATURE_KEYS.GUEST]: 'Wi-Fi de invitados activado',
    [FEATURE_KEYS.PRESENCE]: 'Presencia',
    download: (name) => `Descarga ${name}`,
    upload: (name) => `Subida ${name}`,
    link: (name) => `Enlace WAN ${name}`,
    wifiClients: (radio) => `Clientes Wi-Fi ${radio}`,
    client: (mac) => `Dispositivo ${mac}`,
  },
};

export const names = (language) => NAMES[language] ?? NAMES.en;

// Display bounds (the core never applies them on write). The load is the
// load average in percent of one CPU core: 4 cores fully busy read 400 %.
const MAX_LOAD_PERCENT = 1600;
const MAX_RATE_MBPS = 100_000;
const MAX_UPTIME_HOURS = 100_000;
const MAX_WIFI_CLIENTS = 1000;

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});

const binary = () =>
  sensor({
    category: DEVICE_FEATURE_CATEGORIES.INPUT,
    type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
    min: 0,
    max: 1,
  });

/** A text usable in an external id: lowercase letters, digits and dashes. */
export function slugify(value) {
  return String(value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/** The identifier of a client: its MAC address, lowercase. */
export const clientPlatformId = (mac) => mac.toLowerCase();

export const routerIds = (gladys, routerId) => gladys.externalIds(DEVICE_TYPES.ROUTER, routerId);
export const clientIds = (gladys, mac) =>
  gladys.externalIds(DEVICE_TYPES.CLIENT, clientPlatformId(mac));

/**
 * What kind of device an external id is, and its platform id.
 * @returns {{ type: string, id: string }|null}
 */
export function parseDeviceId(gladys, externalId) {
  if (typeof externalId !== 'string') {
    return null;
  }
  for (const type of Object.values(DEVICE_TYPES)) {
    const prefix = gladys.externalIds(type, '').device;
    if (externalId.startsWith(prefix) && externalId.length > prefix.length) {
      return { type, id: externalId.slice(prefix.length) };
    }
  }
  return null;
}

/**
 * Names as features: the name shown, and a key part unique on the device.
 * @param {string[]} list
 * @returns {Array<{ name: string, slug: string }>}
 */
export function slugs(list) {
  const seen = new Set();
  const result = [];
  for (const name of list) {
    const slug = slugify(name);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      result.push({ name, slug });
    }
  }
  return result;
}

/** "2.4 GHz", or "5 GHz (radio1)" when two radios share a band. */
export function radioLabels(radios) {
  const count = new Map();
  for (const radio of radios) {
    count.set(radio.band, (count.get(radio.band) ?? 0) + 1);
  }
  return radios.map((radio) => ({
    ...radio,
    label:
      radio.band && count.get(radio.band) === 1
        ? radio.band
        : `${radio.band ?? ''} (${radio.name})`.trim(),
  }));
}

/** The name of the router device: its host name, with the model when the host name is the default one. */
export function routerName(router) {
  const hostname = router.hostname ?? 'OpenWrt';
  if (hostname === 'OpenWrt' && router.model) {
    return `OpenWrt ${router.model}`.slice(0, 60);
  }
  return hostname.slice(0, 60);
}

/**
 * The features of the router device.
 * @param {object} gladys
 * @param {object} router { id, hasSystem, hasVersion, guest, wan: [{ name, slug }], radios: [{ name, slug, label }] }
 * @param {string} language
 */
export function routerFeatures(gladys, router, language) {
  const ids = routerIds(gladys, router.id);
  const n = names(language);
  const feature = (key, name, definition) => ({
    ...definition,
    name,
    external_id: ids.feature(key),
  });
  const features = [];
  if (router.hasSystem) {
    features.push(
      feature(
        FEATURE_KEYS.LOAD,
        n[FEATURE_KEYS.LOAD],
        sensor({
          category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
          unit: DEVICE_FEATURE_UNITS.PERCENT,
          min: 0,
          max: MAX_LOAD_PERCENT,
        }),
      ),
      feature(
        FEATURE_KEYS.MEMORY,
        n[FEATURE_KEYS.MEMORY],
        sensor({
          category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
          unit: DEVICE_FEATURE_UNITS.PERCENT,
          min: 0,
          max: 100,
        }),
      ),
    );
  }
  features.push(
    feature(
      FEATURE_KEYS.UPTIME,
      n[FEATURE_KEYS.UPTIME],
      sensor({
        category: DEVICE_FEATURE_CATEGORIES.DURATION,
        type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
        unit: DEVICE_FEATURE_UNITS.HOURS,
        min: 0,
        max: MAX_UPTIME_HOURS,
        // A counter that only grows: its history says nothing a reboot would not.
        keep_history: false,
      }),
    ),
  );
  if (router.hasVersion) {
    features.push(
      feature(
        FEATURE_KEYS.VERSION,
        n[FEATURE_KEYS.VERSION],
        sensor({
          category: DEVICE_FEATURE_CATEGORIES.TEXT,
          type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
          keep_history: false,
          min: 0,
          max: 0,
        }),
      ),
    );
  }
  for (const radio of router.radios) {
    features.push(
      feature(
        radioFeatureKey(radio.slug),
        n.wifiClients(radio.label),
        sensor({
          category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
          min: 0,
          max: MAX_WIFI_CLIENTS,
        }),
      ),
    );
  }
  if (router.guest) {
    features.push(feature(FEATURE_KEYS.GUEST, n[FEATURE_KEYS.GUEST], binary()));
  }
  for (const { name, slug } of router.wan) {
    const rate = (what, label) =>
      feature(
        wanFeatureKey(slug, what),
        label,
        sensor({
          category: DEVICE_FEATURE_CATEGORIES.DATARATE,
          type: DEVICE_FEATURE_TYPES.DATARATE.RATE,
          unit: DEVICE_FEATURE_UNITS.MEGABITS_PER_SECOND,
          min: 0,
          max: MAX_RATE_MBPS,
        }),
      );
    features.push(
      rate(WAN_FEATURES.DOWNLOAD, n.download(name)),
      rate(WAN_FEATURES.UPLOAD, n.upload(name)),
      feature(wanFeatureKey(slug, WAN_FEATURES.LINK), n.link(name), binary()),
    );
  }
  return features;
}

/**
 * The discovery payload of the router.
 * @param {object} router see routerFeatures(), plus { hostname, model, host }
 */
export function buildRouterDevice(gladys, router, language) {
  return {
    name: routerName(router),
    external_id: routerIds(gladys, router.id).device,
    model: router.model ?? undefined,
    should_poll: false,
    params: [
      { name: 'ROUTER_ADDRESS', value: router.host },
      ...(router.model ? [{ name: 'MODEL', value: router.model }] : []),
    ],
    features: routerFeatures(gladys, router, language),
  };
}

/** The name proposed for a client: its host name (DHCP), else its MAC. */
export function clientName(client, language) {
  return client.hostName ?? names(language).client(client.mac);
}

/**
 * The discovery payload of a network client.
 * @param {object} client { mac, ip, hostName }
 */
export function buildClientDevice(gladys, client, language) {
  const ids = clientIds(gladys, client.mac);
  return {
    name: clientName(client, language).slice(0, 60),
    external_id: ids.device,
    should_poll: false,
    params: [
      { name: 'MAC_ADDRESS', value: client.mac },
      ...(client.ip ? [{ name: 'IP_ADDRESS', value: client.ip }] : []),
    ],
    features: [
      {
        name: names(language)[FEATURE_KEYS.PRESENCE],
        external_id: ids.feature(FEATURE_KEYS.PRESENCE),
        ...sensor({
          category: DEVICE_FEATURE_CATEGORIES.PRESENCE_SENSOR,
          type: DEVICE_FEATURE_TYPES.SENSOR.BINARY,
          min: 0,
          max: 1,
        }),
      },
    ],
  };
}

/** The value of a param of a device received from Gladys. */
export const paramOf = (device, name) =>
  (device?.params ?? []).find((param) => param.name === name)?.value ?? null;
