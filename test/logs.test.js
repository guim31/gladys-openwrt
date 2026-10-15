// -----------------------------------------------------------------------------
// What the integration writes at the default level (info): the lifecycle
// only. A normal reading writes nothing, a failure that repeats is logged
// once, and its end once. Never a password, a session token nor a Wi-Fi key
// (network.wireless status carries them), even at debug.
// (Adapted from guim31/gladys-mikrotik.)
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FakeOpenwrt,
  PASSWORD,
  baseConfig,
  createAll,
  createWorld,
  later,
} from './helpers/world.js';

/** Capture the lines of the SDK logger at the given LOG_LEVEL. */
function captureLogs(t, level = 'info') {
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = level;
  t.after(() => {
    process.env.LOG_LEVEL = previous;
  });
  const lines = [];
  const record =
    (stream) =>
    (...args) =>
      lines.push({
        stream,
        text: args.map((arg) => (arg instanceof Error ? arg.stack : String(arg))).join(' '),
      });
  t.mock.method(console, 'log', record('out'));
  t.mock.method(console, 'error', record('err'));
  return { lines, clear: () => lines.splice(0), texts: () => lines.map((line) => line.text) };
}

async function world(t, options = {}) {
  const w = await createWorld(options);
  t.after(() => w.app.stop());
  return w;
}

test('a normal reading cycle writes nothing at info', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: baseConfig({ guest_wifi: 'guest' }) });
  assert.ok(
    logs.texts().some((text) => text.includes('connected with ubus')),
    'the start is logged',
  );
  await createAll(w);
  logs.clear();
  for (let i = 0; i < 5; i += 1) {
    w.router.traffic('wan', 1_000_000 * i, 100_000);
    w.router.setLoad(0.1 * i);
    w.router.associate(`00:00:5E:00:53:2${i}`, 'phy1-ap0');
    w.router.dissociate(`00:00:5E:00:53:2${i}`);
    await later(w, 10);
  }
  assert.deepEqual(logs.texts(), []);
});

test('a router that stays down is logged once, and once when it is back', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  logs.clear();
  w.router.goOffline();
  for (let i = 0; i < 6; i += 1) {
    await later(w, 1);
  }
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.equal(logs.lines[0].stream, 'err');
  logs.clear();
  w.router.goOnline();
  await later(w, 1);
  await later(w, 1);
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /connection restored/);
});

test('a refused password is logged once and never written', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: baseConfig({ password: 'wrong-password-123' }) });
  for (let i = 0; i < 5; i += 1) {
    await later(w, 6);
  }
  const warnings = logs.lines.filter((line) => line.stream === 'err');
  assert.equal(warnings.length, 1, logs.texts().join('\n'));
  assert.ok(!logs.texts().join('\n').includes('wrong-password-123'));
});

test('an object the ACL refuses is one warning, not one per reading', async (t) => {
  const logs = captureLogs(t);
  const device = new FakeOpenwrt({
    users: {
      gladys: {
        password: PASSWORD,
        acl: ['system board', 'system info', 'network.interface dump', 'network.device status'],
      },
    },
  });
  const w = await world(t, { device });
  for (let i = 0; i < 5; i += 1) {
    await later(w, 1);
  }
  const warnings = logs.lines.filter((line) => line.stream === 'err');
  assert.ok(warnings.some((line) => /network\.wireless status not readable/.test(line.text)));
  assert.equal(warnings.length, new Set(warnings.map((line) => line.text)).size, 'no repeat');
});

test('Gladys refusing the states is logged once', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t);
  await createAll(w);
  logs.clear();
  w.gladys.publishStates = async () => {
    throw new Error('HTTP 500');
  };
  for (let i = 0; i < 4; i += 1) {
    w.router.setLoad(0.2 + i / 10);
    await later(w, 1);
  }
  assert.equal(logs.lines.length, 1, logs.texts().join('\n'));
  assert.match(logs.lines[0].text, /States refused/);
});

test('one line per user command', async (t) => {
  const logs = captureLogs(t);
  const w = await world(t, { config: baseConfig({ guest_wifi: 'guest', allow_commands: true }) });
  logs.clear();
  await w.fake.sceneAction('disable_guest_wifi', {});
  assert.deepEqual(logs.texts().length, 1);
  assert.match(logs.texts()[0], /Guest Wi-Fi "guest" disabled/);
});

test('LOG_LEVEL=debug shows each problem; no password, token nor Wi-Fi key, ever', async (t) => {
  const logs = captureLogs(t, 'debug');
  const w = await world(t, { config: baseConfig({ guest_wifi: 'guest', allow_commands: true }) });
  await createAll(w);
  w.router.goOffline();
  await later(w, 1);
  await later(w, 1);
  w.router.goOnline();
  w.router.expireSessions();
  await later(w, 1);
  await w.fake.action('test_connection', {});
  await w.fake.action('list_wifi_networks', {});
  await w.fake.sceneAction('disable_guest_wifi', {});
  const text = logs.texts().join('\n');
  assert.match(text, /\[DEBUG\].*again/);
  assert.ok(!text.includes(PASSWORD), 'never the password');
  assert.ok(!text.includes('not-a-real-wifi-key'), 'never a Wi-Fi key');
  for (const token of w.router.sessions.keys()) {
    assert.ok(!text.includes(token), 'never a session token');
  }
});
