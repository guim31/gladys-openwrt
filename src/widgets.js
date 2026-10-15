// -----------------------------------------------------------------------------
// Dashboard widgets (manifest `widgets`, Gladys 5.1+):
//
//   - `router`: the health of the router (load, memory), the rates of its
//     first WAN, the Wi-Fi clients, the state of each WAN link, of each
//     radio and of the guest Wi-Fi, the uptime and the OpenWrt version; when
//     the commands are allowed, a Guest Wi-Fi button and a Reboot button,
//     both with confirmation;
//   - `presence`: the devices followed as presence sensors, present first.
//
// Every figure is sent as a value, not bound to a device feature: the widgets
// work before the devices are added to Gladys. Budget of the core: 8
// components, 6 tiles, 2 texts, 1 status list (10 rows), 4 buttons.
// (Adapted from guim31/gladys-mikrotik.)
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { DEVICE_TYPES, clientIds, parseDeviceId, routerName } from './devices.js';
import { WIDGET_KEYS } from './hub.js';
import { ERROR_KINDS } from './openwrt/errors.js';
import { ERROR_TEXT, pick } from './texts.js';

// Action keys of the buttons: permanent once published (unique, the core
// drops a button whose key is taken).
export const ACTIONS = Object.freeze({
  REBOOT: 'reboot',
  GUEST: 'guest_wifi',
});
const MAX_ROWS = 10;
const ACTIVE_ICON = 'check-circle';

export const TEXT = {
  noHost: {
    en: 'Enter the address of your OpenWrt router in the configuration of the integration.',
    fr: "Saisissez l'adresse de votre routeur OpenWrt dans la configuration de l'intégration.",
    de: 'Gib die Adresse deines OpenWrt-Routers in der Konfiguration der Integration ein.',
    es: 'Introduzca la dirección de su router OpenWrt en la configuración de la integración.',
  },
  waiting: {
    en: 'Waiting for the first reading of the router…',
    fr: 'En attente de la première lecture du routeur…',
    de: 'Warte auf die erste Abfrage des Routers…',
    es: 'Esperando la primera lectura del router…',
  },
  noClient: {
    en: 'No device followed: add them from the Discovery tab of the integration.',
    fr: "Aucun appareil suivi : ajoutez-les depuis l'onglet Découverte de l'intégration.",
    de: 'Kein Gerät verfolgt: Füge sie im Tab „Entdecken“ der Integration hinzu.',
    es: 'Ningún dispositivo seguido: añádalos desde la pestaña Descubrir de la integración.',
  },
  nobody: {
    en: 'No followed device is present.',
    fr: "Aucun appareil suivi n'est présent.",
    de: 'Kein verfolgtes Gerät ist anwesend.',
    es: 'Ningún dispositivo seguido está presente.',
  },
  more: {
    en: 'more devices',
    fr: 'autres appareils',
    de: 'weitere Geräte',
    es: 'dispositivos más',
  },
  load: { en: 'Load', fr: 'Charge', de: 'Last', es: 'Carga' },
  memory: { en: 'Memory', fr: 'Mémoire', de: 'Speicher', es: 'Memoria' },
  download: { en: 'Download', fr: 'Descendant', de: 'Download', es: 'Descarga' },
  upload: { en: 'Upload', fr: 'Montant', de: 'Upload', es: 'Subida' },
  wifiClients: {
    en: 'Wi-Fi clients',
    fr: 'Clients Wi-Fi',
    de: 'WLAN-Clients',
    es: 'Clientes Wi-Fi',
  },
  present: { en: 'Present', fr: 'Présents', de: 'Anwesend', es: 'Presentes' },
  uptime: {
    en: 'Uptime',
    fr: 'Allumé depuis',
    de: 'Betriebszeit',
    es: 'Encendido desde hace',
  },
  version: { en: 'OpenWrt', fr: 'OpenWrt', de: 'OpenWrt', es: 'OpenWrt' },
  guest: {
    en: 'Guest Wi-Fi',
    fr: 'Wi-Fi invité',
    de: 'Gäste-WLAN',
    es: 'Wi-Fi de invitados',
  },
  clients: { en: 'clients', fr: 'clients', de: 'Clients', es: 'clientes' },
  linkUp: { en: 'Up', fr: 'Actif', de: 'Aktiv', es: 'Activo' },
  linkDown: { en: 'Down', fr: 'Coupé', de: 'Getrennt', es: 'Cortado' },
  radioOff: { en: 'Off', fr: 'Éteinte', de: 'Aus', es: 'Apagada' },
  guestOn: { en: 'Enabled', fr: 'Activé', de: 'Aktiviert', es: 'Activado' },
  guestOff: { en: 'Disabled', fr: 'Désactivé', de: 'Deaktiviert', es: 'Desactivado' },
  missing: { en: 'Not found', fr: 'Introuvable', de: 'Nicht gefunden', es: 'No encontrado' },
  unreachable: {
    en: 'Unreachable',
    fr: 'Injoignable',
    de: 'Nicht erreichbar',
    es: 'Inaccesible',
  },
  error: { en: 'Error', fr: 'Erreur', de: 'Fehler', es: 'Error' },
  isPresent: { en: 'Present', fr: 'Présent', de: 'Anwesend', es: 'Presente' },
  isAway: { en: 'Away', fr: 'Absent', de: 'Abwesend', es: 'Ausente' },
  unknown: { en: 'Unknown', fr: 'Inconnu', de: 'Unbekannt', es: 'Desconocido' },
  reboot: { en: 'Reboot', fr: 'Redémarrer', de: 'Neu starten', es: 'Reiniciar' },
};

// Short time units, for "Away · 2 h" and the uptime.
const UNITS = {
  en: { m: 'min', h: 'h', d: 'd' },
  fr: { m: 'min', h: 'h', d: 'j' },
  de: { m: 'min', h: 'h', d: 'T' },
  es: { m: 'min', h: 'h', d: 'd' },
};

// Toasts after a tap (≤ 200 characters).
export const DONE_TEXT = {
  en: {
    reboot: 'The router is restarting.',
    guestOn: 'Guest Wi-Fi enabled: it starts within a minute.',
    guestOff: 'Guest Wi-Fi disabled.',
  },
  fr: {
    reboot: 'Le routeur redémarre.',
    guestOn: "Wi-Fi invité activé : il démarre d'ici une minute.",
    guestOff: 'Wi-Fi invité désactivé.',
  },
  de: {
    reboot: 'Der Router startet neu.',
    guestOn: 'Gäste-WLAN aktiviert: Es startet innerhalb einer Minute.',
    guestOff: 'Gäste-WLAN deaktiviert.',
  },
  es: {
    reboot: 'El router se está reiniciando.',
    guestOn: 'Wi-Fi de invitados activado: se inicia en menos de un minuto.',
    guestOff: 'Wi-Fi de invitados desactivado.',
  },
};

const t = (table, language) => pick(table, language);
export const fit = (value, max) =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/** "2 h", "3 j 4 h", "12 min". */
export function shortDuration(seconds, language) {
  const units = UNITS[language] ?? UNITS.en;
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 60) {
    return `${minutes} ${units.m}`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ${units.h}`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days} ${units.d} ${rest} ${units.h}` : `${days} ${units.d}`;
}

const rate = (value) => (value === null || value === undefined ? '–' : value.toFixed(1));

function message(table, language, ttl = 300) {
  return {
    ttl_seconds: ttl,
    components: [{ type: 'text', variant: 'body', text: t(table, language) }],
  };
}

const ttlOf = (hub) => Math.max(10, Math.min(3600, Math.round(hub.config.pollIntervalMs / 1000)));

/** The row of a router that cannot be read. */
function errorRow(hub, language) {
  const kind = hub.snapshot.error?.kind ?? ERROR_KINDS.UNREACHABLE;
  return {
    label: fit(hub.router ? routerName(hub.router) : hub.config.host, 40),
    icon: 'alert-triangle',
    value: t(kind === ERROR_KINDS.UNREACHABLE ? TEXT.unreachable : TEXT.error, language),
    color: WIDGET_COLORS.DANGER,
  };
}

// --- router ------------------------------------------------------------------------

async function getRouter(hub, { language = 'en' }) {
  if (!hub.config.host) {
    return message(TEXT.noHost, language);
  }
  if (!hub.router || hub.snapshot.reachable === null) {
    return message(TEXT.waiting, language, 30);
  }
  const components = [];
  if (!hub.snapshot.reachable) {
    components.push(
      {
        type: 'text',
        variant: 'body',
        text: fit(
          pick(ERROR_TEXT[hub.snapshot.error?.kind ?? ERROR_KINDS.UNREACHABLE], language),
          300,
        ),
      },
      { type: 'status', items: [errorRow(hub, language)] },
    );
    return { ttl_seconds: ttlOf(hub), components };
  }

  const { system, guest } = hub.snapshot;
  if (hub.router.hasSystem && system?.load1 !== null && system?.load1 !== undefined) {
    components.push(
      {
        type: 'value',
        value: system.load1.toFixed(2),
        label: t(TEXT.load, language),
        icon: 'cpu',
      },
      {
        type: 'value',
        value: system.memoryUsage ?? '–',
        unit: '%',
        label: t(TEXT.memory, language),
        icon: 'database',
      },
    );
  }
  const [firstWan] = hub.router.wan;
  const first = firstWan ? hub.snapshot.wan.get(firstWan.name) : null;
  if (first?.found) {
    components.push(
      {
        type: 'value',
        value: rate(first.download),
        unit: 'Mbit/s',
        label: t(TEXT.download, language),
        icon: 'arrow-down',
        color: WIDGET_COLORS.PRIMARY,
      },
      {
        type: 'value',
        value: rate(first.upload),
        unit: 'Mbit/s',
        label: t(TEXT.upload, language),
        icon: 'arrow-up',
        color: WIDGET_COLORS.INFO,
      },
    );
  }
  if (hub.router.radios.length > 0) {
    components.push({
      type: 'value',
      value: [...hub.snapshot.radios.values()].reduce((sum, count) => sum + (count ?? 0), 0),
      label: t(TEXT.wifiClients, language),
      icon: 'wifi',
    });
  }

  const items = [];
  for (const { name } of hub.router.wan) {
    const wan = hub.snapshot.wan.get(name);
    const label = fit(`WAN ${name}`, 40);
    if (!wan?.found) {
      items.push({
        label,
        icon: 'help-circle',
        value: t(TEXT.missing, language),
        color: WIDGET_COLORS.WARNING,
      });
    } else if (!wan.up) {
      items.push({
        label,
        icon: 'x-circle',
        value: t(TEXT.linkDown, language),
        color: WIDGET_COLORS.DANGER,
      });
    } else {
      // The first WAN has its tiles; the others show their rates here.
      const value =
        name === firstWan.name
          ? t(TEXT.linkUp, language)
          : `↓ ${rate(wan.download)} · ↑ ${rate(wan.upload)} Mbit/s`;
      items.push({ label, icon: 'globe', value: fit(value, 40), color: WIDGET_COLORS.SUCCESS });
    }
  }
  for (const radio of hub.router.radios) {
    const count = hub.snapshot.radios.get(radio.name);
    items.push({
      label: fit(`Wi-Fi ${radio.label}`, 40),
      icon: 'wifi',
      value:
        count === null || count === undefined
          ? t(TEXT.radioOff, language)
          : `${count} ${t(TEXT.clients, language)}`,
      color: count === null || count === undefined ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.SUCCESS,
    });
  }
  if (hub.router.guest && guest) {
    items.push({
      label: fit(
        guest.ssid ? `${t(TEXT.guest, language)} · ${guest.ssid}` : t(TEXT.guest, language),
        40,
      ),
      icon: guest.enabled ? ACTIVE_ICON : 'circle',
      value: t(
        guest.found === false
          ? TEXT.missing
          : guest.found === null
            ? TEXT.error
            : guest.enabled
              ? TEXT.guestOn
              : TEXT.guestOff,
        language,
      ),
      color: guest.enabled ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (system?.uptimeSeconds !== null && system?.uptimeSeconds !== undefined) {
    items.push({
      label: t(TEXT.uptime, language),
      icon: 'clock',
      value: shortDuration(system.uptimeSeconds, language),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (hub.router.version) {
    items.push({
      label: t(TEXT.version, language),
      icon: 'package',
      value: fit(hub.router.version, 40),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (items.length) {
    components.push({ type: 'status', items: items.slice(0, MAX_ROWS) });
  }
  if (hub.config.allowCommands) {
    if (hub.router.guest && guest?.found) {
      components.push({
        type: 'button',
        label: t(TEXT.guest, language),
        // The current state is the icon (never the style: `primary` is
        // invisible in dark mode); the tap asks for the other state.
        icon: guest.enabled ? ACTIVE_ICON : 'circle',
        style: 'secondary',
        action: { key: ACTIONS.GUEST, params: { enabled: !guest.enabled }, confirm: true },
      });
    }
    components.push({
      type: 'button',
      label: t(TEXT.reboot, language),
      icon: 'refresh-cw',
      style: 'danger',
      action: { key: ACTIONS.REBOOT, confirm: true },
    });
  }
  return { ttl_seconds: ttlOf(hub), components };
}

const toasts = (key) =>
  Object.fromEntries(Object.entries(DONE_TEXT).map(([language, table]) => [language, table[key]]));

async function actRouter(hub, { actionKey, params = {} }) {
  if (actionKey === ACTIONS.REBOOT) {
    await hub.reboot();
    return { message: toasts('reboot') };
  }
  if (actionKey === ACTIONS.GUEST) {
    const enabled = params.enabled === true || params.enabled === 'true';
    await hub.setGuest(enabled);
    return { message: toasts(enabled ? 'guestOn' : 'guestOff') };
  }
  throw new Error(`Unknown action ${actionKey}`);
}

// --- presence ----------------------------------------------------------------------

/** The followed clients, with their Gladys name and their presence. */
export function presenceRows(hub) {
  const now = hub.now();
  return hub
    .createdDevices(DEVICE_TYPES.CLIENT)
    .map((device) => {
      const mac = parseDeviceId(hub.gladys, device.external_id).id.toUpperCase();
      const record = hub.presence.get(mac);
      return {
        name: device.name || mac,
        present: record?.present ?? null,
        // Away since it was last seen (nothing when never seen since the start).
        since: record?.present === 0 ? (record.lastSeen ?? null) : null,
        now,
        externalId: clientIds(hub.gladys, mac).device,
      };
    })
    .sort(
      (a, b) =>
        (b.present === 1) - (a.present === 1) ||
        (b.present === 0) - (a.present === 0) ||
        a.name.localeCompare(b.name),
    );
}

async function getPresence(hub, { settings = {}, language = 'en' }) {
  if (!hub.config.host) {
    return message(TEXT.noHost, language);
  }
  const all = presenceRows(hub);
  if (all.length === 0) {
    return message(TEXT.noClient, language);
  }
  const rows = settings.show === 'present' ? all.filter((row) => row.present === 1) : all;
  const presentCount = all.filter((row) => row.present === 1).length;
  const components = [
    {
      type: 'value',
      value: presentCount,
      unit: `/ ${all.length}`.slice(0, 6),
      label: t(TEXT.present, language),
      icon: 'users',
      color: presentCount ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
    },
  ];
  if (!hub.snapshot.reachable && hub.snapshot.reachable !== null) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: fit(
        `${t(TEXT.unreachable, language)} · ${hub.router ? routerName(hub.router) : hub.config.host}`,
        80,
      ),
    });
  }
  if (rows.length === 0) {
    components.push({ type: 'text', variant: 'body', text: t(TEXT.nobody, language) });
    return { ttl_seconds: 60, components };
  }
  components.push({
    type: 'status',
    items: rows.slice(0, MAX_ROWS).map((row) => {
      if (row.present === 1) {
        return {
          label: fit(row.name, 40),
          icon: 'user-check',
          value: t(TEXT.isPresent, language),
          color: WIDGET_COLORS.SUCCESS,
        };
      }
      if (row.present === 0) {
        const ago = row.since ? ` · ${shortDuration((row.now - row.since) / 1000, language)}` : '';
        return {
          label: fit(row.name, 40),
          icon: 'user-x',
          value: fit(`${t(TEXT.isAway, language)}${ago}`, 40),
          color: WIDGET_COLORS.NEUTRAL,
        };
      }
      return {
        label: fit(row.name, 40),
        icon: 'help-circle',
        value: t(TEXT.unknown, language),
        color: WIDGET_COLORS.NEUTRAL,
      };
    }),
  });
  if (rows.length > MAX_ROWS && components.length < 4) {
    components.push({
      type: 'text',
      variant: 'caption',
      text: `+${rows.length - MAX_ROWS} ${t(TEXT.more, language)}`,
    });
  }
  return { ttl_seconds: 60, components };
}

async function actPresence(_hub, { actionKey }) {
  throw new Error(`Unknown action ${actionKey}`);
}

export const WIDGETS = {
  [WIDGET_KEYS.ROUTER]: { get: getRouter, action: actRouter },
  [WIDGET_KEYS.PRESENCE]: { get: getPresence, action: actPresence },
};
