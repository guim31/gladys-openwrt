// -----------------------------------------------------------------------------
// Integration configuration: defaults (they mirror the `default` values of the
// manifest `config_schema`, see test/manifest.test.js) and normalization, so
// the rest of the code never deals with strings, blanks or `undefined`.
// -----------------------------------------------------------------------------

import { APIS } from './openwrt/client.js';

export const LANGUAGES = ['en', 'fr', 'de', 'es'];

export { APIS };

// Reading intervals offered in the configuration, in seconds.
export const POLL_INTERVALS = ['10', '15', '30', '60'];

export const MAX_AWAY_DELAY_MINUTES = 60;
export const MAX_WAN_INTERFACES = 4;

export const DEFAULT_CONFIG = {
  host: '',
  https: false,
  allow_self_signed: false,
  username: '',
  password: '',
  api: 'auto',
  poll_interval: '30',
  wan_interfaces: '',
  away_delay: 5,
  presence_dhcp: false,
  guest_wifi: '',
  allow_commands: false,
  language: 'fr',
};

/**
 * Parse the address typed by the user: a bare IP or host name
 * (`192.0.2.1`, `openwrt.lan`), optionally with a port (`192.0.2.1:8080`),
 * or the URL copied from the browser (`https://192.0.2.1/cgi-bin/luci/`).
 * The path is dropped; an `https://` scheme turns HTTPS on.
 * @param {unknown} raw
 * @returns {{ host: string, port: number|null, https: boolean }|null} null when unusable
 */
export function parseAddress(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const value = raw.trim();
  if (!value) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  if (hasScheme && !/^https?:\/\//i.test(value)) {
    return null;
  }
  const withScheme = hasScheme ? value : `http://${value}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  // Credentials in the address would end up in the logs and the device params.
  if (!url.hostname || url.username || url.password) {
    return null;
  }
  // `new URL` drops the default port of the scheme: only an explicit one counts.
  const explicitPort = /^[a-z][a-z0-9+.-]*:\/\/[^/]*:(\d+)/i.test(withScheme) ? url.port : '';
  return {
    host: url.hostname.replace(/^\[(.*)\]$/, '$1'),
    port: explicitPort ? Number(explicitPort) : null,
    https: url.protocol === 'https:',
  };
}

/** Split a comma (or semicolon, or line) separated list, trimmed, without blanks nor duplicates. */
export function splitList(raw) {
  if (typeof raw !== 'string') {
    return [];
  }
  const seen = new Set();
  const items = [];
  for (const item of raw.split(/[,;\n]/)) {
    const value = item.trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      items.push(value);
    }
  }
  return items;
}

const toBoolean = (value, fallback) => {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return fallback;
};

// UCI section and interface names: letters, digits and underscores (UCI also
// accepts dashes in some places). Anything else is a typo, not a name.
const UCI_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * @param {Record<string, unknown>} raw the configuration returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (key) => (typeof source[key] === 'string' ? source[key].trim() : '');
  const pick = (key, list) => {
    const value = source[key] === undefined || source[key] === null ? '' : String(source[key]);
    return list.includes(value) ? value : DEFAULT_CONFIG[key];
  };

  const typedAddress = text('host');
  const address = parseAddress(typedAddress);

  // A number field may arrive as a string ("5", "2,5") or be left empty.
  const rawDelay =
    typeof source.away_delay === 'string'
      ? Number(source.away_delay.trim().replace(',', '.'))
      : source.away_delay;
  const awayDelay =
    typeof rawDelay === 'number' && Number.isFinite(rawDelay) && rawDelay >= 0
      ? Math.min(MAX_AWAY_DELAY_MINUTES, Math.round(rawDelay))
      : DEFAULT_CONFIG.away_delay;

  const guest = text('guest_wifi');

  return {
    host: address?.host ?? null,
    port: address?.port ?? null,
    invalidHost: typedAddress !== '' && address === null,
    https: address?.https === true || toBoolean(source.https, DEFAULT_CONFIG.https),
    allowSelfSigned: toBoolean(source.allow_self_signed, DEFAULT_CONFIG.allow_self_signed),
    username: text('username'),
    // Passwords are kept as typed: spaces may be part of them.
    password: typeof source.password === 'string' ? source.password : '',
    api: pick('api', APIS),
    pollIntervalMs: Number(pick('poll_interval', POLL_INTERVALS)) * 1000,
    wanInterfaces: splitList(source.wan_interfaces)
      .filter((name) => UCI_NAME.test(name))
      .slice(0, MAX_WAN_INTERFACES),
    awayDelayMs: awayDelay * 60_000,
    presenceDhcp: toBoolean(source.presence_dhcp, DEFAULT_CONFIG.presence_dhcp),
    guestSection: UCI_NAME.test(guest) ? guest : null,
    invalidGuest: guest !== '' && !UCI_NAME.test(guest),
    allowCommands: toBoolean(source.allow_commands, DEFAULT_CONFIG.allow_commands),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULT_CONFIG.language,
  };
}
