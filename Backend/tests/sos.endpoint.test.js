import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { SosEvent } from '../src/modules/sos/sos.model.js';
import { Guardian } from '../src/modules/guardians/guardian.model.js';
import { runGuardianTimeout } from '../src/modules/sos/escalation.service.js';
import { getIO } from '../src/sockets/index.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const createdUserIds = [];
const createdSessionIds = [];

const sign = (userId) =>
  jwt.sign({ sub: userId, role: 'USER' }, env.jwtSecret, { expiresIn: '5m' });

let server;
let port;

const post = async (path, token, payload) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  });

  return { status: res.status, body: await res.json() };
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
    const objectIds = createdUserIds.map((id) => new mongoose.Types.ObjectId(id));

    await SosEvent.deleteMany({ userId: { $in: createdUserIds } });
    await Guardian.deleteMany({
      $or: [{ userId: { $in: createdUserIds } }, { guardianUserId: { $in: createdUserIds } }],
    });
    await mongoose.connection.collection('users').deleteMany({ _id: { $in: objectIds } });
    await mongoose.connection
      .collection('safetySessions')
      .deleteMany({ _id: { $in: createdSessionIds } });
    await disconnectDB();
  }

  if (server) await new Promise((resolve) => server.close(resolve));
});

test('rejects an unauthenticated request', async () => {
  const { status, body } = await post('/api/v1/sos', null, { triggerType: 'MANUAL' });

  assert.equal(status, 401);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid trigger type with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await post('/api/v1/sos', token, { triggerType: 'SOS' });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.triggerType');
});

test('rejects invalid coordinates with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await post('/api/v1/sos', token, {
    triggerType: 'MANUAL',
    location: { lat: 999, lng: 0 },
  });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('rejects a malformed safetySessionId with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status } = await post('/api/v1/sos', token, {
    triggerType: 'MANUAL',
    safetySessionId: 'abc',
  });

  assert.equal(status, 400);
});

dbTest('creates a manual SOS in VERIFYING state', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);

  const before = Date.now();
  const { status, body } = await post('/api/v1/sos', token, { triggerType: 'MANUAL' });
  const after = Date.now();

  assert.equal(status, 201);
  assert.equal(body.success, true);

  const data = body.data;
  assert.ok(mongoose.isValidObjectId(data.id));
  assert.equal(data.triggerType, 'MANUAL');
  assert.equal(data.status, 'VERIFYING');
  assert.equal(data.safetySessionId, null);
  assert.equal(data.location, null);

  const expiresAt = new Date(data.verification.expiresAt).getTime();
  assert.ok(expiresAt >= before + 10000, 'expiresAt >= now + 10s');
  assert.ok(expiresAt <= after + 10000, 'expiresAt <= now + 10s');
  assert.equal(data.verification.userResponse, null);
  assert.equal(data.verification.respondedAt, null);
  assert.ok(data.createdAt);
});

dbTest('rejects a second unresolved SOS for the same user', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);

  const first = await post('/api/v1/sos', token, { triggerType: 'MANUAL' });
  assert.equal(first.status, 201);

  const second = await post('/api/v1/sos', token, { triggerType: 'MANUAL' });

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'SOS_ALREADY_ACTIVE');
  assert.equal(second.body.error.details.existing.id, first.body.data.id);
  assert.equal(second.body.error.details.existing.status, 'VERIFYING');
});

dbTest('creates an automated-trigger SOS with location and owned session', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);

  const sessionId = new mongoose.Types.ObjectId();
  createdSessionIds.push(sessionId);
  await mongoose.connection.collection('safetySessions').insertOne({
    _id: sessionId,
    userId: new mongoose.Types.ObjectId(userId),
    status: 'ACTIVE',
    createdAt: new Date(),
  });

  const { status, body } = await post('/api/v1/sos', token, {
    triggerType: 'VOICE_DANGER',
    safetySessionId: sessionId.toString(),
    triggerData: { riskLevel: 'HIGH', confidence: 0.92, reason: 'distress detected' },
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack, Odisha' },
  });

  assert.equal(status, 201);
  assert.equal(body.data.triggerType, 'VOICE_DANGER');
  assert.equal(body.data.safetySessionId, sessionId.toString());
  assert.equal(body.data.triggerData.confidence, 0.92);
  assert.deepEqual(body.data.location, { lat: 19.31, lng: 84.79, address: 'Cuttack, Odisha' });
});

dbTest('rejects an unknown safety session', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);

  const { status, body } = await post('/api/v1/sos', token, {
    triggerType: 'MANUAL',
    safetySessionId: new mongoose.Types.ObjectId().toString(),
  });

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SAFETY_SESSION_NOT_FOUND');
});

dbTest('rejects a safety session owned by another user', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);

  const sessionId = new mongoose.Types.ObjectId();
  createdSessionIds.push(sessionId);
  await mongoose.connection.collection('safetySessions').insertOne({
    _id: sessionId,
    userId: new mongoose.Types.ObjectId(),
    status: 'ACTIVE',
    createdAt: new Date(),
  });

  const { status, body } = await post('/api/v1/sos', token, {
    triggerType: 'MANUAL',
    safetySessionId: sessionId.toString(),
  });

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SAFETY_SESSION_FORBIDDEN');
});

const get = async (path, token) => {
  const res = await fetch('http://127.0.0.1:' + port + path, {
    headers: token ? { authorization: 'Bearer ' + token } : {},
  });
  return { status: res.status, body: await res.json() };
};

const seedSos = (userId, status, overrides = {}) =>
  SosEvent.create({
    userId,
    triggerType: 'MANUAL',
    status,
    verification: {
      expiresAt: new Date(Date.now() + 60000),
      userResponse: null,
      respondedAt: null,
    },
    escalation: { currentLevel: 0, levels: [] },
    ...overrides,
  });

test('rejects an unauthenticated active-SOS request', async () => {
  const { status, body } = await get('/api/v1/sos/active', null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

dbTest('returns the active SOS when status is VERIFYING', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  await seedSos(userId, 'VERIFYING');

  const { status, body } = await get('/api/v1/sos/active', sign(userId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.active, true);
  assert.equal(body.data.sos.status, 'VERIFYING');
  assert.equal(body.data.sos.escalation.currentLevel, 0);
  assert.ok(body.data.sos.verification.expiresAt);
});

dbTest('returns the active SOS when status is ACTIVE', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  await seedSos(userId, 'ACTIVE');

  const { status, body } = await get('/api/v1/sos/active', sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.active, true);
  assert.equal(body.data.sos.status, 'ACTIVE');
});

dbTest('returns the active SOS when status is ACKNOWLEDGED', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  await seedSos(userId, 'ACKNOWLEDGED');

  const { body } = await get('/api/v1/sos/active', sign(userId));

  assert.equal(body.data.active, true);
  assert.equal(body.data.sos.status, 'ACKNOWLEDGED');
});

dbTest('returns the active SOS when status is ESCALATING', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  await seedSos(userId, 'ESCALATING');

  const { body } = await get('/api/v1/sos/active', sign(userId));

  assert.equal(body.data.active, true);
  assert.equal(body.data.sos.status, 'ESCALATING');
});

dbTest('returns active:false when only CANCELLED/RESOLVED SOS exist', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  await seedSos(userId, 'CANCELLED');
  await seedSos(userId, 'RESOLVED');

  const { status, body } = await get('/api/v1/sos/active', sign(userId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data, { active: false, sos: null });
});

dbTest('returns active:false when the user has no SOS at all', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);

  const { status, body } = await get('/api/v1/sos/active', sign(userId));

  assert.equal(status, 200);
  assert.deepEqual(body.data, { active: false, sos: null });
});

dbTest("never returns another user's SOS", async () => {
  const otherUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(otherUserId);
  const seeded = await seedSos(otherUserId, 'ACTIVE');

  const requesterId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(requesterId);

  const { status, body } = await get('/api/v1/sos/active', sign(requesterId));

  assert.equal(status, 200);
  assert.deepEqual(body.data, { active: false, sos: null });
  assert.notEqual(body.data.sos?.id, String(seeded._id));
});

dbTest('database failure is handled by the central error middleware', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await get('/api/v1/sos/active', token);

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------- GET /api/v1/sos/:id ----------

test('rejects an unauthenticated SOS detail request', async () => {
  const { status, body } = await get('/api/v1/sos/' + new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid SOS id format with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await get('/api/v1/sos/not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('retrieves an existing SOS belonging to the authenticated user', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);

  const seeded = await seedSos(userId, 'VERIFYING', {
    triggerType: 'VOICE_DANGER',
    safetySessionId: new mongoose.Types.ObjectId(),
    triggerData: { riskLevel: 'HIGH', confidence: 0.92, reason: 'distress' },
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
  });

  const { status, body } = await get('/api/v1/sos/' + seeded._id, token);

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const data = body.data;
  assert.equal(data.id, String(seeded._id));
  assert.equal(data.userId, userId);
  assert.equal(data.triggerType, 'VOICE_DANGER');
  assert.equal(data.status, 'VERIFYING');
  assert.equal(data.safetySessionId, String(seeded.safetySessionId));
  assert.equal(data.triggerData.confidence, 0.92);
  assert.equal(data.location.lat, 19.31);
  assert.ok(data.verification.expiresAt);
  assert.equal(data.verification.userResponse, null);
  assert.equal(data.escalation.currentLevel, 0);
  assert.ok(data.createdAt);
  assert.ok(data.updatedAt);
  assert.equal(data.resolvedAt, null);
});

dbTest('retrieves a VERIFYING SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'VERIFYING');

  const { body } = await get('/api/v1/sos/' + seeded._id, sign(userId));

  assert.equal(body.data.status, 'VERIFYING');
});

dbTest('retrieves an ACTIVE SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'ACTIVE');

  const { status, body } = await get('/api/v1/sos/' + seeded._id, sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.status, 'ACTIVE');
});

dbTest('retrieves a RESOLVED SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const resolvedAt = new Date();
  const seeded = await seedSos(userId, 'RESOLVED', { resolvedAt });

  const { status, body } = await get('/api/v1/sos/' + seeded._id, sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.status, 'RESOLVED');
  assert.equal(new Date(body.data.resolvedAt).getTime(), resolvedAt.getTime());
});

dbTest('returns 404 for a valid but non-existent SOS id', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);

  const { status, body } = await get(
    '/api/v1/sos/' + new mongoose.Types.ObjectId().toString(),
    sign(userId)
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SOS_NOT_FOUND');
  assert.equal(body.error.message, 'SOS event not found');
});

dbTest('returns the identical not-found response for another user SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedSos(ownerUserId, 'ACTIVE');

  const requesterId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(requesterId);

  const foreign = await get('/api/v1/sos/' + seeded._id, sign(requesterId));
  const missing = await get(
    '/api/v1/sos/' + new mongoose.Types.ObjectId().toString(),
    sign(requesterId)
  );

  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, missing.body);
  assert.equal(foreign.body.data, undefined);
});

dbTest('does not modify the retrieved SOS document', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'ACTIVE');

  const before = await SosEvent.findById(seeded._id).lean();
  await get('/api/v1/sos/' + seeded._id, sign(userId));
  const after = await SosEvent.findById(seeded._id).lean();

  assert.equal(String(after.updatedAt), String(before.updatedAt));
  assert.equal(after.status, before.status);
  assert.deepEqual(after.verification, before.verification);
  assert.deepEqual(after.escalation, before.escalation);
  assert.deepEqual(after, before);
});

dbTest('does not emit Socket.IO events', async () => {
  assert.throws(() => getIO(), /has not been initialized/);

  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'VERIFYING');

  const { status } = await get('/api/v1/sos/' + seeded._id, sign(userId));

  assert.equal(status, 200);
  assert.throws(() => getIO(), /has not been initialized/);
});

dbTest('database failure on SOS detail uses the central error handler', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  const token = sign(userId);

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await get('/api/v1/sos/' + new mongoose.Types.ObjectId().toString(), token);

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------- POST /api/v1/sos/:id/confirm ----------

const confirmSos = (sosId, token) => post('/api/v1/sos/' + sosId + '/confirm', token, {});

test('rejects an unauthenticated confirm request', async () => {
  const { status, body } = await confirmSos(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid SOS id on confirm with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await confirmSos('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('confirms a VERIFYING SOS and transitions it to ACTIVE', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);
  const seeded = await seedSos(userId, 'VERIFYING', {
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
  });

  const before = Date.now();
  const { status, body } = await confirmSos(seeded._id, token);
  const after = Date.now();

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.id, String(seeded._id));
  assert.equal(body.data.status, 'ACTIVE');
  assert.equal(body.data.verification.userResponse, 'CONFIRMED');

  const respondedAt = new Date(body.data.verification.respondedAt).getTime();
  assert.ok(respondedAt >= before && respondedAt <= after, 'respondedAt is generated by the server');

  assert.ok(body.data.verification.expiresAt, 'expiresAt is retained as history');
  assert.ok(body.data.triggerType);
  assert.ok(body.data.safetySessionId !== undefined);
  assert.equal(body.data.location.lat, 19.31);
  assert.ok(body.data.createdAt);
  assert.ok(body.data.updatedAt);
});

dbTest('cannot confirm an already ACTIVE SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);
  const seeded = await seedSos(userId, 'ACTIVE');

  const { status, body } = await confirmSos(seeded._id, token);

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_VERIFYING');
});

dbTest('cannot confirm a CANCELLED SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'CANCELLED');

  const { status, body } = await confirmSos(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_VERIFYING');
});

dbTest('cannot confirm a RESOLVED SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'RESOLVED', { resolvedAt: new Date() });

  const { status, body } = await confirmSos(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_VERIFYING');
});

dbTest('cannot confirm an expired verification', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'VERIFYING', {
    verification: {
      expiresAt: new Date(Date.now() - 1000),
      userResponse: null,
      respondedAt: null,
    },
  });

  const { status, body } = await confirmSos(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_VERIFICATION_EXPIRED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'VERIFYING', 'an expired verification must not be activated here');
});

dbTest('another user cannot confirm someone else SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedSos(ownerUserId, 'VERIFYING');

  const requesterId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(requesterId);

  const foreign = await confirmSos(seeded._id, sign(requesterId));
  const missing = await confirmSos(new mongoose.Types.ObjectId().toString(), sign(requesterId));

  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, missing.body);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'VERIFYING', 'the owner SOS must remain untouched');
  assert.equal(doc.verification.userResponse, null);
});

dbTest('two simultaneous confirmations produce exactly one transition', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);
  const seeded = await seedSos(userId, 'VERIFYING');

  const [first, second] = await Promise.all([
    confirmSos(seeded._id, token),
    confirmSos(seeded._id, token),
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], 'exactly one confirmation may win');

  const winner = first.status === 200 ? first : second;
  assert.equal(winner.body.data.status, 'ACTIVE');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.verification.userResponse, 'CONFIRMED');
});

dbTest('confirmation does not modify unrelated SOS fields', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'VERIFYING', {
    triggerType: 'OFF_ROUTE',
    safetySessionId: new mongoose.Types.ObjectId(),
    triggerData: { riskLevel: 'HIGH', confidence: 0.9, reason: 'left route' },
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
    escalation: { currentLevel: 0, levels: [] },
  });

  const before = await SosEvent.findById(seeded._id).lean();
  const { status } = await confirmSos(seeded._id, sign(userId));
  const after = await SosEvent.findById(seeded._id).lean();

  assert.equal(status, 200);

  assert.equal(after.triggerType, before.triggerType);
  assert.equal(String(after.safetySessionId), String(before.safetySessionId));
  assert.equal(String(after.userId), String(before.userId));
  assert.deepEqual(after.triggerData, before.triggerData);
  assert.deepEqual(after.location, before.location);
  assert.deepEqual(after.escalation, before.escalation);
  assert.equal(String(after.createdAt), String(before.createdAt));
  assert.equal(String(after.verification.expiresAt), String(before.verification.expiresAt));
  assert.equal(after.resolvedAt, null);

  assert.equal(after.status, 'ACTIVE');
  assert.equal(after.verification.userResponse, 'CONFIRMED');
  assert.ok(
    new Date(after.updatedAt).getTime() > new Date(before.updatedAt).getTime(),
    'updatedAt advances'
  );
});

// ---------- POST /api/v1/sos/:id/cancel ----------

const cancelSos = (sosId, token) => post('/api/v1/sos/' + sosId + '/cancel', token, {});

test('rejects an unauthenticated cancel request', async () => {
  const { status, body } = await cancelSos(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid SOS id on cancel with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await cancelSos('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('cancels a VERIFYING SOS and transitions it to CANCELLED', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);
  const seeded = await seedSos(userId, 'VERIFYING', {
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
  });
  const originalExpiresAt = seeded.verification.expiresAt.getTime();

  const before = Date.now();
  const { status, body } = await cancelSos(seeded._id, token);
  const after = Date.now();

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.id, String(seeded._id));
  assert.equal(body.data.status, 'CANCELLED');
  assert.equal(body.data.verification.userResponse, 'CANCELLED');
  assert.equal(
    new Date(body.data.verification.expiresAt).getTime(),
    originalExpiresAt,
    'expiresAt is retained'
  );

  const respondedAt = new Date(body.data.verification.respondedAt).getTime();
  assert.ok(respondedAt >= before && respondedAt <= after, 'respondedAt is generated by the server');

  assert.equal(body.data.triggerType, 'MANUAL');
  assert.equal(body.data.location.lat, 19.31);
  assert.ok(body.data.createdAt);
  assert.ok(body.data.updatedAt);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'CANCELLED');
  assert.equal(doc.verification.userResponse, 'CANCELLED');
  assert.equal(doc.verification.expiresAt.getTime(), originalExpiresAt);
});

dbTest('cannot cancel an ACTIVE SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'ACTIVE');

  const { status, body } = await cancelSos(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_VERIFYING');
});

dbTest('cannot cancel an ACKNOWLEDGED SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'ACKNOWLEDGED');

  const { status, body } = await cancelSos(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_VERIFYING');
});

dbTest('cannot cancel a RESOLVED SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'RESOLVED', { resolvedAt: new Date() });

  const { status, body } = await cancelSos(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_VERIFYING');
});

dbTest('cannot cancel an already CANCELLED SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'CANCELLED');

  const { status, body } = await cancelSos(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_VERIFYING');
});

dbTest('cannot cancel an expired verification', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'VERIFYING', {
    verification: {
      expiresAt: new Date(Date.now() - 1000),
      userResponse: null,
      respondedAt: null,
    },
  });

  const { status, body } = await cancelSos(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_VERIFICATION_EXPIRED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'VERIFYING', 'cancellation must not touch an expired verification');
});

dbTest('another user cannot cancel someone else SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedSos(ownerUserId, 'VERIFYING');

  const requesterId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(requesterId);

  const foreign = await cancelSos(seeded._id, sign(requesterId));
  const missing = await cancelSos(new mongoose.Types.ObjectId().toString(), sign(requesterId));

  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.body, missing.body);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'VERIFYING', 'the owner SOS must remain untouched');
  assert.equal(doc.verification.userResponse, null);
});

dbTest('concurrent confirm and cancel produce exactly one valid transition', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const token = sign(userId);
  const seeded = await seedSos(userId, 'VERIFYING');

  const [confirmRes, cancelRes] = await Promise.all([
    confirmSos(seeded._id, token),
    cancelSos(seeded._id, token),
  ]);

  assert.deepEqual([confirmRes.status, cancelRes.status].sort(), [200, 409]);

  const confirmWon = confirmRes.status === 200;
  const loser = confirmWon ? cancelRes : confirmRes;

  assert.equal(loser.body.error.code, 'SOS_NOT_VERIFYING');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, confirmWon ? 'ACTIVE' : 'CANCELLED');
  assert.equal(doc.verification.userResponse, confirmWon ? 'CONFIRMED' : 'CANCELLED');
  assert.ok(doc.verification.respondedAt, 'the winner records a response exactly once');
});

dbTest('cancellation triggers no Socket.IO event', async () => {
  assert.throws(() => getIO(), /has not been initialized/);

  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedSos(userId, 'VERIFYING');

  const { status } = await cancelSos(seeded._id, sign(userId));

  assert.equal(status, 200);
  assert.throws(() => getIO(), /has not been initialized/);
});

// ---------- POST /api/v1/sos/:id/acknowledge ----------

const ackSos = (sosId, token) => post('/api/v1/sos/' + sosId + '/acknowledge', token, {});

const seedSosWithLevels = (ownerUserId, status, levels, currentLevel = 0) =>
  seedSos(ownerUserId, status, { escalation: { currentLevel, levels } });

const guardianLevel = (targetId, levelStatus = 'PENDING') => ({
  type: 'GUARDIAN',
  status: levelStatus,
  targetId: new mongoose.Types.ObjectId(targetId),
  notifiedAt: new Date(),
  respondedAt: null,
});

test('rejects an unauthenticated acknowledge request', async () => {
  const { status, body } = await ackSos(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid SOS id on acknowledge with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await ackSos('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('authorized guardian acknowledges an ACTIVE SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const notifiedAt = new Date();
  const seeded = await seedSosWithLevels(ownerUserId, 'ACTIVE', [
    { ...guardianLevel(guardianId, 'NOTIFIED'), notifiedAt },
  ]);

  const before = Date.now();
  const { status, body } = await ackSos(seeded._id, sign(guardianId));
  const after = Date.now();

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.id, String(seeded._id));
  assert.equal(body.data.status, 'ACKNOWLEDGED');

  const level = body.data.escalation.levels[0];
  assert.equal(level.type, 'GUARDIAN');
  assert.equal(level.status, 'ACKNOWLEDGED');
  assert.equal(level.targetId, guardianId);
  assert.equal(new Date(level.notifiedAt).getTime(), notifiedAt.getTime(), 'notifiedAt is preserved');

  const respondedAt = new Date(level.respondedAt).getTime();
  assert.ok(respondedAt >= before && respondedAt <= after, 'respondedAt is generated by the server');
  assert.equal(body.data.escalation.currentLevel, 0, 'currentLevel is not changed here');
  assert.equal(body.data.location, null, 'no location was seeded');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.escalation.levels[0].status, 'ACKNOWLEDGED');
  assert.equal(String(doc.userId), ownerUserId, 'the owner is unchanged');
});

dbTest('authorized responder acknowledges an ESCALATING SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  const responderId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(responderId);

  const seeded = await seedSosWithLevels(
    ownerUserId,
    'ESCALATING',
    [
      guardianLevel(guardianId, 'NOTIFIED'),
      {
        type: 'NEARBY_RESPONDER',
        status: 'NOTIFIED',
        targetId: new mongoose.Types.ObjectId(responderId),
        notifiedAt: new Date(),
        respondedAt: null,
      },
    ],
    1
  );

  const { status, body } = await ackSos(seeded._id, sign(responderId));

  assert.equal(status, 200);
  assert.equal(body.data.status, 'ACKNOWLEDGED');

  assert.equal(body.data.escalation.levels[1].status, 'ACKNOWLEDGED');
  assert.equal(body.data.escalation.levels[1].targetId, responderId);
  assert.equal(body.data.escalation.levels[0].status, 'NOTIFIED', 'other levels are untouched');
  assert.equal(body.data.escalation.currentLevel, 1, 'currentLevel is not changed here');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.escalation.levels.length, 2, 'no escalation level is created');
});

dbTest('an unrelated authenticated user cannot acknowledge the SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  const strangerId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(strangerId);

  const seeded = await seedSosWithLevels(ownerUserId, 'ACTIVE', [guardianLevel(guardianId)]);

  const { status, body } = await ackSos(seeded._id, sign(strangerId));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_RECIPIENT_NOT_AUTHORIZED');
  assert.equal(body.data, undefined, 'no SOS data is exposed to unauthorized users');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.escalation.levels[0].status, 'PENDING');
});

dbTest('a VERIFYING SOS cannot be acknowledged', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const seeded = await seedSosWithLevels(ownerUserId, 'VERIFYING', [guardianLevel(guardianId)]);

  const { status, body } = await ackSos(seeded._id, sign(guardianId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACKNOWLEDGEABLE');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'VERIFYING');
});

dbTest('a CANCELLED SOS cannot be acknowledged', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const seeded = await seedSosWithLevels(ownerUserId, 'CANCELLED', [guardianLevel(guardianId)]);

  const { status, body } = await ackSos(seeded._id, sign(guardianId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACKNOWLEDGEABLE');
});

dbTest('a RESOLVED SOS cannot be acknowledged', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const seeded = await seedSosWithLevels(ownerUserId, 'RESOLVED', [guardianLevel(guardianId)]);

  const { status, body } = await ackSos(seeded._id, sign(guardianId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACKNOWLEDGEABLE');
});

dbTest('an already ACKNOWLEDGED SOS cannot be acknowledged again', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const firstAcknowledgedAt = new Date(Date.now() - 5000);
  const seeded = await seedSosWithLevels(
    ownerUserId,
    'ACKNOWLEDGED',
    [{ ...guardianLevel(guardianId, 'ACKNOWLEDGED'), respondedAt: firstAcknowledgedAt }],
    0
  );
  const originalRespondedAt = seeded.escalation.levels[0].respondedAt.getTime();

  const { status, body } = await ackSos(seeded._id, sign(guardianId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_ALREADY_ACKNOWLEDGED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(
    doc.escalation.levels[0].respondedAt?.getTime(),
    originalRespondedAt,
    'the first acknowledgement timestamp is preserved'
  );
});

dbTest('concurrent acknowledgements produce exactly one valid transition', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const seeded = await seedSosWithLevels(ownerUserId, 'ACTIVE', [guardianLevel(guardianId)]);
  const token = sign(guardianId);

  const [first, second] = await Promise.all([
    ackSos(seeded._id, token),
    ackSos(seeded._id, token),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 409]);

  const loser = first.status === 409 ? first : second;
  assert.equal(loser.body.error.code, 'SOS_ALREADY_ACKNOWLEDGED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.escalation.levels[0].status, 'ACKNOWLEDGED');
  assert.ok(doc.escalation.levels[0].respondedAt, 'acknowledged exactly once');
});

dbTest('acknowledgement triggers no escalation change or Socket.IO event', async () => {
  assert.throws(() => getIO(), /has not been initialized/);

  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const seeded = await seedSosWithLevels(ownerUserId, 'ACTIVE', [guardianLevel(guardianId)]);
  const levelsBefore = seeded.escalation.levels.length;

  const { status } = await ackSos(seeded._id, sign(guardianId));

  assert.equal(status, 200);
  assert.throws(() => getIO(), /has not been initialized/);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.currentLevel, 0, 'no escalation to the next level');
  assert.equal(doc.escalation.levels.length, levelsBefore, 'no new escalation level');
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.resolvedAt, null, 'the SOS is not resolved');
  assert.equal(doc.verification.userResponse, null, 'the owner response is untouched');
});

// ---------- POST /api/v1/sos/:id/resolve ----------

const resolveSos = (sosId, token) => post('/api/v1/sos/' + sosId + '/resolve', token, {});

const seedAcknowledgedSos = (ownerUserId, recipientId = null, overrides = {}) =>
  seedSos(ownerUserId, 'ACKNOWLEDGED', {
    ...(recipientId
      ? {
          escalation: {
            currentLevel: 0,
            levels: [
              {
                type: 'GUARDIAN',
                status: 'ACKNOWLEDGED',
                targetId: new mongoose.Types.ObjectId(recipientId),
                notifiedAt: new Date(),
                respondedAt: new Date(),
              },
            ],
          },
        }
      : {}),
    ...overrides,
  });

test('rejects an unauthenticated resolve request', async () => {
  const { status, body } = await resolveSos(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid SOS id on resolve with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await resolveSos('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('the SOS owner resolves an ACKNOWLEDGED SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedAcknowledgedSos(ownerUserId);

  const before = Date.now();
  const { status, body } = await resolveSos(seeded._id, sign(ownerUserId));
  const after = Date.now();

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.id, String(seeded._id));
  assert.equal(body.data.status, 'RESOLVED');

  const resolvedAt = new Date(body.data.resolvedAt).getTime();
  assert.ok(resolvedAt >= before && resolvedAt <= after, 'resolvedAt is generated by the server');
  assert.ok(
    new Date(body.data.updatedAt).getTime() >= resolvedAt,
    'updatedAt advances with the transition'
  );

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'RESOLVED');
  assert.equal(doc.resolvedAt.getTime(), resolvedAt);
});

dbTest('the acknowledging recipient resolves the SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const seeded = await seedAcknowledgedSos(ownerUserId, guardianId);

  const { status, body } = await resolveSos(seeded._id, sign(guardianId));

  assert.equal(status, 200);
  assert.equal(body.data.status, 'RESOLVED');
  assert.ok(body.data.resolvedAt);
  assert.equal(body.data.escalation.levels[0].status, 'ACKNOWLEDGED', 'levels are untouched');
  assert.equal(String(body.data.userId), ownerUserId);
});

dbTest('an unrelated authenticated user cannot resolve the SOS', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const strangerId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(strangerId);

  const seeded = await seedAcknowledgedSos(ownerUserId);

  const { status, body } = await resolveSos(seeded._id, sign(strangerId));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_RESOLVE_NOT_AUTHORIZED');
  assert.equal(body.data, undefined, 'no SOS data is exposed to unauthorized users');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.resolvedAt, null);
});

dbTest('returns not found for a non-existent SOS', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);

  const { status, body } = await resolveSos(new mongoose.Types.ObjectId().toString(), sign(userId));

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SOS_NOT_FOUND');
});

dbTest('a VERIFYING SOS cannot be resolved', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedSos(ownerUserId, 'VERIFYING');

  const { status, body } = await resolveSos(seeded._id, sign(ownerUserId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACKNOWLEDGED');
});

dbTest('an ACTIVE SOS cannot be resolved', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedSos(ownerUserId, 'ACTIVE');

  const { status, body } = await resolveSos(seeded._id, sign(ownerUserId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACKNOWLEDGED');
});

dbTest('an ESCALATING SOS cannot be resolved', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedSos(ownerUserId, 'ESCALATING');

  const { status, body } = await resolveSos(seeded._id, sign(ownerUserId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACKNOWLEDGED');
});

dbTest('a CANCELLED SOS cannot be resolved', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedSos(ownerUserId, 'CANCELLED');

  const { status, body } = await resolveSos(seeded._id, sign(ownerUserId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACKNOWLEDGED');
});

dbTest('an already RESOLVED SOS cannot be resolved again', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const originalResolvedAt = new Date(Date.now() - 60000);
  const seeded = await seedAcknowledgedSos(ownerUserId, null, {
    status: 'RESOLVED',
    resolvedAt: originalResolvedAt,
  });

  const { status, body } = await resolveSos(seeded._id, sign(ownerUserId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_ALREADY_RESOLVED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.resolvedAt.getTime(), originalResolvedAt.getTime(), 'resolvedAt is preserved');
});

dbTest('concurrent resolve requests produce exactly one transition', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const seeded = await seedAcknowledgedSos(ownerUserId);
  const token = sign(ownerUserId);

  const [first, second] = await Promise.all([
    resolveSos(seeded._id, token),
    resolveSos(seeded._id, token),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 409]);

  const loser = first.status === 409 ? first : second;
  assert.equal(loser.body.error.code, 'SOS_ALREADY_RESOLVED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'RESOLVED');
  assert.ok(doc.resolvedAt, 'resolved exactly once');
});

dbTest('resolve does not modify unrelated SOS fields', async () => {
  const ownerUserId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(ownerUserId);
  const guardianId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(guardianId);

  const seeded = await seedAcknowledgedSos(ownerUserId, guardianId, {
    triggerType: 'OFF_ROUTE',
    safetySessionId: new mongoose.Types.ObjectId(),
    triggerData: { riskLevel: 'HIGH', confidence: 0.9, reason: 'left route' },
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
  });

  const before = await SosEvent.findById(seeded._id).lean();
  const { status } = await resolveSos(seeded._id, sign(ownerUserId));
  const after = await SosEvent.findById(seeded._id).lean();

  assert.equal(status, 200);

  assert.equal(after.triggerType, before.triggerType);
  assert.equal(String(after.safetySessionId), String(before.safetySessionId));
  assert.equal(String(after.userId), String(before.userId));
  assert.deepEqual(after.triggerData, before.triggerData);
  assert.deepEqual(after.location, before.location);
  assert.deepEqual(after.verification, before.verification);
  assert.equal(after.escalation.currentLevel, before.escalation.currentLevel);
  assert.equal(after.escalation.levels.length, before.escalation.levels.length);
  assert.equal(
    after.escalation.levels[0].respondedAt.getTime(),
    before.escalation.levels[0].respondedAt.getTime()
  );
  assert.equal(String(after.createdAt), String(before.createdAt));

  assert.equal(after.status, 'RESOLVED');
  assert.ok(after.resolvedAt);
  assert.ok(new Date(after.updatedAt).getTime() > new Date(before.updatedAt).getTime());
});

// ---------- GET /api/v1/sos/history ----------

const historyPath = (query = '') => '/api/v1/sos/history' + query;

const seedHistorical = (userId, status = 'RESOLVED', overrides = {}) =>
  seedSos(userId, status, {
    ...(status === 'RESOLVED' ? { resolvedAt: new Date() } : {}),
    ...overrides,
  });

const setCreatedAt = async (sosId, date) => {
  await SosEvent.collection.updateOne(
    { _id: new mongoose.Types.ObjectId(String(sosId)) },
    { $set: { createdAt: date } }
  );
};

test('rejects an unauthenticated history request', async () => {
  const { status, body } = await get(historyPath(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid page with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());

  for (const value of ['0', '-1', 'abc']) {
    const { status, body } = await get(historyPath('?page=' + value), token);
    assert.equal(status, 400, 'page=' + value);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.details[0].path, 'query.page');
  }
});

test('rejects an invalid limit with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());

  for (const value of ['0', '-5', 'abc']) {
    const { status, body } = await get(historyPath('?limit=' + value), token);
    assert.equal(status, 400, 'limit=' + value);
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.details[0].path, 'query.limit');
  }
});

test('enforces the maximum limit', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());

  const rejected = await get(historyPath('?limit=101'), token);
  assert.equal(rejected.status, 400);
  assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
  assert.equal(rejected.body.error.details[0].path, 'query.limit');

  const atMax = await get(historyPath('?limit=100'), token);
  assert.equal(atMax.status, 200);
  assert.equal(atMax.body.data.pagination.limit, 100);
});

dbTest('returns the authenticated user history', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  await seedHistorical(userId, 'RESOLVED');
  await seedHistorical(userId, 'CANCELLED');

  const { status, body } = await get(historyPath(), sign(userId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.sos.length, 2);
  assert.deepEqual(
    body.data.sos.map((s) => s.status).sort(),
    ['CANCELLED', 'RESOLVED']
  );

  const item = body.data.sos[0];
  assert.ok(item.id);
  assert.equal(item.userId, undefined, 'userId is not exposed in history items');
  assert.equal(typeof item.triggerType, 'string');
  assert.equal(typeof item.createdAt, 'string');
  assert.equal(typeof item.updatedAt, 'string');
  assert.equal(item.resolvedAt !== undefined, true);
  assert.ok('safetySessionId' in item);
  assert.ok('triggerData' in item);
  assert.ok('location' in item);
  assert.ok('verification' in item);
  assert.ok('escalation' in item);
});

dbTest('only returns the authenticated user own history', async () => {
  const userA = new mongoose.Types.ObjectId().toString();
  const userB = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userA, userB);

  const aSos = await seedHistorical(userA, 'RESOLVED');
  await seedHistorical(userB, 'RESOLVED');
  await seedHistorical(userB, 'CANCELLED');

  const { status, body } = await get(historyPath(), sign(userA));

  assert.equal(status, 200);
  assert.equal(body.data.sos.length, 1);
  assert.equal(body.data.sos[0].id, String(aSos._id));
  assert.equal(body.data.pagination.total, 1);

  const byQuery = await get(historyPath('?userId=' + userB), sign(userA));
  assert.equal(byQuery.body.data.sos.length, 1, 'userId query param is ignored');
});

dbTest('includes RESOLVED records', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedHistorical(userId, 'RESOLVED');

  const { status, body } = await get(historyPath(), sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.sos.length, 1);
  assert.equal(body.data.sos[0].id, String(seeded._id));
  assert.equal(body.data.sos[0].status, 'RESOLVED');
  assert.ok(body.data.sos[0].resolvedAt);
});

dbTest('includes CANCELLED records', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const seeded = await seedHistorical(userId, 'CANCELLED');

  const { status, body } = await get(historyPath(), sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.sos.length, 1);
  assert.equal(body.data.sos[0].id, String(seeded._id));
  assert.equal(body.data.sos[0].status, 'CANCELLED');
});

const assertStatusExcluded = async (excludedStatus) => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  const excluded = await seedSos(userId, excludedStatus);
  const included = await seedHistorical(userId, 'RESOLVED');

  const { status, body } = await get(historyPath(), sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.sos.length, 1, excludedStatus + ' must be excluded');
  assert.equal(body.data.sos[0].id, String(included._id));
  assert.notEqual(body.data.sos[0].id, String(excluded._id));
};

dbTest('excludes VERIFYING records', async () => {
  await assertStatusExcluded('VERIFYING');
});

dbTest('excludes ACTIVE records', async () => {
  await assertStatusExcluded('ACTIVE');
});

dbTest('excludes ACKNOWLEDGED records', async () => {
  await assertStatusExcluded('ACKNOWLEDGED');
});

dbTest('excludes ESCALATING records', async () => {
  await assertStatusExcluded('ESCALATING');
});

dbTest('returns records newest first', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);

  const dates = [
    new Date('2026-09-29T10:00:00.000Z'),
    new Date('2026-09-25T10:00:00.000Z'),
    new Date('2026-09-20T10:00:00.000Z'),
    new Date('2026-09-12T10:00:00.000Z'),
  ];

  for (const date of dates) {
    const sos = await seedHistorical(userId, 'RESOLVED');
    await setCreatedAt(sos._id, date);
  }

  const { status, body } = await get(historyPath(), sign(userId));

  assert.equal(status, 200);
  assert.deepEqual(
    body.data.sos.map((s) => s.createdAt),
    dates.map((d) => d.toISOString()),
    'newest → oldest'
  );
});

dbTest('applies default pagination when no query parameters are supplied', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);

  const docs = [];
  for (let i = 0; i < 25; i += 1) docs.push(seedHistorical(userId, i % 2 ? 'CANCELLED' : 'RESOLVED'));
  const seeded = await Promise.all(docs);
  await Promise.all(
    seeded.map((sos, i) => setCreatedAt(sos._id, new Date(Date.now() - i * 1000)))
  );

  const { status, body } = await get(historyPath(), sign(userId));

  assert.equal(status, 200);
  assert.deepEqual(body.data.pagination, { page: 1, limit: 20, total: 25, totalPages: 2 });
  assert.equal(body.data.sos.length, 20, 'default limit of 20 is applied');
});

dbTest('supports custom page and limit', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);

  const docs = [];
  for (let i = 0; i < 25; i += 1) docs.push(seedHistorical(userId, 'RESOLVED'));
  const seeded = await Promise.all(docs);
  await Promise.all(
    seeded.map((sos, i) => setCreatedAt(sos._id, new Date(Date.now() - i * 1000)))
  );

  const { status, body } = await get(historyPath('?page=2&limit=10'), sign(userId));

  assert.equal(status, 200);
  assert.deepEqual(body.data.pagination, { page: 2, limit: 10, total: 25, totalPages: 3 });
  assert.equal(body.data.sos.length, 10, 'second page of 10 records');

  const expectedSecondPage = seeded
    .slice(10, 20)
    .map((s) => String(s._id))
    .sort();
  assert.deepEqual(
    body.data.sos.map((s) => s.id).sort(),
    expectedSecondPage
  );
});

dbTest('reports the correct total and totalPages', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);

  const docs = [];
  for (let i = 0; i < 7; i += 1) docs.push(seedHistorical(userId, 'RESOLVED'));
  await Promise.all(docs);

  const { status, body } = await get(historyPath('?limit=3'), sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.pagination.total, 7);
  assert.equal(body.data.pagination.totalPages, 3);
});

dbTest('returns an empty history as a successful response', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);

  const { status, body } = await get(historyPath(), sign(userId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data.sos, []);
  assert.deepEqual(body.data.pagination, { page: 1, limit: 20, total: 0, totalPages: 0 });
});

dbTest('does not modify any SOS document', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(userId);
  await seedHistorical(userId, 'RESOLVED');
  await seedHistorical(userId, 'CANCELLED');
  await seedSos(userId, 'VERIFYING');

  const before = await SosEvent.find({ userId }).lean();

  const { status } = await get(historyPath(), sign(userId));
  assert.equal(status, 200);

  const after = await SosEvent.find({ userId }).lean();
  assert.deepEqual(after, before, 'history retrieval must be read-only');
});

dbTest('history database failure is handled by the central error middleware', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await get(historyPath(), token);

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------- POST /api/v1/sos/:id/escalation/start ----------

const startEscalation = (sosId, token) =>
  post('/api/v1/sos/' + sosId + '/escalation/start', token, {});

const users = () => mongoose.connection.collection('users');

const seedUserAccount = (userId, name) =>
  users().insertOne({
    _id: new mongoose.Types.ObjectId(String(userId)),
    name,
    email: `${userId}@test.dev`,
  });

const seedGuardianRel = (userId, guardianUserId, { priority = 1, status = 'ACTIVE' } = {}) =>
  Guardian.create({ userId, guardianUserId, relationship: 'Guardian', priority, status });

const newAccountId = () => {
  const id = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(id);
  return id;
};

test('rejects an unauthenticated escalation start', async () => {
  const { status, body } = await startEscalation(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid SOS id on escalation start with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await startEscalation('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('returns 404 for a valid but non-existent SOS id', async () => {
  const userId = newAccountId();

  const { status, body } = await startEscalation(new mongoose.Types.ObjectId().toString(), sign(userId));

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SOS_NOT_FOUND');
});

dbTest('returns 403 when the SOS belongs to another user', async () => {
  const ownerUserId = newAccountId();
  const seeded = await seedSos(ownerUserId, 'ACTIVE');

  const requesterId = newAccountId();
  const { status, body } = await startEscalation(seeded._id, sign(requesterId));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_NOT_AUTHORIZED');
  assert.equal(body.data, undefined, 'no escalation data is exposed to foreign callers');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 0, 'nothing was written');
});

dbTest('starts guardian escalation on an ACTIVE SOS', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');
  await seedUserAccount(guardianId, 'Guardian One');
  await seedGuardianRel(userId, guardianId, { priority: 1 });

  const seeded = await seedSos(userId, 'ACTIVE', {
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
  });

  const before = Date.now();
  const { status, body } = await startEscalation(seeded._id, sign(userId));
  const after = Date.now();

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), ['expiresAt', 'level', 'sosId', 'status', 'targetId']);
  assert.equal(data.sosId, String(seeded._id));
  assert.equal(data.level, 'GUARDIAN');
  assert.equal(data.status, 'PENDING');
  assert.equal(data.targetId, guardianId);

  const expiresAt = new Date(data.expiresAt).getTime();
  assert.ok(expiresAt >= before + 59000, 'expiresAt is at least 59s ahead');
  assert.ok(expiresAt <= after + 61000, 'expiresAt is at most 61s ahead');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE', 'the SOS status never changes here');
  assert.equal(doc.escalation.currentLevel, 0);
  assert.equal(doc.escalation.levels.length, 1);

  const level = doc.escalation.levels[0];
  assert.equal(level.type, 'GUARDIAN');
  assert.equal(level.status, 'PENDING');
  assert.equal(String(level.targetId), guardianId);
  assert.ok(level.notifiedAt, 'notifiedAt is recorded');
  assert.equal(level.respondedAt, null);
  assert.ok(level.expiresAt, 'the deadline is stored on the level');
  assert.equal(String(doc.userId), userId, 'the owner is unchanged');

  const detail = await get('/api/v1/sos/' + seeded._id, sign(userId));
  const serialized = detail.body.data.escalation.levels[0];
  assert.deepEqual(
    Object.keys(serialized).sort(),
    ['notifiedAt', 'respondedAt', 'status', 'targetId', 'type'],
    'the existing serializer stays untouched (no expiresAt leak)'
  );
  assert.equal(serialized.status, 'PENDING');
});

dbTest('a second start replays the existing level instead of stacking one', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');
  await seedUserAccount(guardianId, 'Guardian One');
  await seedGuardianRel(userId, guardianId, { priority: 1 });

  const seeded = await seedSos(userId, 'ACTIVE');
  const token = sign(userId);

  const first = await startEscalation(seeded._id, token);
  const second = await startEscalation(seeded._id, token);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.status, 'PENDING', 'idempotent replay');
  assert.equal(second.body.data.targetId, first.body.data.targetId);
  assert.equal(
    second.body.data.expiresAt,
    first.body.data.expiresAt,
    'the original deadline is replayed unchanged'
  );

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 1, 'exactly one level exists');
  assert.equal(doc.status, 'ACTIVE');
});

dbTest('concurrent starts produce exactly one level and two successful replies', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');
  await seedUserAccount(guardianId, 'Guardian One');
  await seedGuardianRel(userId, guardianId, { priority: 1 });

  const seeded = await seedSos(userId, 'ACTIVE');
  const token = sign(userId);

  const [first, second] = await Promise.all([
    startEscalation(seeded._id, token),
    startEscalation(seeded._id, token),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 200], 'both callers succeed');
  assert.equal(first.body.data.targetId, guardianId);
  assert.equal(second.body.data.targetId, guardianId);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 1, 'the atomic filter allows a single write');
  assert.equal(doc.escalation.levels[0].status, 'PENDING');
  assert.equal(doc.status, 'ACTIVE');
});

dbTest('cannot start escalation before the SOS is ACTIVE', async () => {
  const userId = newAccountId();
  const seeded = await seedSos(userId, 'VERIFYING');

  const { status, body } = await startEscalation(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACTIVE');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 0, 'no level is written');
  assert.equal(doc.status, 'VERIFYING');
});

dbTest('cannot start escalation on a cancelled SOS', async () => {
  const userId = newAccountId();
  const seeded = await seedSos(userId, 'CANCELLED');

  const { status, body } = await startEscalation(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACTIVE');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 0);
  assert.equal(doc.status, 'CANCELLED');
});

dbTest('cannot start escalation on an acknowledged SOS', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');

  const seeded = await seedSos(userId, 'ACKNOWLEDGED', {
    escalation: {
      currentLevel: 0,
      levels: [
        {
          type: 'GUARDIAN',
          status: 'ACKNOWLEDGED',
          targetId: new mongoose.Types.ObjectId(guardianId),
          notifiedAt: new Date(),
          respondedAt: new Date(),
        },
      ],
    },
  });

  const { status, body } = await startEscalation(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_ALREADY_ACKNOWLEDGED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.escalation.levels.length, 1, 'no second level');
});

dbTest('cannot start escalation when the guardian level already timed out', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');

  const seeded = await seedSos(userId, 'ACTIVE', {
    escalation: {
      currentLevel: 0,
      levels: [
        {
          type: 'GUARDIAN',
          status: 'TIMEOUT',
          targetId: new mongoose.Types.ObjectId(guardianId),
          notifiedAt: new Date(),
          respondedAt: null,
        },
      ],
    },
  });

  const { status, body } = await startEscalation(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_ALREADY_PROGRESS');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 1, 'the timed-out level is preserved');
  assert.equal(doc.escalation.levels[0].status, 'TIMEOUT');
});

dbTest('skips inactive guardians and guardians without an account', async () => {
  const userId = newAccountId();
  const inactiveId = newAccountId();
  const accountlessId = newAccountId();
  const chosenId = newAccountId();

  await seedUserAccount(userId, 'Ansuman');
  await seedUserAccount(inactiveId, 'Inactive Guardian');
  await seedUserAccount(chosenId, 'Chosen Guardian');

  await seedGuardianRel(userId, inactiveId, { priority: 1, status: 'PENDING' });
  await seedGuardianRel(userId, accountlessId, { priority: 2 });
  await seedGuardianRel(userId, chosenId, { priority: 3 });

  const seeded = await seedSos(userId, 'ACTIVE');
  const { status, body } = await startEscalation(seeded._id, sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.targetId, chosenId, 'first eligible guardian in priority order wins');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(String(doc.escalation.levels[0].targetId), chosenId);
});

dbTest('breaks equal priorities by creation order', async () => {
  const userId = newAccountId();
  const firstId = newAccountId();
  const secondId = newAccountId();

  await seedUserAccount(userId, 'Ansuman');
  await seedUserAccount(firstId, 'First Guardian');
  await seedUserAccount(secondId, 'Second Guardian');

  const firstRel = await seedGuardianRel(userId, firstId, { priority: 1 });
  await seedGuardianRel(userId, secondId, { priority: 1 });

  // Deterministic tie-break regardless of sub-millisecond insert timing.
  await Guardian.collection.updateOne(
    { _id: firstRel._id },
    { $set: { createdAt: new Date(Date.now() - 60000) } }
  );

  const seeded = await seedSos(userId, 'ACTIVE');
  const { status, body } = await startEscalation(seeded._id, sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.targetId, firstId, 'older relationship at the same priority wins');
});

dbTest('records a TIMEOUT level when the user has no guardian at all', async () => {
  const userId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');

  const seeded = await seedSos(userId, 'ACTIVE');

  const { status, body } = await startEscalation(seeded._id, sign(userId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.level, 'GUARDIAN');
  assert.equal(body.data.status, 'TIMEOUT');
  assert.equal(body.data.targetId, null);
  assert.equal(body.data.expiresAt, null);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE', 'the SOS still runs');
  assert.equal(doc.escalation.levels.length, 1);

  const level = doc.escalation.levels[0];
  assert.equal(level.type, 'GUARDIAN');
  assert.equal(level.status, 'TIMEOUT');
  assert.equal(level.targetId, null);
  assert.equal(level.notifiedAt, null, 'nobody was notified');
  assert.equal(level.respondedAt, null);
  assert.equal(level.expiresAt, null, 'no timer is armed for an unreachable guardian');
});

dbTest('escalation start does not initialize or require Socket.IO', async () => {
  assert.throws(() => getIO(), /has not been initialized/);

  const userId = newAccountId();
  const guardianId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');
  await seedUserAccount(guardianId, 'Guardian One');
  await seedGuardianRel(userId, guardianId, { priority: 1 });

  const seeded = await seedSos(userId, 'ACTIVE');
  const { status } = await startEscalation(seeded._id, sign(userId));

  assert.equal(status, 200, 'notification delivery is best effort over HTTP');
  assert.throws(() => getIO(), /has not been initialized/);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels[0].status, 'PENDING', 'the level persisted regardless');
});

// ---------- POST /api/v1/sos/:id/escalation/acknowledge ----------

const ackEscalation = (sosId, token, payload) =>
  post('/api/v1/sos/' + sosId + '/escalation/acknowledge', token, payload ?? {});

const seedAckFixture = async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');
  await seedUserAccount(guardianId, 'Guardian One');
  await seedGuardianRel(userId, guardianId, { priority: 1 });
  const seeded = await seedSos(userId, 'ACTIVE');
  return { userId, guardianId, seeded };
};

test('rejects an unauthenticated escalation acknowledge', async () => {
  const { status, body } = await ackEscalation(
    new mongoose.Types.ObjectId().toString(),
    null,
    { level: 'GUARDIAN' }
  );

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid SOS id on escalation acknowledge with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await ackEscalation('not-an-id', token, { level: 'GUARDIAN' });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

test('rejects a missing level with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await ackEscalation(
    new mongoose.Types.ObjectId().toString(),
    token,
    {}
  );

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.level');
});

test('rejects POLICE as an acknowledge level with 400', async () => {
  const token = sign(new mongoose.Types.ObjectId().toString());
  const { status, body } = await ackEscalation(
    new mongoose.Types.ObjectId().toString(),
    token,
    { level: 'POLICE' }
  );

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.level');
});

dbTest('acknowledging a non-existent SOS returns 404', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();

  const { status, body } = await ackEscalation(
    new mongoose.Types.ObjectId().toString(),
    sign(guardianId),
    { level: 'GUARDIAN' }
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SOS_NOT_FOUND');
});

dbTest('guardian acknowledges the current level through the API', async () => {
  const { userId, guardianId, seeded } = await seedAckFixture();
  const started = await startEscalation(seeded._id, sign(userId));
  assert.equal(started.status, 200);
  assert.equal(started.body.data.status, 'PENDING');

  const before = Date.now();
  const { status, body } = await ackEscalation(seeded._id, sign(guardianId), {
    level: 'GUARDIAN',
  });
  const after = Date.now();

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const data = body.data;
  assert.deepEqual(
    Object.keys(data).sort(),
    ['acknowledgedAt', 'acknowledgedBy', 'level', 'sosId', 'status'],
    'the documented response shape, nothing extra'
  );
  assert.equal(data.sosId, String(seeded._id));
  assert.equal(data.level, 'GUARDIAN');
  assert.equal(data.status, 'ACKNOWLEDGED');
  assert.equal(data.acknowledgedBy, guardianId, 'backend-derived from the JWT');

  const ackedAt = new Date(data.acknowledgedAt).getTime();
  assert.ok(ackedAt >= before && ackedAt <= after, 'acknowledgedAt is generated by the server');
  assert.equal(data.acknowledgedAt, new Date(ackedAt).toISOString(), 'serialized as ISO-8601');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED', 'leaves ACTIVE through the existing ack rule');
  assert.notEqual(doc.status, 'RESOLVED', 'acknowledgement never resolves the SOS');
  assert.equal(doc.escalation.currentLevel, 0, 'the next level is never entered here');
  assert.equal(doc.escalation.levels.length, 1, 'no escalation level is created');

  const level = doc.escalation.levels[0];
  assert.equal(level.type, 'GUARDIAN');
  assert.equal(level.status, 'ACKNOWLEDGED');
  assert.equal(String(level.targetId), guardianId, 'targetId is preserved');
  assert.ok(level.notifiedAt, 'notifiedAt is preserved');
  const respondedAt = new Date(level.respondedAt).getTime();
  assert.ok(respondedAt >= before && respondedAt <= after, 'respondedAt is server generated');
  assert.equal(String(doc.userId), userId, 'the owner is unchanged');

  const active = await get('/api/v1/sos/active', sign(userId));
  assert.equal(active.body.data.active, true, 'an acknowledged SOS is still unresolved');
  assert.equal(active.body.data.sos.status, 'ACKNOWLEDGED');

  const detail = await get('/api/v1/sos/' + seeded._id, sign(userId));
  assert.equal(detail.body.data.status, 'ACKNOWLEDGED');
});

dbTest('the SOS owner cannot acknowledge the guardian level', async () => {
  const { userId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));

  const { status, body } = await ackEscalation(seeded._id, sign(userId), { level: 'GUARDIAN' });

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_RECIPIENT_NOT_AUTHORIZED');
  assert.equal(body.data, undefined, 'no SOS data is exposed to unauthorized users');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.escalation.levels[0].status, 'PENDING', 'nothing was acknowledged');
  assert.equal(doc.escalation.levels[0].respondedAt, null);
});

dbTest('an unrelated user cannot acknowledge the guardian level', async () => {
  const { userId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));
  const strangerId = newAccountId();

  const { status, body } = await ackEscalation(seeded._id, sign(strangerId), {
    level: 'GUARDIAN',
  });

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_RECIPIENT_NOT_AUTHORIZED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.escalation.levels[0].status, 'PENDING');
});

dbTest('acknowledging a different level than the current one is a 409', async () => {
  const { userId, guardianId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));

  const { status, body } = await ackEscalation(seeded._id, sign(guardianId), {
    level: 'NEARBY_RESPONDER',
  });

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_LEVEL_MISMATCH');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.escalation.levels[0].status, 'PENDING', 'a mismatch never writes');
});

dbTest('a guardian whose relationship was deactivated cannot acknowledge', async () => {
  const { userId, guardianId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));

  const rel = await Guardian.findOne({ userId, guardianUserId: guardianId });
  assert.ok(rel, 'the relationship exists after start');
  await Guardian.collection.updateOne({ _id: rel._id }, { $set: { status: 'BLOCKED' } });

  const blocked = await ackEscalation(seeded._id, sign(guardianId), { level: 'GUARDIAN' });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'SOS_RECIPIENT_NOT_AUTHORIZED');

  await Guardian.collection.deleteOne({ _id: rel._id });
  const removed = await ackEscalation(seeded._id, sign(guardianId), { level: 'GUARDIAN' });
  assert.equal(removed.status, 403);
  assert.equal(removed.body.error.code, 'SOS_RECIPIENT_NOT_AUTHORIZED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(
    doc.escalation.levels[0].status,
    'PENDING',
    'still waiting for a currently-active guardian'
  );
});

dbTest('a second escalation acknowledge is refused and changes nothing', async () => {
  const { userId, guardianId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));

  const first = await ackEscalation(seeded._id, sign(guardianId), { level: 'GUARDIAN' });
  assert.equal(first.status, 200);

  const afterFirst = await SosEvent.findById(seeded._id).lean();
  const respondedAt = afterFirst.escalation.levels[0].respondedAt.getTime();

  const second = await ackEscalation(seeded._id, sign(guardianId), { level: 'GUARDIAN' });

  assert.equal(second.status, 409, 'idempotent replays are 409 by project convention');
  assert.equal(second.body.error.code, 'SOS_ALREADY_ACKNOWLEDGED');

  const afterSecond = await SosEvent.findById(seeded._id).lean();
  assert.equal(afterSecond.status, 'ACKNOWLEDGED');
  assert.equal(afterSecond.escalation.levels[0].status, 'ACKNOWLEDGED');
  assert.equal(
    afterSecond.escalation.levels[0].respondedAt.getTime(),
    respondedAt,
    'respondedAt is untouched by the replay'
  );
  assert.equal(afterSecond.escalation.levels.length, 1, 'no extra level appears');
});

dbTest('concurrent escalation acknowledgements produce exactly one success', async () => {
  const { userId, guardianId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));
  const token = sign(guardianId);

  const [first, second] = await Promise.all([
    ackEscalation(seeded._id, token, { level: 'GUARDIAN' }),
    ackEscalation(seeded._id, token, { level: 'GUARDIAN' }),
  ]);

  assert.deepEqual(
    [first.status, second.status].sort((a, b) => a - b),
    [200, 409],
    'exactly one caller wins'
  );
  const loser = first.status === 409 ? first : second;
  assert.equal(loser.body.error.code, 'SOS_ALREADY_ACKNOWLEDGED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.escalation.levels[0].status, 'ACKNOWLEDGED');
  assert.ok(doc.escalation.levels[0].respondedAt, 'the single write recorded respondedAt');
  assert.equal(doc.escalation.levels.length, 1);
});

dbTest('a cancelled SOS cannot be acknowledged through escalation', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  const seeded = await seedSosWithLevels(userId, 'CANCELLED', [guardianLevel(guardianId)]);

  const { status, body } = await ackEscalation(seeded._id, sign(guardianId), {
    level: 'GUARDIAN',
  });

  assert.equal(status, 409);
  assert.equal(body.error.code, 'SOS_NOT_ACKNOWLEDGEABLE');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'CANCELLED');
  assert.equal(doc.escalation.levels[0].status, 'PENDING', 'nothing was acknowledged');
});

dbTest('a timed-out guardian level cannot be acknowledged', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  const seeded = await seedSosWithLevels(userId, 'ACTIVE', [
    guardianLevel(guardianId, 'TIMEOUT'),
  ]);

  const { status, body } = await ackEscalation(seeded._id, sign(guardianId), {
    level: 'GUARDIAN',
  });

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_ALREADY_PROGRESS');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE', 'a refused acknowledgement never changes the status');
  assert.equal(doc.escalation.levels[0].status, 'TIMEOUT');
  assert.equal(doc.escalation.levels[0].respondedAt, null);
});

dbTest('a notified responder acknowledges the responder level', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  const responderA = newAccountId();
  const responderB = newAccountId();
  await seedUserAccount(userId, 'Ansuman');

  const notifiedAt = new Date();
  const seeded = await seedSosWithLevels(
    userId,
    'ESCALATING',
    [
      guardianLevel(guardianId, 'TIMEOUT'),
      {
        type: 'NEARBY_RESPONDER',
        status: 'PENDING',
        targetId: null,
        notifiedResponders: [
          new mongoose.Types.ObjectId(responderA),
          new mongoose.Types.ObjectId(responderB),
        ],
        notifiedAt,
        respondedAt: null,
      },
    ],
    1
  );

  const before = Date.now();
  const { status, body } = await ackEscalation(seeded._id, sign(responderA), {
    level: 'NEARBY_RESPONDER',
  });
  const after = Date.now();

  assert.equal(status, 200);
  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), [
    'acknowledgedAt',
    'acknowledgedBy',
    'level',
    'sosId',
    'status',
  ]);
  assert.equal(data.level, 'NEARBY_RESPONDER');
  assert.equal(data.status, 'ACKNOWLEDGED');
  assert.equal(data.acknowledgedBy, responderA);
  const ackedAt = new Date(data.acknowledgedAt).getTime();
  assert.ok(ackedAt >= before && ackedAt <= after, 'acknowledgedAt is server generated');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.escalation.currentLevel, 1, 'currentLevel never advances on acknowledgement');
  assert.equal(doc.escalation.levels.length, 2, 'no escalation level is created');

  const responderLevelDoc = doc.escalation.levels[1];
  assert.equal(responderLevelDoc.status, 'ACKNOWLEDGED');
  assert.equal(String(responderLevelDoc.targetId), responderA, 'records who acknowledged');
  assert.equal(new Date(responderLevelDoc.notifiedAt).getTime(), notifiedAt.getTime());
  const respondedAt = new Date(responderLevelDoc.respondedAt).getTime();
  assert.ok(respondedAt >= before && respondedAt <= after, 'respondedAt is server generated');
  assert.deepEqual(
    responderLevelDoc.notifiedResponders.map(String),
    [responderA, responderB],
    'the notified list is preserved untouched'
  );

  const guardianLevelDoc = doc.escalation.levels[0];
  assert.equal(guardianLevelDoc.status, 'TIMEOUT', 'the earlier level is untouched');
  assert.equal(String(guardianLevelDoc.targetId), guardianId);
  assert.equal(guardianLevelDoc.respondedAt, null);
});

dbTest('a responder outside the notified list cannot acknowledge', async () => {
  const userId = newAccountId();
  const guardianId = newAccountId();
  const responderA = newAccountId();
  const outsiderId = newAccountId();
  await seedUserAccount(userId, 'Ansuman');

  const seeded = await seedSosWithLevels(
    userId,
    'ESCALATING',
    [
      guardianLevel(guardianId, 'TIMEOUT'),
      {
        type: 'NEARBY_RESPONDER',
        status: 'PENDING',
        targetId: null,
        notifiedResponders: [new mongoose.Types.ObjectId(responderA)],
        notifiedAt: new Date(),
        respondedAt: null,
      },
    ],
    1
  );

  const { status, body } = await ackEscalation(seeded._id, sign(outsiderId), {
    level: 'NEARBY_RESPONDER',
  });

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_RECIPIENT_NOT_AUTHORIZED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ESCALATING');
  assert.equal(doc.escalation.levels[1].status, 'PENDING');
  assert.equal(doc.escalation.levels[1].targetId, null, 'targetId stays unset');
});

dbTest('the armed timeout never overwrites an acknowledged level', async () => {
  const { userId, guardianId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));

  const ack = await ackEscalation(seeded._id, sign(guardianId), { level: 'GUARDIAN' });
  assert.equal(ack.status, 200);

  const fired = await runGuardianTimeout({ sosId: String(seeded._id) });
  assert.equal(fired, false, 'nothing was pending anymore');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACKNOWLEDGED');
  assert.equal(doc.escalation.levels[0].status, 'ACKNOWLEDGED', 'never TIMEOUT after ACKNOWLEDGED');
  assert.equal(
    doc.escalation.levels[0].respondedAt.getTime(),
    new Date(ack.body.data.acknowledgedAt).getTime(),
    'the acknowledged timestamp survived the late timer'
  );
});

dbTest('acknowledging after the guardian level timed out is refused', async () => {
  const { userId, guardianId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));

  const fired = await runGuardianTimeout({ sosId: String(seeded._id) });
  assert.equal(fired, true, 'the pending level timed out');

  const { status, body } = await ackEscalation(seeded._id, sign(guardianId), {
    level: 'GUARDIAN',
  });

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_ALREADY_PROGRESS');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE', 'the timeout does not change the SOS status');
  assert.equal(doc.escalation.levels[0].status, 'TIMEOUT', 'never TIMEOUT -> ACKNOWLEDGED');
  assert.equal(doc.escalation.levels[0].respondedAt, null);
});

dbTest('escalation acknowledgement does not initialize or require Socket.IO', async () => {
  assert.throws(() => getIO(), /has not been initialized/);

  const { userId, guardianId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));

  const { status } = await ackEscalation(seeded._id, sign(guardianId), { level: 'GUARDIAN' });

  assert.equal(status, 200, 'delivery is best effort over HTTP');
  assert.throws(() => getIO(), /has not been initialized/);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels[0].status, 'ACKNOWLEDGED', 'the write persisted regardless');
});

dbTest('the owner can resolve after the escalation acknowledgement', async () => {
  const { userId, guardianId, seeded } = await seedAckFixture();
  await startEscalation(seeded._id, sign(userId));

  const ack = await ackEscalation(seeded._id, sign(guardianId), { level: 'GUARDIAN' });
  assert.equal(ack.status, 200);

  const resolved = await resolveSos(seeded._id, sign(userId));

  assert.equal(resolved.status, 200, 'acknowledged state keeps /:id/resolve usable');
  assert.equal(resolved.body.data.status, 'RESOLVED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'RESOLVED');
  assert.equal(doc.escalation.levels[0].status, 'ACKNOWLEDGED', 'levels are untouched by resolve');
});
