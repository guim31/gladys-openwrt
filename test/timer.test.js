// -----------------------------------------------------------------------------
// The reading timer of the container. Gladys never polls a device published
// with should_poll: false (and does not reliably poll external devices,
// GladysAssistant/Gladys#3198): the router must be read by the hub's own
// timer, with no onPoll at all.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseConfig, createAll, createClock, createWorld, ids } from './helpers/world.js';

const settle = async () => {
  for (let i = 0; i < 50; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
};

test('the internal timer reads the router without any onPoll from Gladys', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clock = createClock();
  const w = await createWorld({ clock, timers: true, config: baseConfig({ poll_interval: '30' }) });
  t.after(() => w.app.stop());
  const polled = t.mock.method(w.hub, 'pollDevice');
  await createAll(w);
  for (const device of w.fake.discoveredDevices) {
    assert.equal(device.should_poll, false, 'Gladys is not asked to poll');
  }
  const reads = () =>
    w.router.calls.filter((c) => c.object === 'system' && c.method === 'info').length;
  const before = reads();
  const load = ids(w.gladys).router().feature('load');
  for (const value of [0.21, 0.22, 0.23]) {
    w.router.setLoad(value);
    clock.advance(30_000);
    t.mock.timers.tick(30_000);
    await settle();
    assert.equal(w.fake.lastState(load), Math.round(value * 100));
  }
  assert.equal(reads() - before, 3, 'one reading per interval');
  assert.equal(polled.mock.callCount(), 0, 'no onPoll involved');
});

test('onPoll stays a harmless fallback: one shared reading', async (t) => {
  const w = await createWorld();
  t.after(() => w.app.stop());
  const before = w.router.calls.length;
  const [router] = w.fake.discoveredDevices;
  const acks = await Promise.all([w.fake.poll(router), w.fake.poll(router)]);
  assert.ok(acks.every((ack) => ack.success));
  const infos = w.router.calls.slice(before).filter((c) => c.method === 'info');
  assert.equal(infos.length, 1);
});

test('the timer stops with the integration', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = await createWorld({ timers: true });
  await w.app.stop();
  const before = w.router.calls.length;
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(w.router.calls.length, before);
});
