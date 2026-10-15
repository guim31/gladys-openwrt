// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widgets (src/widgets.js):
// connection status, errors, the reports of the configuration actions, the
// errors of the commands. Four languages, the four of the Gladys interface;
// German says "du", Spanish "usted". test/i18n.test.js checks every table.
// Product and protocol names (OpenWrt, LuCI, ubus, rpcd, HTTPS) stay as is.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './openwrt/errors.js';

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

export const CONNECTION_TEXT = {
  noHost: {
    en: 'Enter the address of your OpenWrt router in the configuration.',
    fr: "Saisissez l'adresse de votre routeur OpenWrt dans la configuration.",
    de: 'Gib die Adresse deines OpenWrt-Routers in der Konfiguration ein.',
    es: 'Introduzca la dirección de su router OpenWrt en la configuración.',
  },
  invalidHost: {
    en: 'Address not understood, e.g. 192.168.1.1',
    fr: 'Adresse incomprise, ex. 192.168.1.1',
    de: 'Adresse nicht verstanden, z. B. 192.168.1.1',
    es: 'Dirección no válida, p. ej. 192.168.1.1',
  },
  connecting: {
    en: 'Connecting to the router…',
    fr: 'Connexion au routeur…',
    de: 'Verbindung zum Router…',
    es: 'Conectando con el router…',
  },
};

// One short explanation per error kind (src/openwrt/errors.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'the router does not answer at this address',
    fr: 'le routeur ne répond pas à cette adresse',
    de: 'der Router antwortet unter dieser Adresse nicht',
    es: 'el router no responde en esta dirección',
  },
  [ERROR_KINDS.TLS]: {
    en: 'certificate refused: tick "Accept a self-signed certificate"',
    fr: 'certificat refusé : cochez « Accepter un certificat auto-signé »',
    de: 'Zertifikat abgelehnt: Aktiviere „Selbstsigniertes Zertifikat akzeptieren“',
    es: 'certificado rechazado: marque «Aceptar un certificado autofirmado»',
  },
  [ERROR_KINDS.NOT_OPENWRT]: {
    en: 'no ubus nor LuCI RPC here: install rpcd and uhttpd-mod-ubus',
    fr: 'ni ubus ni LuCI RPC ici : installez rpcd et uhttpd-mod-ubus',
    de: 'weder ubus noch LuCI RPC hier: Installiere rpcd und uhttpd-mod-ubus',
    es: 'ni ubus ni LuCI RPC aquí: instale rpcd y uhttpd-mod-ubus',
  },
  [ERROR_KINDS.AUTH]: {
    en: 'user name or password refused by rpcd',
    fr: "nom d'utilisateur ou mot de passe refusé par rpcd",
    de: 'Benutzername oder Passwort von rpcd abgelehnt',
    es: 'nombre de usuario o contraseña rechazados por rpcd',
  },
  [ERROR_KINDS.PERMISSION]: {
    en: 'refused by the rpcd ACL of the user: see the documentation',
    fr: "refusé par l'ACL rpcd de l'utilisateur : voir la documentation",
    de: 'von der rpcd-ACL des Benutzers abgelehnt: Sieh in der Doku nach',
    es: 'rechazado por la ACL rpcd del usuario: consulte la documentación',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'this OpenWrt does not offer the function',
    fr: 'cet OpenWrt ne propose pas la fonction',
    de: 'dieses OpenWrt bietet die Funktion nicht an',
    es: 'este OpenWrt no ofrece la función',
  },
  [ERROR_KINDS.PROTOCOL]: {
    en: 'unexpected answer from the router, see the logs',
    fr: 'réponse inattendue du routeur, voir les logs',
    de: 'unerwartete Antwort des Routers, sieh in den Protokollen nach',
    es: 'respuesta inesperada del router, consulte los registros',
  },
};

// The "Test the connection" report.
export const REPORT_TEXT = {
  en: {
    connected: (api, name, version) => `Connected with ${api} to ${name} (OpenWrt ${version}).`,
    luciFallback:
      'LuCI RPC fallback: presence from the neighbour table and uptime only. Install uhttpd-mod-ubus for everything.',
    wan: 'WAN',
    noWan: 'No WAN interface found: enter its name in the configuration (e.g. wan).',
    wanSource: { config: 'from the configuration', auto: 'detected automatically' },
    up: 'up',
    down: 'down',
    missing: 'not found',
    radios: (list) => `Wi-Fi radios: ${list}.`,
    noRadio: 'No Wi-Fi radio.',
    clients: ({ wifi, leases, neighbours }) =>
      `Seen now: ${wifi} on Wi-Fi, ${leases} DHCP leases, ${neighbours} neighbours.`,
    notRead: 'Not readable (ACL or missing package)',
    guestOn: (ssid) => `Guest Wi-Fi "${ssid}": enabled.`,
    guestOff: (ssid) => `Guest Wi-Fi "${ssid}": disabled.`,
    guestMissing: 'Guest Wi-Fi: no wifi-iface section with this name in /etc/config/wireless.',
    guestDenied: 'Guest Wi-Fi: the ACL does not allow reading the wireless configuration.',
    guestInvalid: 'Guest Wi-Fi: enter the name of a wifi-iface section (letters, digits, _).',
    commandsOn: 'Commands enabled.',
    commandsOff: 'Commands disabled (read only).',
    tlsHint:
      'HTTPS answers with a self-signed certificate: tick "Accept a self-signed certificate" to use it.',
    plainHint: 'The password travels unencrypted on your network: prefer HTTPS.',
  },
  fr: {
    connected: (api, name, version) => `Connecté en ${api} à ${name} (OpenWrt ${version}).`,
    luciFallback:
      'Repli LuCI RPC : présence par la table des voisins et temps de fonctionnement seulement. Installez uhttpd-mod-ubus pour tout le reste.',
    wan: 'WAN',
    noWan: 'Aucune interface WAN trouvée : saisissez son nom dans la configuration (ex. wan).',
    wanSource: { config: 'de la configuration', auto: 'détection automatique' },
    up: 'actif',
    down: 'coupé',
    missing: 'introuvable',
    radios: (list) => `Radios Wi-Fi : ${list}.`,
    noRadio: 'Aucune radio Wi-Fi.',
    clients: ({ wifi, leases, neighbours }) =>
      `Vus maintenant : ${wifi} en Wi-Fi, ${leases} baux DHCP, ${neighbours} voisins.`,
    notRead: 'Illisible (ACL ou paquet manquant)',
    guestOn: (ssid) => `Wi-Fi invité « ${ssid} » : activé.`,
    guestOff: (ssid) => `Wi-Fi invité « ${ssid} » : désactivé.`,
    guestMissing: 'Wi-Fi invité : aucune section wifi-iface de ce nom dans /etc/config/wireless.',
    guestDenied: "Wi-Fi invité : l'ACL ne permet pas de lire la configuration wireless.",
    guestInvalid:
      "Wi-Fi invité : saisissez le nom d'une section wifi-iface (lettres, chiffres, _).",
    commandsOn: 'Commandes activées.',
    commandsOff: 'Commandes désactivées (lecture seule).',
    tlsHint:
      'HTTPS répond avec un certificat auto-signé : cochez « Accepter un certificat auto-signé » pour l’utiliser.',
    plainHint: 'Le mot de passe circule en clair sur votre réseau : préférez HTTPS.',
  },
  de: {
    connected: (api, name, version) => `Verbunden über ${api} mit ${name} (OpenWrt ${version}).`,
    luciFallback:
      'LuCI-RPC-Ausweichlösung: nur Anwesenheit über die Nachbartabelle und Betriebszeit. Installiere uhttpd-mod-ubus für alles.',
    wan: 'WAN',
    noWan:
      'Keine WAN-Schnittstelle gefunden: Gib ihren Namen in der Konfiguration ein (z. B. wan).',
    wanSource: { config: 'aus der Konfiguration', auto: 'automatisch erkannt' },
    up: 'aktiv',
    down: 'getrennt',
    missing: 'nicht gefunden',
    radios: (list) => `WLAN-Funkmodule: ${list}.`,
    noRadio: 'Kein WLAN-Funkmodul.',
    clients: ({ wifi, leases, neighbours }) =>
      `Gerade gesehen: ${wifi} im WLAN, ${leases} DHCP-Leases, ${neighbours} Nachbarn.`,
    notRead: 'Nicht lesbar (ACL oder fehlendes Paket)',
    guestOn: (ssid) => `Gäste-WLAN „${ssid}“: aktiviert.`,
    guestOff: (ssid) => `Gäste-WLAN „${ssid}“: deaktiviert.`,
    guestMissing: 'Gäste-WLAN: kein wifi-iface-Abschnitt mit diesem Namen in /etc/config/wireless.',
    guestDenied: 'Gäste-WLAN: Die ACL erlaubt das Lesen der WLAN-Konfiguration nicht.',
    guestInvalid:
      'Gäste-WLAN: Gib den Namen eines wifi-iface-Abschnitts ein (Buchstaben, Ziffern, _).',
    commandsOn: 'Befehle aktiviert.',
    commandsOff: 'Befehle deaktiviert (nur lesen).',
    tlsHint:
      'HTTPS antwortet mit einem selbstsignierten Zertifikat: Aktiviere „Selbstsigniertes Zertifikat akzeptieren“, um es zu nutzen.',
    plainHint:
      'Das Passwort wird unverschlüsselt in deinem Netzwerk übertragen: Nutze lieber HTTPS.',
  },
  es: {
    connected: (api, name, version) => `Conectado por ${api} a ${name} (OpenWrt ${version}).`,
    luciFallback:
      'Alternativa LuCI RPC: solo presencia por la tabla de vecinos y tiempo de funcionamiento. Instale uhttpd-mod-ubus para todo lo demás.',
    wan: 'WAN',
    noWan:
      'No se ha encontrado ninguna interfaz WAN: introduzca su nombre en la configuración (p. ej. wan).',
    wanSource: { config: 'de la configuración', auto: 'detección automática' },
    up: 'activo',
    down: 'cortado',
    missing: 'no encontrado',
    radios: (list) => `Radios Wi-Fi: ${list}.`,
    noRadio: 'Ninguna radio Wi-Fi.',
    clients: ({ wifi, leases, neighbours }) =>
      `Vistos ahora: ${wifi} por Wi-Fi, ${leases} concesiones DHCP, ${neighbours} vecinos.`,
    notRead: 'No legible (ACL o paquete ausente)',
    guestOn: (ssid) => `Wi-Fi de invitados «${ssid}»: activado.`,
    guestOff: (ssid) => `Wi-Fi de invitados «${ssid}»: desactivado.`,
    guestMissing:
      'Wi-Fi de invitados: ninguna sección wifi-iface con este nombre en /etc/config/wireless.',
    guestDenied: 'Wi-Fi de invitados: la ACL no permite leer la configuración wireless.',
    guestInvalid:
      'Wi-Fi de invitados: introduzca el nombre de una sección wifi-iface (letras, cifras, _).',
    commandsOn: 'Órdenes activadas.',
    commandsOff: 'Órdenes desactivadas (solo lectura).',
    tlsHint:
      'HTTPS responde con un certificado autofirmado: marque «Aceptar un certificado autofirmado» para usarlo.',
    plainHint: 'La contraseña viaja sin cifrar por su red: es preferible HTTPS.',
  },
};

// The "List the Wi-Fi networks" report.
export const NETWORKS_TEXT = {
  en: {
    intro: 'Enabled Wi-Fi networks (copy the section name for the guest Wi-Fi):',
    none: 'No enabled Wi-Fi network (a disabled one is not listed by OpenWrt).',
    clients: (count) => `${count} client(s)`,
    guest: 'guest Wi-Fi',
    needsUbus: 'Listing the Wi-Fi networks needs ubus.',
  },
  fr: {
    intro: 'Réseaux Wi-Fi activés (copiez le nom de section pour le Wi-Fi invité) :',
    none: 'Aucun réseau Wi-Fi activé (OpenWrt ne liste pas un réseau désactivé).',
    clients: (count) => `${count} client(s)`,
    guest: 'Wi-Fi invité',
    needsUbus: 'Lister les réseaux Wi-Fi nécessite ubus.',
  },
  de: {
    intro: 'Aktive WLAN-Netze (kopiere den Abschnittsnamen für das Gäste-WLAN):',
    none: 'Kein aktives WLAN-Netz (OpenWrt listet ein deaktiviertes nicht auf).',
    clients: (count) => `${count} Client(s)`,
    guest: 'Gäste-WLAN',
    needsUbus: 'Zum Auflisten der WLAN-Netze ist ubus nötig.',
  },
  es: {
    intro: 'Redes Wi-Fi activadas (copie el nombre de la sección para el Wi-Fi de invitados):',
    none: 'Ninguna red Wi-Fi activada (OpenWrt no lista una red desactivada).',
    clients: (count) => `${count} cliente(s)`,
    guest: 'Wi-Fi de invitados',
    needsUbus: 'Listar las redes Wi-Fi requiere ubus.',
  },
};

// Errors of the commands (scene actions and widget buttons), shown in Gladys.
export const ACTION_TEXT = {
  disabled: {
    en: 'Commands are disabled: tick "Allow commands" in the configuration.',
    fr: 'Les commandes sont désactivées : cochez « Autoriser les commandes » dans la configuration.',
    de: 'Befehle sind deaktiviert: Aktiviere „Befehle erlauben“ in der Konfiguration.',
    es: 'Las órdenes están desactivadas: marque «Permitir órdenes» en la configuración.',
  },
  noGuest: {
    en: 'No guest Wi-Fi chosen: enter its section name in the configuration.',
    fr: 'Aucun Wi-Fi invité choisi : saisissez son nom de section dans la configuration.',
    de: 'Kein Gäste-WLAN gewählt: Gib seinen Abschnittsnamen in der Konfiguration ein.',
    es: 'Ningún Wi-Fi de invitados elegido: introduzca su nombre de sección en la configuración.',
  },
  guestNotFound: {
    en: 'The router has no wifi-iface section with this name.',
    fr: "Le routeur n'a aucune section wifi-iface de ce nom.",
    de: 'Der Router hat keinen wifi-iface-Abschnitt mit diesem Namen.',
    es: 'El router no tiene ninguna sección wifi-iface con este nombre.',
  },
  permission: {
    en: 'Refused by the router: the rpcd ACL of the user lacks the write rights of the documentation.',
    fr: "Refusé par le routeur : il manque à l'ACL rpcd de l'utilisateur les droits d'écriture de la documentation.",
    de: 'Vom Router abgelehnt: Der rpcd-ACL des Benutzers fehlen die Schreibrechte aus der Doku.',
    es: 'Rechazado por el router: a la ACL rpcd del usuario le faltan los permisos de escritura de la documentación.',
  },
  needsUbus: {
    en: 'The guest Wi-Fi needs ubus: install uhttpd-mod-ubus on the router.',
    fr: 'Le Wi-Fi invité nécessite ubus : installez uhttpd-mod-ubus sur le routeur.',
    de: 'Das Gäste-WLAN braucht ubus: Installiere uhttpd-mod-ubus auf dem Router.',
    es: 'El Wi-Fi de invitados requiere ubus: instale uhttpd-mod-ubus en el router.',
  },
};

export const LANGUAGE_FALLBACK = 'en';

/** "Name: text", with the space French puts before a colon. */
export const labelled = (name, value, language) =>
  `${name}${language === 'fr' ? ' : ' : ': '}${value}`;
export const pick = (table, language) => table?.[language] ?? table?.[LANGUAGE_FALLBACK] ?? '';
