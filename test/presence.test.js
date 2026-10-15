// -----------------------------------------------------------------------------
// The presence rules (src/presence.js): what counts as seen, and the
// departure delay.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PresenceTracker, collectClients } from '../src/presence.js';

const A = '00:00:5E:00:53:0A';
const B = '00:00:5E:00:53:0B';
const C = '00:00:5E:00:53:0C';

test('seen: an authorized station, a lease when asked, a reachable neighbour', () => {
  const reading = {
    stations: [
      { mac: A, authorized: true, ssid: 'Home', ifname: 'phy0-ap0' },
      { mac: B, authorized: false, ssid: 'Home', ifname: 'phy0-ap0' },
    ],
    leases: [{ mac: B, ip: '192.0.2.11', hostName: 'b' }],
    neighbours: [{ mac: C, ip: '192.0.2.12', reachable: false }],
    names: [{ mac: C, hostName: 'c', ip: null }],
  };
  const clients = collectClients(reading);
  assert.deepEqual(
    [...clients.values()].map((c) => [c.mac, c.seen, c.sources.join(), c.hostName]),
    [
      [B, false, '', 'b'],
      [C, false, '', 'c'],
      [A, true, 'wifi', null],
    ],
  );
  assert.equal(collectClients(reading, { dhcp: true }).get(B).seen, true);
  reading.neighbours[0].reachable = true;
  assert.deepEqual(collectClients(reading).get(C).sources, ['arp']);
  assert.equal(collectClients(reading, { ignore: new Set([A]) }).has(A), false);
});

test('the departure delay counts from the last time the device was seen', () => {
  let now = 0;
  const tracker = new PresenceTracker({ awayDelayMs: 5 * 60_000, now: () => now });
  const seen = new Map([[A, { seen: true }]]);
  const gone = new Map();
  assert.deepEqual(tracker.update([A, B], seen), [A]);
  assert.equal(tracker.presence(A), 1);
  assert.equal(tracker.presence(B), null, 'unknown until the delay is over');
  now = 4 * 60_000;
  assert.deepEqual(tracker.update([A, B], seen), []);
  now = 5 * 60_000;
  assert.deepEqual(tracker.update([A, B], gone), [B], 'B never seen: away once the delay is over');
  now = 8 * 60_000;
  assert.deepEqual(tracker.update([A, B], gone), [], 'A seen 4 minutes ago: still home');
  now = 9 * 60_000;
  assert.deepEqual(tracker.update([A, B], gone), [A]);
  assert.equal(tracker.presence(A), 0);
  assert.equal(tracker.get(A).lastSeen, 4 * 60_000);
});
