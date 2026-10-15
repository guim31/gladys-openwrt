// -----------------------------------------------------------------------------
// The real HTTP transport (src/openwrt/http.js) on a loopback socket: the fake
// OpenWrt behind a node:http server, reached by the very clients of the
// integration. Nothing leaves the machine.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { httpRequest } from '../src/openwrt/http.js';
import { openSession } from '../src/openwrt/client.js';
import { ERROR_KINDS } from '../src/openwrt/errors.js';
import { FakeOpenwrt, READ_ACL } from './helpers/fakeOpenwrt.js';

async function serve(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

function fakeServer(device) {
  return (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
      const answer = device.handle(`http://${request.headers.host}${request.url}`, {
        method: request.method,
        json: body,
      });
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    });
  };
}

test('a whole session over a real socket: login and a reading', async (t) => {
  const device = new FakeOpenwrt({
    users: { gladys: { password: 'secret', acl: READ_ACL, uciRead: ['wireless'] } },
  });
  const port = await serve(t, fakeServer(device));
  const { backend } = await openSession({
    api: 'auto',
    host: '127.0.0.1',
    port,
    username: 'gladys',
    password: 'secret',
  });
  const identity = await backend.identity();
  assert.equal(identity.version, '23.05.5');
  const reading = await backend.read({ guestSection: 'guest' });
  assert.equal(reading.stations.length, 5);
  assert.equal(reading.guest.ssid, 'Home-Guests');
  assert.ok(device.requests.every((r) => r.method === 'POST' && r.path === '/ubus'));
});

test('a closed port is unreachable, a slow router times out', async (t) => {
  const port = await serve(t, () => {}); // never answers
  const slow = await openSession({
    api: 'ubus',
    host: '127.0.0.1',
    port,
    username: 'gladys',
    password: 'secret',
    timeoutMs: 200,
  }).catch((err) => err);
  assert.equal(slow.kind, ERROR_KINDS.UNREACHABLE);
  assert.match(slow.message, /ETIMEDOUT/);

  const closed = await openSession({
    api: 'ubus',
    host: '127.0.0.1',
    port: 1,
    username: 'gladys',
    password: 'secret',
  }).catch((err) => err);
  assert.equal(closed.kind, ERROR_KINDS.UNREACHABLE);
});

test('the JSON body is sent with its length, the answer read whole', async (t) => {
  let seen;
  const port = await serve(t, (request, response) => {
    seen = { method: request.method, type: request.headers['content-type'] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: 'x'.repeat(100_000) }));
  });
  const answer = await httpRequest(`http://127.0.0.1:${port}/ubus`, { json: { a: 1 } });
  assert.deepEqual(seen, { method: 'POST', type: 'application/json' });
  assert.equal(JSON.parse(answer.body).ok.length, 100_000);
});
