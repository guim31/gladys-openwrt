// -----------------------------------------------------------------------------
// Conformity with the Gladys core, on every device discovered from realistic
// fixtures (test/fixtures/openwrt/): an OpenWrt 23.05 router with a guest
// Wi-Fi, an OpenWrt 18.06 PPPoE router, a device answering LuCI RPC only, in
// every feature-name language, after the devices are added and read twice
// (rates included).
//
// The table (test/fixtures/gladys-feature-table.json) is extracted from the
// core code: a category/type couple missing there shows as "undefined" or
// without icon in Gladys, a poll frequency outside its list is a 400 on
// discovery, a feature without min/max is a 422 on "Add to Gladys".
// Do not loosen this test to make it pass: fix the integration.
// (Adapted from guim31/gladys-wled and guim31/gladys-mikrotik.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  FakeOpenwrt,
  baseConfig,
  createAll,
  createWorld,
  fullUser,
  later,
} from './helpers/world.js';

const table = JSON.parse(
  await readFile(new URL('./fixtures/gladys-feature-table.json', import.meta.url), 'utf8'),
);

const guest = { guest_wifi: 'guest', presence_dhcp: true };
const scenarios = [
  { label: 'OpenWrt 23.05', fixture: 'openwrt-23.05-e8450', wan: 'wan', config: baseConfig(guest) },
  {
    label: 'OpenWrt 18.06, PPPoE, French names',
    fixture: 'openwrt-18.06-pppoe',
    wan: 'pppoe-wan',
    config: baseConfig({ ...guest, language: 'fr' }),
  },
  {
    label: 'German names, WAN set by hand',
    fixture: 'openwrt-23.05-e8450',
    wan: 'wan',
    config: baseConfig({ ...guest, language: 'de', wan_interfaces: 'wan, wan6, wwan' }),
  },
  {
    label: 'Spanish names',
    fixture: 'openwrt-18.06-pppoe',
    wan: 'pppoe-wan',
    config: baseConfig({ ...guest, language: 'es' }),
  },
  { label: 'LuCI RPC fallback', fixture: 'luci-rpc-18.06', wan: null, config: baseConfig() },
];

for (const scenario of scenarios) {
  test(`every discovered device follows the Gladys rules (${scenario.label})`, async () => {
    const router = new FakeOpenwrt({ fixture: scenario.fixture, users: fullUser() });
    const w = await createWorld({ device: router, config: scenario.config });
    try {
      await createAll(w);
      if (scenario.wan) {
        router.traffic(scenario.wan, 5_000_000, 500_000);
      }
      await later(w, 1);
      const devices = w.fake.discoveredDevices;
      assert.ok(devices.length >= 3, 'the router and clients');
      const deviceIds = new Set();
      const allFeatureIds = new Set();

      for (const device of devices) {
        const where = device.name;
        assert.ok(!deviceIds.has(device.external_id), `${where}: duplicate device external_id`);
        deviceIds.add(device.external_id);
        assert.ok(device.name.length > 0 && device.name.length <= 60, `${where}: name`);

        // should_poll: true if and only if poll_frequency is provided, in ms.
        if (device.poll_frequency === undefined) {
          assert.notEqual(device.should_poll, true, `${where}: should_poll without poll_frequency`);
        } else {
          assert.equal(device.should_poll, true, `${where}: poll_frequency without should_poll`);
          assert.ok(
            table.poll_frequencies_ms.includes(device.poll_frequency),
            `${where}: poll_frequency ${device.poll_frequency} is not one of ${table.poll_frequencies_ms}`,
          );
        }

        assert.ok(device.features.length > 0, `${where}: no feature`);
        const names = new Set();
        for (const feature of device.features) {
          const at = `${where} / ${feature.name}`;
          const pair = table.pairs[`${feature.category}/${feature.type}`];
          assert.ok(
            pair,
            `${at}: ${feature.category}/${feature.type} is not a couple Gladys knows`,
          );
          assert.ok(
            pair.label_en && pair.label_fr && pair.icon,
            `${at}: couple without label or icon`,
          );

          assert.equal(typeof feature.min, 'number', `${at}: min must be a number`);
          assert.equal(typeof feature.max, 'number', `${at}: max must be a number`);
          assert.ok(
            Number.isFinite(feature.min) && Number.isFinite(feature.max),
            `${at}: finite min/max`,
          );
          assert.ok(feature.min <= feature.max, `${at}: min > max`);
          assert.equal(typeof feature.read_only, 'boolean', `${at}: read_only must be a boolean`);
          assert.equal(
            typeof feature.has_feedback,
            'boolean',
            `${at}: has_feedback must be a boolean`,
          );
          assert.equal(feature.read_only, true, `${at}: nothing is a controllable feature`);
          if (feature.unit !== undefined) {
            assert.ok(table.units.includes(feature.unit), `${at}: unknown unit ${feature.unit}`);
          }

          assert.ok(!allFeatureIds.has(feature.external_id), `${at}: duplicate external_id`);
          allFeatureIds.add(feature.external_id);
          assert.ok(!names.has(feature.name), `${at}: duplicate feature name on the device`);
          names.add(feature.name);
          assert.ok(feature.name.length <= 60, `${at}: name too long`);

          // The value read from the fixtures fits the declared bounds.
          const value = w.fake.lastState(feature.external_id);
          if (value === undefined) {
            continue; // a WAN interface the router does not have
          }
          if (feature.category === 'text') {
            assert.equal(typeof value, 'string', `${at}: a text feature receives { text }`);
            assert.ok(value.length > 0, `${at}: empty text`);
            continue;
          }
          assert.equal(typeof value, 'number', `${at}: ${value} is not a number`);
          assert.ok(value >= feature.min && value <= feature.max, `${at}: ${value} out of bounds`);
          if (feature.type === 'integer' || feature.type === 'binary') {
            assert.ok(Number.isInteger(value), `${at}: ${value} is not an integer`);
          }
        }
      }
      // Every router feature has received a value, an interface the router lacks excepted.
      const routerDevice = devices[0];
      const missing = routerDevice.features.filter(
        (f) => w.fake.lastState(f.external_id) === undefined && !f.external_id.includes('wwan'),
      );
      assert.deepEqual(
        missing.map((f) => f.name),
        [],
      );
    } finally {
      await w.app.stop();
    }
  });
}
