import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { SosEvent } from '../src/modules/sos/sos.model.js';
import { getEscalationState } from '../src/modules/sos/escalation.service.js';
import { getIO } from '../src/sockets/index.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0d1';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0d3';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0d4';

const TOP_KEYS = ['currentLevel', 'guardian', 'nearbyResponders', 'police', 'sosId', 'status'];
const GUARDIAN_KEYS = ['notifiedAt', 'respondedAt', 'status'];
const RESPONDER_KEYS = ['acknowledgedBy', 'notified', 'notifiedAt', 'respondedAt', 'status'];
const POLICE_KEYS = ['escalatedAt', 'notifiedAt', 'policeStation', 'status'];

const guardianLevel = (status = 'TIMEOUT', overrides = {}) => ({
  type: 'GUARDIAN',
  status,
  targetId: '64b0f0f0f0f0f0f0f0f0f0d2',
  notifiedAt: new Date('2026-10-02T10:00:00.000Z'),
  respondedAt: status === 'ACKNOWLEDGED' ? new Date('2026-10-02T10:00:05.000Z') : null,
  expiresAt: new Date('2026-10-02T10:01:00.000Z'),
  ...overrides,
});

const responderLevel = (status = 'PENDING', overrides = {}) => ({
  type: 'NEARBY_RESPONDER',
  status,
  targetId: status === 'ACKNOWLEDGED' ? 'responder-001' : null,
  notifiedResponders: ['responder-001', 'responder-002'],
  notifiedAt: new Date('2026-10-02T10:00:10.000Z'),
  respondedAt: status === 'ACKNOWLEDGED' ? new Date('2026-10-02T10:01:00.000Z') : null,
  expiresAt: new Date('2026-10-02T10:02:00.000Z'),
  ...overrides,
});

const policeLevel = (overrides = {}) => ({
  type: 'POLICE',
  status: 'NOTIFIED',
  targetId: 'police-001',
  policeStation: { id: 'police-001', name: 'Prototype Police Station', phone: '1000000000' },
  source: 'PROTOTYPE_HARDCODED',
  notifiedAt: new Date('2026-10-02T10:02:00.000Z'),
  escalatedAt: new Date('2026-10-02T10:02:00.000Z'),
  respondedAt: null,
  expiresAt: null,
  ...overrides,
});

const sosDoc = ({
  status = 'ACTIVE',
  levels = [guardianLevel(), responderLevel()],
  currentLevel = 1,
  userId = OWNER_ID,
} = {}) => ({
  _id: SOS_ID,
  userId,
  status,
  location: { lat: 19.31, lng: 84.79, address: 'Somewhere' },
  triggerData: { riskLevel: 'HIGH', confidence: 0.9, reason: 'test' },
  verification: { expiresAt: new Date(), userResponse: null, respondedAt: null },
  escalation: { currentLevel, levels },
});

/**
 * Fake repository exposing ONLY the scoped reader: if the service touched any
 * other repository method, no timer, emitter or writer, this would throw.
 */
const makeRepository = (sos) => {
  const calls = [];
  return {
    calls,
    findByIdAndUserId: async (sosId, userId) => {
      calls.push({ sosId, userId });
      return typeof sos === 'function' ? sos(sosId, userId) : sos;
    },
  };
};

// ---------- unit: service ----------

test('the state reader runs exactly one owner-scoped query', async () => {
  const repository = makeRepository(sosDoc());

  const state = await getEscalationState({ sosId: SOS_ID, userId: OWNER_ID, repository });

  assert.equal(repository.calls.length, 1, 'a single SOS read (§22)');
  assert.deepEqual(repository.calls[0], { sosId: SOS_ID, userId: OWNER_ID }, 'ownership in the query');
  assert.equal(state.sosId, SOS_ID);
  assert.equal(state.currentLevel, 'NEARBY_RESPONDER');
  assert.equal(state.status, 'PENDING');
});

test('a missing or foreign SOS is the same 404 (no resource enumeration)', async () => {
  const missing = makeRepository(null);
  const missingError = await getEscalationState({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository: missing,
  }).then(
    () => null,
    (err) => err
  );

  assert.equal(missingError.statusCode, 404);
  assert.equal(missingError.code, 'SOS_NOT_FOUND');

  // The query is scoped, so "someone else's SOS" and "no SOS" are identical.
  const foreign = makeRepository((sosId, userId) =>
    String(userId) === String(OWNER_ID) ? sosDoc() : null
  );
  const foreignError = await getEscalationState({
    sosId: SOS_ID,
    userId: STRANGER_ID,
    repository: foreign,
  }).then(
    () => null,
    (err) => err
  );

  assert.equal(foreignError.statusCode, missingError.statusCode);
  assert.equal(foreignError.code, missingError.code);
  assert.equal(foreignError.message, missingError.message);
});

test('a SOS with no escalation history reports nulls and PENDING defaults', async () => {
  const repository = makeRepository(sosDoc({ levels: [], currentLevel: 0 }));

  const state = await getEscalationState({ sosId: SOS_ID, userId: OWNER_ID, repository });

  assert.deepEqual(Object.keys(state).sort(), TOP_KEYS);
  assert.equal(state.currentLevel, null, 'nothing has escalated yet');
  assert.equal(state.status, null);
  assert.deepEqual(state.guardian, { status: 'PENDING', notifiedAt: null, respondedAt: null });
  assert.deepEqual(state.nearbyResponders, {
    status: 'PENDING',
    notified: 0,
    acknowledgedBy: null,
    notifiedAt: null,
    respondedAt: null,
  });
  assert.deepEqual(state.police, {
    status: 'PENDING',
    notifiedAt: null,
    escalatedAt: null,
    policeStation: null,
  });
});

test('the state reader only reads: no timers, no writes, no emission', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = fs.readFileSync(path.join(root, 'src/modules/sos/escalation.service.js'), 'utf8');
  const body = source.slice(source.indexOf('export async function getEscalationState'));

  const repositoryCalls = body.match(/repository\.\w+/g) ?? [];
  assert.deepEqual(
    [...new Set(repositoryCalls)],
    ['repository.findByIdAndUserId'],
    'the only data access is the scoped read'
  );

  for (const forbidden of ['emit', 'armLevelTimeout', 'scheduleTimeout', 'cancelLevelTimeout', 'Date(', 'findOneAndUpdate']) {
    assert.ok(!body.includes(forbidden), `the reader must not contain ${forbidden}`);
  }
});

// ---------- HTTP harness (database-backed endpoint tests) ----------

const createdUserIds = [];

const sign = (userId) =>
  jwt.sign({ sub: userId, role: 'USER' }, env.jwtSecret, { expiresIn: '5m' });

const newAccountId = () => {
  const id = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(id);
  return id;
};

let server;
let port;

const get = async (pathAndQuery, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  return { status: res.status, body: await res.json() };
};

const statePath = (sosId) => '/api/v1/sos/' + sosId + '/escalation';
const getState = (sosId, token) => get(statePath(sosId), token);

const seedSos = (userId, status, escalation) =>
  SosEvent.create({
    userId,
    triggerType: 'MANUAL',
    status,
    verification: {
      expiresAt: new Date(Date.now() +60000),
      userResponse: null,
      respondedAt: null,
    },
    escalation: escalation ?? { currentLevel: 0, levels: [] },
  });

const guardianSeed = (status = 'TIMEOUT', overrides = {}) => ({
  type: 'GUARDIAN',
  status,
  targetId: new mongoose.Types.ObjectId(),
  notifiedAt: new Date('2026-10-02T10:00:00.000Z'),
  respondedAt: status === 'ACKNOWLEDGED' ? new Date('2026-10-02T10:00:05.000Z') : null,
  expiresAt: new Date('2026-10-02T10:01:00.000Z'),
  ...overrides,
});

const responderSeed = (status = 'PENDING', overrides = {}) => ({
  type: 'NEARBY_RESPONDER',
  status,
  targetId: status === 'ACKNOWLEDGED' ? 'responder-001' : null,
  notifiedResponders: ['responder-001', 'responder-002'],
  notifiedAt: new Date('2026-10-02T10:00:10.000Z'),
  respondedAt: status === 'ACKNOWLEDGED' ? new Date('2026-10-02T10:01:00.000Z') : null,
  expiresAt: new Date('2026-10-02T10:02:00.000Z'),
  ...overrides,
});

const policeSeed = (overrides = {}) => ({
  type: 'POLICE',
  status: 'NOTIFIED',
  targetId: 'police-001',
  policeStation: { id: 'police-001', name: 'Prototype Police Station', phone: '1000000000' },
  source: 'PROTOTYPE_HARDCODED',
  notifiedAt: new Date('2026-10-02T10:02:00.000Z'),
  escalatedAt: new Date('2026-10-02T10:02:00.000Z'),
  respondedAt: null,
  expiresAt: null,
  ...overrides,
});

const seedWith = async (levels, currentLevel = Math.max(0, levels.length - 1), status = 'ACTIVE') => {
  const userId = newAccountId();
  const seeded = await seedSos(userId, status, { currentLevel, levels });
  return { userId, sosId: String(seeded._id) };
};

before(async () => {
  if (hasDb) await connectDB();

  server = http.createServer(app);
  port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
});

after(async () => {
  if (hasDb && mongoose.connection.readyState !== 0) {
    await SosEvent.deleteMany({ userId: { $in: createdUserIds } });
    await mongoose.connection
      .collection('users')
      .deleteMany({ _id: { $in: createdUserIds.map((id) => new mongoose.Types.ObjectId(id)) } });
    await disconnectDB();
  }

  if (server) await new Promise((resolve) => server.close(resolve));
});

// ---------- endpoint: success and state retrieval ----------

dbTest('the owner retrieves the persisted responder escalation state', async () => {
  const { userId, sosId } = await seedWith([guardianSeed('TIMEOUT'), responderSeed('PENDING')]);

  const { status, body } = await getState(sosId, sign(userId));

  assert.equal(status, 200);
  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), TOP_KEYS, '§17: a focused, frontend-safe projection');
  assert.equal(data.sosId, sosId);
  assert.equal(data.currentLevel, 'NEARBY_RESPONDER');
  assert.equal(data.status, 'PENDING');

  assert.deepEqual(Object.keys(data.guardian).sort(), GUARDIAN_KEYS);
  assert.equal(data.guardian.status, 'TIMEOUT');
  assert.equal(data.guardian.notifiedAt, '2026-10-02T10:00:00.000Z');
  assert.equal(data.guardian.respondedAt, null);

  assert.deepEqual(Object.keys(data.nearbyResponders).sort(), RESPONDER_KEYS);
  assert.equal(data.nearbyResponders.status, 'PENDING');
  assert.equal(data.nearbyResponders.notified, 2);
  assert.equal(data.nearbyResponders.acknowledgedBy, null);
  assert.equal(data.nearbyResponders.notifiedAt, '2026-10-02T10:00:10.000Z');
  assert.equal(data.nearbyResponders.respondedAt, null);

  assert.deepEqual(Object.keys(data.police).sort(), POLICE_KEYS);
  assert.equal(data.police.status, 'PENDING');
  assert.equal(data.police.escalatedAt, null);
  assert.equal(data.police.notifiedAt, null);
  assert.equal(
    data.police.policeStation,
    null,
    'no police lookup happens on a read — the station appears only when persisted'
  );
});

dbTest('guardian PENDING and guardian-only states are returned as stored', async () => {
  const pending = await seedWith([guardianSeed('PENDING')], 0);
  const first = await getState(pending.sosId, sign(pending.userId));

  assert.equal(first.status, 200);
  assert.equal(first.body.data.currentLevel, 'GUARDIAN');
  assert.equal(first.body.data.status, 'PENDING');
  assert.equal(first.body.data.guardian.status, 'PENDING');
  assert.equal(first.body.data.nearbyResponders.status, 'PENDING', 'not inferred from the clock');
  assert.equal(first.body.data.nearbyResponders.notified, 0, 'no responder level exists');

  const timedOut = await seedWith([guardianSeed('TIMEOUT')], 0);
  const second = await getState(timedOut.sosId, sign(timedOut.userId));

  assert.equal(second.status, 200);
  assert.equal(second.body.data.currentLevel, 'GUARDIAN');
  assert.equal(second.body.data.status, 'TIMEOUT');
  assert.equal(second.body.data.guardian.status, 'TIMEOUT');
  assert.equal(second.body.data.nearbyResponders.status, 'PENDING', '§15: persisted state only');
});

dbTest('an acknowledged responder level reports who acknowledged', async () => {
  const { userId, sosId } = await seedWith([
    guardianSeed('TIMEOUT'),
    responderSeed('ACKNOWLEDGED'),
  ]);

  const { status, body } = await getState(sosId, sign(userId));

  assert.equal(status, 200);
  const data = body.data;
  assert.equal(data.currentLevel, 'NEARBY_RESPONDER');
  assert.equal(data.status, 'ACKNOWLEDGED');
  assert.equal(data.guardian.status, 'TIMEOUT');
  assert.equal(data.nearbyResponders.status, 'ACKNOWLEDGED');
  assert.equal(data.nearbyResponders.acknowledgedBy, 'responder-001');
  assert.equal(data.nearbyResponders.notified, 2, 'the notified list count survives');
  assert.equal(data.nearbyResponders.respondedAt, '2026-10-02T10:01:00.000Z');
});

dbTest('a police escalation reports the persisted station state', async () => {
  const { userId, sosId } = await seedWith([
    guardianSeed('TIMEOUT'),
    responderSeed('TIMEOUT'),
    policeSeed(),
  ]);

  const { status, body } = await getState(sosId, sign(userId));

  assert.equal(status, 200);
  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), TOP_KEYS);
  assert.equal(data.currentLevel, 'POLICE');
  assert.equal(data.status, 'NOTIFIED');
  assert.equal(data.guardian.status, 'TIMEOUT');
  assert.equal(data.nearbyResponders.status, 'TIMEOUT');
  assert.equal(data.nearbyResponders.notified, 2);
  assert.equal(data.police.status, 'NOTIFIED');
  assert.equal(data.police.escalatedAt, '2026-10-02T10:02:00.000Z');
  assert.deepEqual(data.police.policeStation, {
    id: 'police-001',
    name: 'Prototype Police Station',
    phone: '1000000000',
  });

  const serialized = JSON.stringify(data);
  assert.ok(!serialized.includes('PROTOTYPE_HARDCODED'), '§17: no internal classification field');
  assert.ok(!serialized.includes('responder-003'), '§17: no unrequested responder identities');
  assert.ok(!serialized.includes('location'), '§13: no location in the state projection');
});

dbTest('terminal SOS states can still be read', async () => {
  for (const status of ['CANCELLED', 'RESOLVED', 'ACKNOWLEDGED', 'VERIFYING']) {
    const { userId, sosId } = await seedWith(
      [guardianSeed('TIMEOUT'), responderSeed('PENDING')],
      1,
      status
    );

    const { status: httpStatus, body } = await getState(sosId, sign(userId));

    assert.equal(httpStatus, 200, status, 'the endpoint is a state reader, not a controller');
    assert.equal(body.data.currentLevel, 'NEARBY_RESPONDER', status);
    assert.equal(body.data.status, 'PENDING', status);
  }
});

// ---------- endpoint: validation and authorization ----------

dbTest('unauthenticated requests are rejected with 401', async () => {
  const { sosId } = await seedWith([guardianSeed()]);

  const { status, body } = await get(statePath(sosId));

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

dbTest('an invalid SOS id is rejected with 400', async () => {
  const { status, body } = await getState('not-an-id', sign(OWNER_ID));

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('a missing SOS and a foreign SOS return the identical 404', async () => {
  const missingId = new mongoose.Types.ObjectId().toString();
  const missing = await getState(missingId, sign(OWNER_ID));

  const { sosId } = await seedWith([guardianSeed()]);
  const foreign = await getState(sosId, sign(newAccountId()));

  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'SOS_NOT_FOUND');
  assert.equal(foreign.status, 404);
  assert.deepEqual(
    foreign.body,
    missing.body,
    '§18: no resource enumeration — the same not-found response'
  );
  assert.equal(foreign.body.data, undefined, "another user's escalation state is never exposed");
});

// ---------- endpoint: read-only guarantees ----------

dbTest('the endpoint never modifies the SOS document', async () => {
  const { userId, sosId } = await seedWith([guardianSeed('TIMEOUT'), responderSeed('PENDING')]);
  const before = await SosEvent.findById(sosId).lean();

  const { status } = await getState(sosId, sign(userId));
  assert.equal(status, 200);

  const after = await SosEvent.findById(sosId).lean();
  assert.deepEqual(after, before, 'byte-for-byte identical: no write, no timer, no level change');
});

dbTest('the endpoint neither requires nor initializes Socket.IO', async () => {
  const { userId, sosId } = await seedWith([guardianSeed('TIMEOUT'), responderSeed('PENDING')]);

  const { status } = await getState(sosId, sign(userId));

  assert.equal(status, 200, 'recovery works without a socket layer');
  assert.throws(() => getIO(), 'no socket event is emitted and no socket layer is initialized');
});

dbTest('the response contains no unrelated or private database fields', async () => {
  const { userId, sosId } = await seedWith([guardianSeed('TIMEOUT'), responderSeed('PENDING')]);

  const { status, body } = await getState(sosId, sign(userId));

  assert.equal(status, 200);
  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), TOP_KEYS);

  const serialized = JSON.stringify(data);
  for (const forbidden of [
    'location',
    'triggerData',
    'triggerType',
    'verification',
    'userId',
    'password',
    'createdAt',
    'updatedAt',
    'resolvedAt',
    'radiusKm',
    'latitude',
    'longitude',
    'notifiedResponders',
    'expiresAt',
  ]) {
    assert.ok(!serialized.includes(forbidden), `the projection must not expose ${forbidden}`);
  }
});
