# OpenWrt for Gladys Assistant

An external integration for [Gladys Assistant](https://gladysassistant.com) that
follows [OpenWrt](https://openwrt.org) routers and access points over the local
network, through ubus over HTTP (the interface LuCI uses), with a fallback on
the LuCI RPC API. No cloud, no account.

> **Developed without the hardware: feedback welcome.** The integration is
> built and tested against the answers of OpenWrt as its source code defines
> them (procd, netifd, hostapd, rpcd, rpcd-mod-luci), not against a real router.
> Please report what works and what does not in the
> [issues](https://github.com/guim31/gladys-openwrt/issues).

This project is not affiliated with the OpenWrt project. OpenWrt is a trademark
of its owner.

## Features

- **Presence sensors**: the clients the router sees (Wi-Fi stations of its
  access points through `hostapd.*` or `iwinfo`, DHCP leases) are listed in the
  Discovery tab; each one the user adds becomes a presence sensor. A
  configurable **departure delay** avoids false departures of phones asleep,
  and an outage of the router never marks anyone away. A DHCP lease can count
  as present for wired devices (off by default).
- **The router as a device**: system load, memory used, uptime, OpenWrt
  version, the number of Wi-Fi clients of each radio, the state of the guest
  Wi-Fi, and for each WAN interface its **download and upload rates** and its
  **link state**. The WAN interfaces are detected (`wan` and the interfaces
  holding the default route) or named in the configuration.
- **Commands, off by default**: when the user ticks _Allow commands_, scene
  actions and widget buttons (with confirmation) turn the **guest Wi-Fi** (one
  `wifi-iface` section) on or off and **reboot** the router. Nothing else in
  the router configuration is ever changed, and nothing is exposed as a switch.
- **Scene triggers**: _Unknown device connected_ (a MAC address never seen
  before, remembered across restarts), _WAN link down_ and _WAN link restored_
  (with the length of the outage).
- **Dashboard widgets**: _OpenWrt router_ (health, rates, links, radios, guest
  Wi-Fi, Guest Wi-Fi and Reboot buttons) and _Devices at home_.
- **Test the connection** and **List the Wi-Fi networks** in the Configuration
  screen.
- Every text in English, French, German and Spanish.

## Requirements

- Gladys Assistant **5.1.0** or later (widgets, scene triggers and actions).
- OpenWrt **18.06** or later with `rpcd` and `uhttpd-mod-ubus` (both installed
  with LuCI, present in every standard image). Without `/ubus`, the LuCI RPC
  API (`luci-mod-rpc`) gives the presence, the uptime and the reboot only.
- An rpcd login for Gladys with the ACL given in the user guide: its read part
  is enough for the presence, the measures, the triggers and the widgets; the
  write part (`uci set`/`commit` on `wireless`, `system reboot`) only serves
  the commands.

## Installation

1. On the router, create the ACL file and the rpcd login of the user guide
   ([`docs/en.md`](docs/en.md), section _Set up_).
2. In Gladys, open **Integrations** → **Install from GitHub** and enter the
   address of this repository: `https://github.com/guim31/gladys-openwrt`
   (or install **OpenWrt** from the catalog once it is listed).
3. In **Configuration**, enter the address of the router, the login and its
   password. Save, then click **Test the connection**.
4. Open the **Discover** tab and add the router and the phones to follow.

The user guide is in [`docs/en.md`](docs/en.md) (also in
[French](docs/fr.md), [German](docs/de.md) and [Spanish](docs/es.md)); Gladys
links it from the Configuration screen.

## How it works

- **Session**: `session login` on `/ubus` (JSON-RPC 2.0), then every call
  with the `ubus_rpc_session` token. A session rpcd forgot (reboot, 300 s
  unused) is renewed once, transparently; an object the ACL refuses is
  remembered, not retried at every reading. HTTP redirected to HTTPS by uhttpd
  switches to HTTPS; a self-signed certificate is refused unless the user
  ticks _Accept a self-signed certificate_.
- **Reading**: every refresh interval (10 s to 1 min, 30 s by default):
  `system info`, `network.interface dump`, `network.device status`,
  `network.wireless status`, `hostapd.<ifname> get_clients` (or `iwinfo
assoclist`), `luci-rpc getDHCPLeases` (or the dnsmasq lease file), and the
  `disabled` option of the guest Wi-Fi with `uci get`. `system board` is read
  at each new session. The rates come from the growth of the byte counters of
  the WAN device between two readings. Gladys never polls these devices
  (`should_poll: false`, GladysAssistant/Gladys#3198): the timer is the
  integration's own.
- **Identity**: the router is identified by the MAC address of its first
  Ethernet device (`eth0`), never by the address typed in the configuration;
  a client by its MAC address.
- **States**: only the values that change are sent, for the devices added to
  Gladys only, with a heartbeat every six hours; a present client is sent again
  every two minutes. Everything is sent again when a device is added or Gladys
  reconnects.
- **Commands**: `uci set` of the `disabled` option of the chosen `wifi-iface`
  section then `uci commit wireless` (procd reloads the Wi-Fi), and
  `system reboot`.
- **Storage**: `/data/openwrt-state.json`, the MAC addresses already seen (for
  the unknown-device trigger).

## Development

```bash
npm install
npm test                 # node --test, against the fake Gladys of the SDK and a fake OpenWrt
npm run lint
npm run format:check
```

`scripts/probe.mjs` checks the clients against a real device, read only, and
prints a report without addresses, MACs, names, SSIDs or keys:

```bash
node scripts/probe.mjs 192.168.1.1                                     # an invented account, refused
OPENWRT_USER=gladys OPENWRT_PASSWORD=… node scripts/probe.mjs 192.168.1.1 [--https] [--insecure]
```

The test fixtures (`test/fixtures/openwrt/`) are reconstructed from the source
code of OpenWrt and anonymized (RFC 5737 addresses, RFC 7042 MAC addresses).

## Limits

- One router per integration; presence from its own access points (the DHCP
  lease option sees the rest); the WAN link state is the interface state (an
  outage on the ISP side behind a working link is not seen); the rates are
  averages over the refresh interval; one guest Wi-Fi section. See the Limits
  section of the user guide.

## Credits

- The ubus over HTTP protocol, rpcd sessions and ACLs:
  [OpenWrt documentation](https://openwrt.org/docs/techref/ubus) and the
  sources of [uhttpd](https://github.com/openwrt/uhttpd),
  [rpcd](https://github.com/openwrt/rpcd),
  [netifd](https://github.com/openwrt/netifd) and
  [rpcd-mod-luci](https://github.com/openwrt/luci) (GPL-2.0 / ISC: read for
  the formats, nothing copied).
- The Home Assistant [`ubus`](https://www.home-assistant.io/integrations/ubus)
  and [`luci`](https://www.home-assistant.io/integrations/luci) integrations
  (Apache-2.0) and the
  [openwrt-luci-rpc](https://github.com/fbradyirl/openwrt-luci-rpc) library by
  Finbarr Brady (Apache-2.0), for the device tracking approach and the LuCI RPC
  fallback.
- [kvj/hass_openwrt](https://github.com/kvj/hass_openwrt) (MIT), for the ACL
  of a dedicated rpcd user and the WAN and Wi-Fi readings.
- The structure of [guim31/gladys-mikrotik](https://github.com/guim31/gladys-mikrotik).

## License

[Apache-2.0](LICENSE)
