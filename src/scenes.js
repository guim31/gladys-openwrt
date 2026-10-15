// -----------------------------------------------------------------------------
// Scene action handlers (manifest `scene_actions`, Gladys 5.1+). They do
// nothing unless "Allow commands" is ticked in the configuration, and the
// router answers with its own refusal when the rpcd ACL of the user lacks the
// write rights.
//
//   - enable / disable the guest Wi-Fi chosen in the configuration (one
//     wifi-iface section): "guest Wi-Fi on when guests arrive, off at night";
//   - reboot the router.
//
// Never anything else: the integration changes nothing in the router
// configuration beyond the `disabled` option of that one Wi-Fi network.
// -----------------------------------------------------------------------------

export const SCENE_ACTIONS = {
  async enable_guest_wifi(hub) {
    const { enabled } = await hub.setGuest(true);
    return { enabled };
  },

  async disable_guest_wifi(hub) {
    const { enabled } = await hub.setGuest(false);
    return { enabled };
  },

  async reboot_router(hub) {
    await hub.reboot();
    return undefined;
  },
};
