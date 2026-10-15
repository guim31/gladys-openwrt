// -----------------------------------------------------------------------------
// Normalization of the configuration (src/config.js): what the user types in
// the Gladys form becomes plain values, and nothing unusable gets through.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, parseAddress, splitList } from '../src/config.js';

test('the address: IP, name, port, URL copied from the browser, IPv6', () => {
  assert.deepEqual(parseAddress('192.0.2.1'), { host: '192.0.2.1', port: null, https: false });
  assert.deepEqual(parseAddress(' openwrt.lan:8080 '), {
    host: 'openwrt.lan',
    port: 8080,
    https: false,
  });
  assert.deepEqual(parseAddress('https://192.0.2.1/cgi-bin/luci/'), {
    host: '192.0.2.1',
    port: null,
    https: true,
  });
  assert.deepEqual(parseAddress('[2001:db8::1]:443'), {
    host: '2001:db8::1',
    port: 443,
    https: false,
  });
  assert.equal(parseAddress('ssh://192.0.2.1'), null);
  assert.equal(parseAddress('http://root:pw@192.0.2.1'), null, 'never credentials in the address');
  assert.equal(parseAddress(''), null);
  assert.equal(parseAddress(42), null);
});

test('the defaults of an empty configuration', () => {
  const config = normalizeConfig({});
  assert.equal(config.host, null);
  assert.equal(config.invalidHost, false);
  assert.equal(config.https, false);
  assert.equal(config.api, 'auto');
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.awayDelayMs, 5 * 60_000);
  assert.equal(config.allowCommands, false);
  assert.equal(config.guestSection, null);
  assert.equal(config.language, 'fr');
  assert.deepEqual(normalizeConfig(null), normalizeConfig(DEFAULT_CONFIG));
});

test('typed values are cleaned: numbers as strings, lists, bounds, unknown options', () => {
  const config = normalizeConfig({
    host: 'https://192.0.2.1:8443',
    away_delay: '2,6',
    poll_interval: 45,
    api: 'telnet',
    wan_interfaces: 'wan, wwan;wan, bad name, lte, vpn, extra',
    guest_wifi: ' guest ',
    language: 'it',
    allow_commands: 'true',
    password: ' spaced pw ',
  });
  assert.equal(config.host, '192.0.2.1');
  assert.equal(config.port, 8443);
  assert.equal(config.https, true, 'an https:// address turns HTTPS on');
  assert.equal(config.awayDelayMs, 3 * 60_000);
  assert.equal(config.pollIntervalMs, 30_000);
  assert.equal(config.api, 'auto');
  assert.deepEqual(config.wanInterfaces, ['wan', 'wwan', 'lte', 'vpn']);
  assert.equal(config.guestSection, 'guest');
  assert.equal(config.language, 'fr');
  assert.equal(config.allowCommands, true);
  assert.equal(config.password, ' spaced pw ', 'the password is kept as typed');
  assert.equal(normalizeConfig({ away_delay: 500 }).awayDelayMs, 60 * 60_000);
  assert.equal(normalizeConfig({ away_delay: -3 }).awayDelayMs, 5 * 60_000);
});

test('an address or a guest section that cannot be used is flagged', () => {
  const config = normalizeConfig({ host: 'ftp://router', guest_wifi: 'Home Guests' });
  assert.equal(config.host, null);
  assert.equal(config.invalidHost, true);
  assert.equal(config.guestSection, null);
  assert.equal(config.invalidGuest, true);
});

test('lists are split on commas, semicolons and lines, without blanks nor duplicates', () => {
  assert.deepEqual(splitList(' a, b ;\nc,,a '), ['a', 'b', 'c']);
  assert.deepEqual(splitList(undefined), []);
});
