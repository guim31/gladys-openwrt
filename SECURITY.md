# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes.

What the integration handles:

- **Secrets**: the rpcd user name and password are fields of the Gladys
  configuration (the password a `secret` field). The integration reads them
  from Gladys at startup, keeps them in memory, sends them only to the router
  typed in the configuration (the `session login` call of ubus, or the login
  of the LuCI RPC API), and never writes them to `/data` nor to the logs. The
  session token rpcd answers stays in memory and is never logged either. A
  read-only rpcd ACL is enough unless the commands are allowed.
- **Wi-Fi keys**: `network.wireless status` (and `uci get wireless`, granted
  for the guest Wi-Fi) can return the Wi-Fi keys of the router. The
  integration keeps only the radio and network names, the SSIDs and the
  `disabled` option of the guest network; it never stores, logs or sends a
  key to Gladys.
- **Stored in `/data`**: `openwrt-state.json`, the MAC addresses already seen
  on the network with the date they were first seen (for the "Unknown device
  connected" trigger, 5,000 at most). Nothing else.
- **Network**: requests go only to the router address of the configuration,
  on the local network: ubus (`/ubus`) or LuCI RPC (`/cgi-bin/luci/rpc/*`)
  over HTTP (80) or HTTPS (443). Over HTTP the password travels unencrypted on
  the LAN, and the connection test says so. Certificates are verified unless
  the user ticks "Accept a self-signed certificate". The integration opens no
  port and calls no cloud service.
- **Changes to the router**: none unless "Allow commands" is ticked. Then
  only the `disabled` option of the one `wifi-iface` section named in the
  configuration (`uci set` + `uci commit wireless`), and a reboot, from a
  scene action or a widget button with confirmation. Nothing is exposed as a
  switch.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
OpenWrt itself (see its [security page](https://openwrt.org/docs/guide-developer/security)),
and the other devices and services of your network.
