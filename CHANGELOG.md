# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]

### Added

- OpenWrt routers and access points (OpenWrt 18.06 or later) through ubus over
  HTTP, the interface LuCI uses, with an rpcd login of their own; a read-only
  ACL is enough. HTTPS with a self-signed certificate on request. Routers
  without `/ubus` fall back on the LuCI RPC API (presence and uptime only).
- Presence sensors: add the phones and computers seen by the router (Wi-Fi
  stations of its access points, DHCP leases) from the Discovery tab. A
  departure delay avoids false departures of phones asleep, and an outage of
  the router never sends anyone away. A DHCP lease can count as present for
  wired devices.
- The router as a device: system load, memory used, uptime, OpenWrt version,
  Wi-Fi clients per radio, guest Wi-Fi state, and for each WAN interface its
  download and upload rates and its link state.
- Commands, off by default ("Allow commands"): turn the guest Wi-Fi on or off,
  reboot the router, from a scene action or a widget button with
  confirmation. Nothing else in the router configuration is ever changed.
- Scene triggers "Unknown device connected", "WAN link down" and "WAN link
  restored" (with the length of the outage).
- Dashboard widgets "OpenWrt router" and "Devices at home".
- "Test the connection" and "List the Wi-Fi networks" in the Configuration
  screen.
- Texts and documentation in English, French, German and Spanish.

[Unreleased]: https://github.com/guim31/gladys-openwrt/commits/main
