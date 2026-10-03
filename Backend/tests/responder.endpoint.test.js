import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { PROTOTYPE_RESPONDERS } from '../src/modules/responders/responder.data.js';
import {
  filterEligibleResponders,
  getNearbyResponders,
} from '../src/modules/responders/responder.service.js';

const sign = (userId) =>
  jwt.sign({ sub: userId, role: 'USER' }, env.jwtSecret, { expiresIn: '5m' });

let server;
let port;

const get = async (pathAndQuery, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  return { status: res.status, body: await res.json() };
};

const moduleDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'modules',
  'responders'
);

const moduleSources = fs
  .readdirSync(moduleDir)
  .map((file) => fs.readFileSync(path.join(moduleDir, file), 'utf8'));

before(async () => {
  server = http.createServer(app);
  port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('rejects an unauthenticated request', async () => {
  const { status, body } = await get('/api/v1/responders/nearby', null);

  assert.equal(status, 401);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('returns the prototype responder payload in the standard envelope', async () => {
  const { status, body } = await get('/api/v1/responders/nearby', sign('user-1'));

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const data = body.data;
  assert.equal(data.radiusKm, 2, 'the 2 km business-rule label');
  assert.equal(data.source, 'PROTOTYPE_HARDCODED', 'clearly not real discovery');
  assert.ok(Array.isArray(data.responders));
  assert.ok(data.responders.length > 0);
});

test('every responder exposes exactly id, name, phone and status', async () => {
  const { body } = await get('/api/v1/responders/nearby', sign('user-1'));

  for (const responder of body.data.responders) {
    assert.deepEqual(Object.keys(responder).sort(), ['id', 'name', 'phone', 'status']);
    assert.equal(typeof responder.id, 'string');
    assert.equal(typeof responder.name, 'string');
    assert.equal(typeof responder.phone, 'string');
    assert.equal(responder.status, 'ONLINE');

    const forbidden = ['password', 'passwordHash', 'token', 'apiKey', 'latitude', 'longitude', 'lat', 'lng'];
    for (const key of Object.keys(responder)) {
      assert.ok(!forbidden.includes(key), `unexpected field: ${key}`);
    }
  }
});

test('only ONLINE responders are returned; the offline sample is filtered out', async () => {
  assert.ok(
    PROTOTYPE_RESPONDERS.some((responder) => responder.status === 'OFFLINE'),
    'the dataset must contain an offline sample to prove filtering'
  );

  const { body } = await get('/api/v1/responders/nearby', sign('user-1'));
  const returned = body.data.responders.map((responder) => responder.id);
  const offline = PROTOTYPE_RESPONDERS.filter((responder) => responder.status === 'OFFLINE').map(
    (responder) => responder.id
  );

  assert.ok(offline.length > 0);
  for (const id of offline) {
    assert.ok(!returned.includes(id), `offline responder ${id} must not be returned`);
  }

  const online = PROTOTYPE_RESPONDERS.filter((responder) => responder.status === 'ONLINE').map(
    (responder) => responder.id
  );
  assert.deepEqual(returned, online, 'every online sample is returned, in dataset order');
});

test('output is deterministic across identical requests', async () => {
  const first = await get('/api/v1/responders/nearby', sign('user-1'));
  const second = await get('/api/v1/responders/nearby', sign('user-2'));

  assert.deepEqual(second.body, first.body);
});

test('query parameters cannot alter the dataset', async () => {
  const clean = await get('/api/v1/responders/nearby', sign('user-1'));
  const tampered = await get(
    '/api/v1/responders/nearby?status=ADMIN&userId=someone&distance=100&lat=19.31&lng=84.79',
    sign('user-1')
  );

  assert.equal(tampered.status, 200);
  assert.deepEqual(tampered.body, clean.body, 'the response is identical regardless of input');
});

test('the endpoint contains no geospatial behaviour', async () => {
  const forbidden = [
    '$near',
    '2dsphere',
    'haversine',
    'maps.googleapis',
    'directionsapi',
    'navigator.geolocation',
    'geocod',
    'req.query',
  ];

  for (const source of moduleSources) {
    for (const marker of forbidden) {
      assert.ok(
        !source.toLowerCase().includes(marker.toLowerCase()),
        `responder module must not reference "${marker}"`
      );
    }
  }
});

test('the endpoint has no side effects on SOS, escalation or sockets', async () => {
  const joined = moduleSources.join('\n');

  for (const marker of [
    'mongoose',
    'SosEvent',
    'findById',
    'findOneAndUpdate',
    'findOne(',
    'updateOne',
    'updateMany',
    'insertOne',
    'deleteOne',
    '.save(',
    'emit(',
    'getIO',
    'io.to(',
    'acknowledge',
    'resolveSOS',
    'startEscalation',
    'runGuardianTimeout',
    'levelTimeouts',
  ]) {
    assert.ok(!joined.includes(marker), `responder module must not reference "${marker}"`);
  }
});

test('the dataset lives in one reusable data module', async () => {
  assert.equal(typeof getNearbyResponders, 'function');
  assert.equal(typeof filterEligibleResponders, 'function');

  const payload = getNearbyResponders();
  assert.equal(payload.radiusKm, 2);
  assert.equal(payload.source, 'PROTOTYPE_HARDCODED');
  assert.deepEqual(payload.responders, filterEligibleResponders());
});

test('an unavailable dataset reports the standard server error', () => {
  assert.throws(
    () => filterEligibleResponders(null),
    (err) => err.statusCode === 500 && err.code === 'RESPONDER_DATASET_UNAVAILABLE'
  );
  assert.throws(
    () => filterEligibleResponders([]),
    (err) => err.statusCode === 500 && err.code === 'RESPONDER_DATASET_UNAVAILABLE'
  );
});
