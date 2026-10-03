import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Call } from '../src/modules/calling/call.model.js';
import { Guardian } from '../src/modules/guardians/guardian.model.js';
import { SosEvent } from '../src/modules/sos/sos.model.js';
import { getIO } from '../src/sockets/index.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const createdUserIds = [];
const createdCallIds = [];
const createdSosIds = [];

const sign = (userId) =>
  jwt.sign({ sub: userId, role: 'USER' }, env.jwtSecret, { expiresIn: '5m' });

const newId = () => {
  const id = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(id);
  return id;
};

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

const tokenFor = (callId, token) => post('/api/v1/calls/token', token, { callId });

const decodeClaims = (livekitToken) =>
  JSON.parse(Buffer.from(livekitToken.split('.')[1], 'base64url').toString());

const seedCall = async (ownerId, overrides = {}) => {
  const call = await Call.create({
    sosId: new mongoose.Types.ObjectId(),
    userId: ownerId,
    roomName: 'emergency-call-' + new mongoose.Types.ObjectId().toString(),
    status: 'CREATED',
    ...overrides,
  });
  createdCallIds.push(String(call._id));
  return call;
};

const users = () => mongoose.connection.collection('users');

const seedUser = (userId, name) =>
  users().insertOne({
    _id: new mongoose.Types.ObjectId(String(userId)),
    name,
    email: `${userId}@test.dev`,
  });

const seedSos = async (userId, status) => {
  const sos = await SosEvent.create({
    userId,
    triggerType: 'MANUAL',
    status,
    verification: { expiresAt: new Date(Date.now() + 60000), userResponse: null, respondedAt: null },
    escalation: { currentLevel: 0, levels: [] },
  });
  createdSosIds.push(String(sos._id));
  return sos;
};

const seedGuardian = (userId, guardianUserId, priority, status = 'ACTIVE') =>
  Guardian.create({ userId, guardianUserId, relationship: 'Guardian', priority, status });

const startCall = (sosId, token) => post('/api/v1/calls/start', token, { sosId });

const endCallReq = (callId, token, endReason) =>
  post('/api/v1/calls/end', token, endReason ? { callId, endReason } : { callId });

before(async () => {
  if (hasDb) await connectDB();

  server = http.createServer(app);
  port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
});

after(async () => {
  if (hasDb && mongoose.connection.readyState !== 0) {
    const ids = createdUserIds.map((id) => new mongoose.Types.ObjectId(id));

    await Call.deleteMany({ _id: { $in: createdCallIds } });
    await Call.deleteMany({ userId: { $in: ids } });
    await SosEvent.deleteMany({ _id: { $in: createdSosIds } });
    await Guardian.deleteMany({ $or: [{ userId: { $in: ids } }, { guardianUserId: { $in: ids } }] });
    await users().deleteMany({ _id: { $in: ids } });
    await disconnectDB();
  }

  if (server) await new Promise((resolve) => server.close(resolve));
});

test('rejects an unauthenticated token request', async () => {
  const { status, body } = await tokenFor(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects a missing callId with 400', async () => {
  const token = sign(newId());
  const { status, body } = await post('/api/v1/calls/token', token, {});

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.callId');
});

test('rejects an invalid callId with 400', async () => {
  const token = sign(newId());
  const { status, body } = await tokenFor('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.callId');
});

test('rejects client-supplied roomName and participantIdentity', async () => {
  const token = sign(newId());
  const callId = new mongoose.Types.ObjectId().toString();

  for (const payload of [
    { callId, roomName: 'attacker-room' },
    { callId, participantIdentity: 'user:someone-else' },
    { callId, guardianPhone: '+10000000000' },
    { callId, apiSecret: 'stolen-secret' },
  ]) {
    const { status, body } = await post('/api/v1/calls/token', token, payload);

    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
});

test('rejects client-supplied identity, role and permission fields', async () => {
  const token = sign(newId());
  const callId = new mongoose.Types.ObjectId().toString();

  for (const payload of [
    { callId, userId: newId() },
    { callId, guardianUserId: newId() },
    { callId, role: 'ADMIN' },
    { callId, permissions: { canAdmin: true, roomCreate: true } },
    { callId, serverUrl: 'wss://attacker.livekit.cloud' },
    { callId, ttl: 86400 },
    { callId, participantType: 'SIP' },
  ]) {
    const { status, body } = await post('/api/v1/calls/token', token, payload);

    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
});

dbTest('the protected owner receives a valid token for their call', async () => {
  const ownerId = newId();
  const call = await seedCall(ownerId);

  const { status, body } = await tokenFor(String(call._id), sign(ownerId));

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const data = body.data;
  assert.equal(typeof data.token, 'string');
  assert.equal(data.serverUrl, env.livekit.url);
  assert.equal(data.roomName, call.roomName, 'room comes from the stored record');
  assert.equal(data.participantIdentity, 'user:' + ownerId);

  const claims = decodeClaims(data.token);
  assert.equal(claims.sub, 'user:' + ownerId, 'token subject is the backend identity');
  assert.equal(claims.video.room, call.roomName, 'token is bound to the stored room');
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.iss, env.livekit.apiKey);
});

dbTest('an authorized guardian receives a valid token', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const call = await seedCall(ownerId, { guardianUserId: guardianId, status: 'RINGING' });

  const { status, body } = await tokenFor(String(call._id), sign(guardianId));

  assert.equal(status, 200);
  assert.equal(body.data.roomName, call.roomName);
  assert.equal(body.data.participantIdentity, 'user:' + guardianId);

  const claims = decodeClaims(body.data.token);
  assert.equal(claims.sub, 'user:' + guardianId);
});

dbTest('returns not found for a non-existent call', async () => {
  const userId = newId();

  const { status, body } = await tokenFor(new mongoose.Types.ObjectId().toString(), sign(userId));

  assert.equal(status, 404);
  assert.equal(body.error.code, 'CALL_NOT_FOUND');
});

dbTest('an unrelated user cannot obtain a token for another user call', async () => {
  const ownerId = newId();
  const strangerId = newId();
  const call = await seedCall(ownerId);

  const { status, body } = await tokenFor(String(call._id), sign(strangerId));

  assert.equal(status, 403);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'CALL_NOT_AUTHORIZED');
  assert.equal(body.data, undefined, 'no connection details are leaked');
});

dbTest('the guardian cannot use the token endpoint for a call they are not on', async () => {
  const ownerId = newId();
  const otherGuardian = newId();
  const call = await seedCall(ownerId, { guardianUserId: newId() });

  const { status, body } = await tokenFor(String(call._id), sign(otherGuardian));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'CALL_NOT_AUTHORIZED');
});

const assertNotJoinable = async (callStatus) => {
  const ownerId = newId();
  const call = await seedCall(ownerId, { status: callStatus });

  const { status, body } = await tokenFor(String(call._id), sign(ownerId));

  assert.equal(status, 409, callStatus);
  assert.equal(body.error.code, 'CALL_NOT_JOINABLE');
  assert.equal(body.data, undefined, 'no token is issued');
};

dbTest('no token for an ENDED call', async () => {
  await assertNotJoinable('ENDED');
});

dbTest('no token for a FAILED call', async () => {
  await assertNotJoinable('FAILED');
});

dbTest('no token for a CANCELLED call', async () => {
  await assertNotJoinable('CANCELLED');
});

dbTest('a token is issued while the call is OUTGOING', async () => {
  const ownerId = newId();
  const call = await seedCall(ownerId, { status: 'OUTGOING' });

  const { status, body } = await tokenFor(String(call._id), sign(ownerId));

  assert.equal(status, 200);
  assert.equal(body.data.roomName, call.roomName);
  assert.equal(body.data.participantIdentity, 'user:' + ownerId);
});

dbTest('returns 500 when the call record has no valid room name', async () => {
  const ownerId = newId();
  const call = await seedCall(ownerId);
  await Call.collection.updateOne({ _id: call._id }, { $unset: { roomName: '' } });

  const { status, body } = await tokenFor(String(call._id), sign(ownerId));

  assert.equal(status, 500);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'CALL_ROOM_MISSING');
  assert.equal(body.data, undefined, 'no token is issued');
});

dbTest('tokens are short-lived with only join/publish/subscribe permissions', async () => {
  const ownerId = newId();
  const call = await seedCall(ownerId);

  const { status, body } = await tokenFor(String(call._id), sign(ownerId));
  assert.equal(status, 200);

  const claims = decodeClaims(body.data.token);
  const ttlSeconds = env.livekit.tokenTtlSeconds;

  assert.ok(claims.exp > claims.nbf, 'token has a future expiry');
  assert.ok(
    claims.exp - claims.nbf <= ttlSeconds,
    'lifetime is bounded by configuration (' + ttlSeconds + 's)'
  );
  assert.ok(claims.exp - claims.nbf <= 3600, 'token is short-lived (<= 1h)');

  const video = claims.video;
  assert.equal(video.roomJoin, true);
  assert.equal(video.room, call.roomName);
  assert.equal(video.canPublish, true, 'may publish mic audio');
  assert.equal(video.canSubscribe, true, 'may subscribe to audio');

  assert.ok(!video.canAdmin, 'no admin privileges');
  assert.ok(!video.canCreateRooms, 'cannot create rooms');
  assert.ok(!video.canUpdateParticipants, 'cannot manage participants');
  assert.ok(!video.roomCreate, 'no room create grant');
  assert.ok(!video.sip, 'no SIP grant');
  assert.ok(!claims.grants, 'no extra grant bag');
});

dbTest('never returns LiveKit secrets in the response', async () => {
  const ownerId = newId();
  const call = await seedCall(ownerId);

  const { status, body } = await tokenFor(String(call._id), sign(ownerId));
  assert.equal(status, 200);

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes(env.livekit.apiSecret), 'apiSecret never leaks');
  assert.ok(!raw.includes('apiSecret'));
  assert.ok(!raw.includes('LIVEKIT_API_SECRET'));
  assert.equal(body.data.apiKey, undefined);
  assert.equal(body.data.apiSecret, undefined);
  assert.deepEqual(
    Object.keys(body.data).sort(),
    ['participantIdentity', 'roomName', 'serverUrl', 'token'],
    'only the required connection fields are returned'
  );
});

dbTest('reuses a stored participant identity when the call record has one', async () => {
  const ownerId = newId();
  const call = await seedCall(ownerId, {
    identities: { [ownerId]: 'user:' + ownerId + '-cached' },
  });

  const { status, body } = await tokenFor(String(call._id), sign(ownerId));

  assert.equal(status, 200);
  assert.equal(body.data.participantIdentity, 'user:' + ownerId + '-cached');

  const claims = decodeClaims(body.data.token);
  assert.equal(claims.sub, 'user:' + ownerId + '-cached');
});

// ---------------------------------------------------------------------------
// POST /api/v1/calls/start
// ---------------------------------------------------------------------------

test('rejects an unauthenticated start request', async () => {
  const { status, body } = await startCall(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects a missing sosId with 400', async () => {
  const token = sign(newId());

  const { status, body } = await post('/api/v1/calls/start', token, {});

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.sosId');
});

test('rejects an invalid sosId with 400', async () => {
  const token = sign(newId());

  const { status, body } = await startCall('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.sosId');
});

test('rejects client-supplied call fields on start', async () => {
  const token = sign(newId());
  const sosId = new mongoose.Types.ObjectId().toString();

  for (const payload of [
    { sosId, userId: newId() },
    { sosId, guardianUserId: newId() },
    { sosId, participantIdentity: 'user:attacker' },
    { sosId, roomName: 'attacker-room' },
    { sosId, type: 'SIP' },
    { sosId, status: 'CONNECTED' },
    { sosId, token: 'stolen' },
    { sosId, apiSecret: 'stolen-secret' },
  ]) {
    const { status, body } = await post('/api/v1/calls/start', token, payload);

    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
});

const seedCallerWithGuardian = async (priority = 1, guardianStatus = 'ACTIVE') => {
  const ownerId = newId();
  const guardianId = newId();

  await seedUser(ownerId, 'Asha');
  await seedUser(guardianId, 'Baba');
  await seedGuardian(ownerId, guardianId, priority, guardianStatus);

  return { ownerId, guardianId };
};

dbTest('creates a call and rings the guardian for the caller active SOS', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');

  const { status, body } = await startCall(String(sos._id), sign(ownerId));

  assert.equal(status, 201);
  assert.equal(body.success, true);

  const call = body.data.call;
  assert.deepEqual(
    Object.keys(call).sort(),
    ['createdAt', 'guardianUserId', 'id', 'roomName', 'sosId', 'status', 'type', 'userId'],
    'only the response fields of the spec are exposed'
  );
  assert.equal(call.status, 'RINGING', 'the call is already waiting for the guardian');
  assert.equal(call.type, 'BROWSER_TO_BROWSER');
  assert.equal(call.userId, ownerId);
  assert.equal(call.guardianUserId, guardianId);
  assert.equal(call.sosId, String(sos._id));
  assert.equal(call.roomName, 'emergency-call-' + call.id);
  assert.match(call.roomName, /^emergency-call-[0-9a-f]{24}$/);
  assert.equal(typeof call.createdAt, 'string');

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes('serverUrl'), 'no provider url');
  assert.ok(!raw.includes('jwt'), 'no token material');
  assert.equal(body.data.token, undefined, 'start does not mint a token');

  const stored = await Call.findById(call.id).lean();
  assert.ok(stored, 'the call is persisted');
  assert.equal(stored.status, 'RINGING');
  assert.ok(stored.ringingAt, 'the ringing timestamp is recorded with the flip');
  assert.ok(
    Math.abs(new Date(stored.ringingAt).getTime() - new Date(stored.startedAt).getTime()) < 60000,
    'ringing follows the start of the call'
  );
  assert.equal(stored.roomName, call.roomName);
  assert.equal(String(stored.sosId), String(sos._id));
  assert.ok(
    Math.abs(new Date(stored.startedAt).getTime() - new Date(call.createdAt).getTime()) < 60000,
    'the session timestamp is recorded when the call starts'
  );
  assert.equal(stored.endedAt, null, 'the call is not over yet');
  assert.deepEqual(
    stored.participants.map((p) => [String(p.userId), p.identity, p.role]),
    [
      [ownerId, 'user:' + ownerId, 'USER'],
      [guardianId, 'user:' + guardianId, 'GUARDIAN'],
    ],
    'both participants carry their role'
  );
});

dbTest('returns 404 for a SOS that does not exist', async () => {
  const ownerId = newId();

  const { status, body } = await startCall(new mongoose.Types.ObjectId().toString(), sign(ownerId));

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SOS_NOT_FOUND');
  assert.equal(body.data, undefined);
});

dbTest('returns 403 when the SOS belongs to somebody else', async () => {
  const ownerId = newId();
  const strangerId = newId();
  await seedUser(ownerId, 'Asha');
  const sos = await seedSos(ownerId, 'ACTIVE');

  const { status, body } = await startCall(String(sos._id), sign(strangerId));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_NOT_AUTHORIZED');
  assert.equal(await Call.countDocuments({ sosId: sos._id }), 0, 'no call document is created');
});

dbTest('returns 409 unless the SOS is a live emergency', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();

  for (const sosStatus of ['VERIFYING', 'CANCELLED', 'RESOLVED']) {
    const sos = await seedSos(ownerId, sosStatus);

    const { status, body } = await startCall(String(sos._id), sign(ownerId));

    assert.equal(status, 409, sosStatus);
    assert.equal(body.error.code, 'SOS_NOT_ACTIVE', sosStatus);
    assert.equal(await Call.countDocuments({ sosId: sos._id }), 0, sosStatus);
  }

  assert.ok(guardianId);
});

dbTest('starts a call while guardian communication is still allowed', async () => {
  const { ownerId } = await seedCallerWithGuardian();

  for (const sosStatus of ['ESCALATING', 'ACKNOWLEDGED']) {
    const sos = await seedSos(ownerId, sosStatus);

    const { status, body } = await startCall(String(sos._id), sign(ownerId));

    assert.equal(status, 201, sosStatus);
    assert.equal(body.data.call.status, 'RINGING', sosStatus);
  }
});

dbTest('returns 409 when the owner has no guardian to call', async () => {
  const ownerId = newId();
  await seedUser(ownerId, 'Asha');
  const sos = await seedSos(ownerId, 'ACTIVE');

  const { status, body } = await startCall(String(sos._id), sign(ownerId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'CALL_NO_ELIGIBLE_GUARDIAN');
  assert.equal(await Call.countDocuments({ sosId: sos._id }), 0);
});

dbTest('ignores a guardian that is not ACTIVE yet', async () => {
  const { ownerId } = await seedCallerWithGuardian(1, 'PENDING');
  const sos = await seedSos(ownerId, 'ACTIVE');

  const { status, body } = await startCall(String(sos._id), sign(ownerId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'CALL_NO_ELIGIBLE_GUARDIAN');
  assert.equal(await Call.countDocuments({ sosId: sos._id }), 0);
});

dbTest('calls the highest-priority ACTIVE guardian', async () => {
  const ownerId = newId();
  const rejected = newId();
  const first = newId();
  const second = newId();

  for (const id of [ownerId, rejected, first, second]) {
    await seedUser(id, 'Person-' + id.slice(-4));
  }

  const sos = await seedSos(ownerId, 'ACTIVE');
  await seedGuardian(ownerId, rejected, 1, 'REJECTED');
  await seedGuardian(ownerId, first, 1, 'ACTIVE');
  await seedGuardian(ownerId, second, 2, 'ACTIVE');

  const { status, body } = await startCall(String(sos._id), sign(ownerId));

  assert.equal(status, 201);
  assert.equal(
    body.data.call.guardianUserId,
    first,
    'lowest priority number among ACTIVE guardians wins'
  );
});

dbTest('a second start request reports the call already in flight', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');

  const first = await startCall(String(sos._id), sign(ownerId));
  assert.equal(first.status, 201);

  const second = await startCall(String(sos._id), sign(ownerId));

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'CALL_ALREADY_ACTIVE');
  assert.equal(second.body.error.details.existing.id, first.body.data.call.id);
  assert.equal(second.body.error.details.existing.status, 'RINGING');
  assert.equal(second.body.error.details.existing.guardianUserId, guardianId);
  assert.equal(await Call.countDocuments({ sosId: sos._id }), 1, 'still exactly one call');
});

dbTest('a previous ENDED call does not block a new call for the same SOS', async () => {
  const { ownerId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');
  await seedCall(ownerId, { sosId: sos._id, status: 'ENDED' });

  const { status, body } = await startCall(String(sos._id), sign(ownerId));

  assert.equal(status, 201);
  assert.equal(body.data.call.status, 'RINGING');
  assert.equal(await Call.countDocuments({ sosId: sos._id }), 2, 'the old call is untouched');
});

dbTest('the database refuses a second in-flight call for the same SOS', async () => {
  await Call.init();

  const ownerId = newId();
  const sosId = new mongoose.Types.ObjectId();
  const doc = (status) => ({
    sosId,
    userId: ownerId,
    roomName: 'emergency-call-' + new mongoose.Types.ObjectId().toString(),
    status,
  });

  await Call.create(doc('OUTGOING'));

  await assert.rejects(
    () => Call.create(doc('RINGING')),
    (err) => err.code === 11000,
    'the unique partial index rejects a second pending call'
  );

  // Terminal calls sit outside the partial index and are allowed to repeat.
  await Call.create(doc('ENDED'));
  await Call.create(doc('CANCELLED'));
});

dbTest('start succeeds even when Socket.IO was never initialized', async () => {
  assert.throws(() => getIO(), /Socket.IO has not been initialized/);

  const { ownerId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');

  const { status } = await startCall(String(sos._id), sign(ownerId));

  assert.equal(status, 201, 'notifications are best effort');
  assert.throws(() => getIO(), /Socket.IO has not been initialized/);
});

dbTest('the ringing call can be answered by its guardian and by nobody else', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const outsider = newId();
  await seedUser(outsider, 'Stranger');
  const sos = await seedSos(ownerId, 'ACTIVE');

  const started = await startCall(String(sos._id), sign(ownerId));

  assert.equal(started.status, 201);
  assert.equal(started.body.data.call.status, 'RINGING');
  const callId = started.body.data.call.id;

  // Ringing only means "waiting": no acceptance, no connection, no token.
  const stored = await Call.findById(callId).lean();
  assert.equal(stored.status, 'RINGING');
  assert.ok(stored.ringingAt);
  assert.equal(stored.connectedAt, null, 'media never started by ringing');
  assert.equal(stored.endedAt, null);

  const byOutsider = await post(`/api/v1/calls/${callId}/accept`, sign(outsider));
  assert.equal(byOutsider.status, 403, 'only the assigned guardian may answer');
  assert.equal(byOutsider.body.error.code, 'CALL_NOT_AUTHORIZED');
  assert.equal((await Call.findById(callId)).status, 'RINGING', 'a wrong answer changes nothing');

  const byGuardian = await post(`/api/v1/calls/${callId}/accept`, sign(guardianId));
  assert.equal(byGuardian.status, 200);
  assert.equal(byGuardian.body.data.call.status, 'ACCEPTED', 'the ringed call is answerable');
  assert.equal((await Call.findById(callId)).status, 'ACCEPTED');
});

// ---------------------------------------------------------------------------
// POST /api/v1/calls/end
// ---------------------------------------------------------------------------

test('rejects an unauthenticated end request', async () => {
  const { status, body } = await endCallReq(new mongoose.Types.ObjectId().toString(), null, 'USER_ENDED');

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects a missing callId with 400', async () => {
  const token = sign(newId());

  const { status, body } = await post('/api/v1/calls/end', token, { endReason: 'USER_ENDED' });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.callId');
});

test('rejects an invalid callId with 400', async () => {
  const token = sign(newId());

  const { status, body } = await endCallReq('not-an-id', token, 'USER_ENDED');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.callId');
});

test('rejects an invalid endReason with 400', async () => {
  const token = sign(newId());
  const callId = new mongoose.Types.ObjectId().toString();

  for (const endReason of ['hangup', 'HANGUP', 'USER_HUNG_UP', '', 42]) {
    const { status, body } = await post('/api/v1/calls/end', token, { callId, endReason });

    assert.equal(status, 400, JSON.stringify(endReason));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
});

dbTest('accepts every controlled end reason', async () => {
  const token = sign(newId());
  const callId = new mongoose.Types.ObjectId().toString();

  for (const endReason of [
    'USER_ENDED',
    'GUARDIAN_ENDED',
    'CALLER_ENDED',
    'TIMEOUT',
    'FAILED',
    'SOS_RESOLVED',
    'SYSTEM',
  ]) {
    const { status, body } = await post('/api/v1/calls/end', token, { callId, endReason });

    assert.equal(status, 404, endReason + ' passes validation and reaches the service');
    assert.equal(body.error.code, 'CALL_NOT_FOUND', endReason);
  }
});

dbTest('accepts an omitted or null end reason', async () => {
  const token = sign(newId());
  const callId = new mongoose.Types.ObjectId().toString();

  for (const payload of [{ callId }, { callId, endReason: null }]) {
    const { status, body } = await post('/api/v1/calls/end', token, payload);

    assert.equal(status, 404, JSON.stringify(payload));
    assert.equal(body.error.code, 'CALL_NOT_FOUND');
  }
});

test('rejects client-supplied outcome fields on end', async () => {
  const token = sign(newId());
  const callId = new mongoose.Types.ObjectId().toString();

  for (const payload of [
    { callId, userId: newId() },
    { callId, guardianUserId: newId() },
    { callId, sosId: new mongoose.Types.ObjectId().toString() },
    { callId, status: 'CONNECTED' },
    { callId, endedAt: '2030-01-01T00:00:00.000Z' },
    { callId, roomName: 'attacker-room' },
    { callId, participantIdentity: 'user:attacker' },
    { callId, type: 'SIP' },
    { callId, participants: [] },
    { callId, endedBy: newId() },
  ]) {
    const { status, body } = await post('/api/v1/calls/end', token, payload);

    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
});

dbTest('ends a CONNECTED call and returns the ended call', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');
  const call = await seedCall(ownerId, {
    sosId: sos._id,
    guardianUserId: guardianId,
    status: 'CONNECTED',
    connectedAt: new Date(Date.now() - 30000),
    participants: [
      { userId: ownerId, identity: 'user:' + ownerId, role: 'USER' },
      { userId: guardianId, identity: 'user:' + guardianId, role: 'GUARDIAN' },
    ],
  });

  const { status, body } = await endCallReq(String(call._id), sign(ownerId), 'USER_ENDED');

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const data = body.data.call;
  assert.deepEqual(
    Object.keys(data).sort(),
    ['endReason', 'endedAt', 'guardianUserId', 'id', 'sosId', 'status', 'type', 'userId'],
    'only the outcome fields of the spec are exposed'
  );
  assert.equal(data.id, String(call._id));
  assert.equal(data.status, 'ENDED');
  assert.equal(data.endReason, 'USER_ENDED');
  assert.equal(data.sosId, String(sos._id));
  assert.equal(data.userId, ownerId);
  assert.equal(data.guardianUserId, guardianId);
  assert.equal(data.type, 'BROWSER_TO_BROWSER');

  const now = Date.now();
  const endedAt = new Date(data.endedAt).getTime();
  assert.ok(endedAt <= now + 5000, 'the timestamp is not from the future');
  assert.ok(now - endedAt < 60000, 'the server generated a fresh timestamp');

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes('LIVEKIT_API_KEY'));
  assert.ok(!raw.includes('token'), 'no access token');
  assert.equal(data.roomName, undefined, 'connection details are not part of the outcome');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ENDED');
  assert.equal(stored.endReason, 'USER_ENDED');
  assert.ok(stored.endedAt instanceof Date, 'endedAt is stored as a date');
  assert.ok(
    stored.updatedAt.getTime() >= call.updatedAt.getTime(),
    'updatedAt is refreshed by the transition'
  );
  assert.equal(String(stored.sosId), String(sos._id), 'sosId is unchanged');
  assert.deepEqual(
    stored.participants.map((p) => [String(p.userId), p.identity, p.role]),
    [
      [ownerId, 'user:' + ownerId, 'USER'],
      [guardianId, 'user:' + guardianId, 'GUARDIAN'],
    ],
    'participants are unchanged'
  );
  assert.equal(stored.roomName, call.roomName, 'the room is untouched');
});

dbTest('lets the assigned guardian end the call', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedCall(ownerId, { guardianUserId: guardianId, status: 'RINGING' });

  const { status, body } = await endCallReq(String(call._id), sign(guardianId), 'GUARDIAN_ENDED');

  assert.equal(status, 200);
  assert.equal(body.data.call.status, 'ENDED');
  assert.equal(body.data.call.endReason, 'GUARDIAN_ENDED');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ENDED');
});

dbTest('refuses to let an unrelated user end the call', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const strangerId = newId();
  const call = await seedCall(ownerId, { guardianUserId: guardianId, status: 'CONNECTED' });

  const { status, body } = await endCallReq(String(call._id), sign(strangerId), 'USER_ENDED');

  assert.equal(status, 403);
  assert.equal(body.error.code, 'CALL_NOT_AUTHORIZED');
  assert.equal(body.data, undefined);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'CONNECTED', 'the call is untouched');
  assert.equal(stored.endedAt, null, 'nothing was written');
});

dbTest('returns 404 for a call that does not exist', async () => {
  const userId = newId();

  const { status, body } = await endCallReq(
    new mongoose.Types.ObjectId().toString(),
    sign(userId),
    'USER_ENDED'
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'CALL_NOT_FOUND');
});

dbTest('can end a call from every in-flight state', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();

  for (const callStatus of ['OUTGOING', 'RINGING', 'ACCEPTED', 'CONNECTED']) {
    const call = await seedCall(ownerId, { guardianUserId: guardianId, status: callStatus });

    const { status, body } = await endCallReq(String(call._id), sign(ownerId), 'SYSTEM');

    assert.equal(status, 200, callStatus);
    assert.equal(body.data.call.status, 'ENDED', callStatus);
    assert.equal(body.data.call.endReason, 'SYSTEM', callStatus);

    const stored = await Call.findById(call._id).lean();
    assert.equal(stored.status, 'ENDED', callStatus);
    assert.ok(stored.endedAt, callStatus);
  }
});

dbTest('an already ENDED call replays idempotently without a second write', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const originalEnd = new Date(Date.now() - 60000);
  const call = await seedCall(ownerId, {
    guardianUserId: guardianId,
    status: 'ENDED',
    endedAt: originalEnd,
    endReason: 'TIMEOUT',
  });

  const first = await endCallReq(String(call._id), sign(ownerId), 'USER_ENDED');

  assert.equal(first.status, 200, 'the replay is not an error');
  assert.equal(first.body.data.call.status, 'ENDED');
  assert.equal(first.body.data.call.endReason, 'TIMEOUT', 'the original outcome is preserved');
  assert.equal(
    new Date(first.body.data.call.endedAt).getTime(),
    originalEnd.getTime(),
    'the original endedAt is preserved'
  );

  const afterFirst = await Call.findById(call._id).lean();
  const second = await endCallReq(String(call._id), sign(guardianId), 'USER_ENDED');
  const afterSecond = await Call.findById(call._id).lean();

  assert.equal(second.status, 200);
  assert.equal(second.body.data.call.endReason, 'TIMEOUT');
  assert.equal(afterSecond.status, 'ENDED');
  assert.equal(
    afterSecond.updatedAt.getTime(),
    afterFirst.updatedAt.getTime(),
    'the replay performed no additional state change'
  );
});

dbTest('simultaneous end requests from both participants settle on one termination', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedCall(ownerId, {
    guardianUserId: guardianId,
    status: 'CONNECTED',
    connectedAt: new Date(Date.now() - 5000),
  });

  const [first, second] = await Promise.all([
    endCallReq(String(call._id), sign(ownerId), 'USER_ENDED'),
    endCallReq(String(call._id), sign(guardianId), 'GUARDIAN_ENDED'),
  ]);

  assert.equal(first.status, 200, 'the winner transitions');
  assert.equal(second.status, 200, 'the loser replays idempotently instead of failing');
  assert.equal(first.body.data.call.status, 'ENDED');
  assert.equal(second.body.data.call.status, 'ENDED');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ENDED');
  assert.ok(stored.endedAt, 'exactly one termination is recorded');
  assert.ok(
    ['USER_ENDED', 'GUARDIAN_ENDED'].includes(stored.endReason),
    'the winner’s reason survives: ' + stored.endReason
  );

  const firstEndedAt = new Date(first.body.data.call.endedAt).getTime();
  const secondEndedAt = new Date(second.body.data.call.endedAt).getTime();
  assert.equal(
    firstEndedAt,
    secondEndedAt,
    'both participants are shown the same single transition'
  );
  assert.equal(firstEndedAt, stored.endedAt.getTime(), 'the stored timestamp is the one reported');
  assert.equal(first.body.data.call.endReason, stored.endReason);
  assert.equal(second.body.data.call.endReason, stored.endReason);
});

dbTest('terminal states other than ENDED cannot be ended', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();

  for (const callStatus of ['FAILED', 'CANCELLED', 'REJECTED']) {
    const call = await seedCall(ownerId, { guardianUserId: guardianId, status: callStatus });

    const { status, body } = await endCallReq(String(call._id), sign(ownerId), 'USER_ENDED');

    assert.equal(status, 409, callStatus);
    assert.equal(body.error.code, 'CALL_ALREADY_TERMINAL', callStatus);

    const stored = await Call.findById(call._id).lean();
    assert.equal(stored.status, callStatus, callStatus + ' is preserved');
    assert.equal(stored.endedAt, null, callStatus + ' gains no endedAt');
    assert.equal(stored.endReason, null, callStatus + ' gains no endReason');
  }
});

dbTest('ending a call does not touch the SOS', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');
  const before = await SosEvent.findById(sos._id).lean();
  const call = await seedCall(ownerId, {
    sosId: sos._id,
    guardianUserId: guardianId,
    status: 'CONNECTED',
  });

  const { status } = await endCallReq(String(call._id), sign(guardianId), 'SOS_RESOLVED');

  assert.equal(status, 200);

  const after = await SosEvent.findById(sos._id).lean();
  assert.equal(after.status, 'ACTIVE', 'the SOS keeps its own state machine');
  assert.equal(after.resolvedAt, null, 'the SOS is not resolved by ending a call');
  assert.equal(after.escalation.currentLevel, before.escalation.currentLevel, 'no escalation change');
  assert.equal(
    after.updatedAt.getTime(),
    before.updatedAt.getTime(),
    'the SOS document is not written at all'
  );
});

dbTest('end succeeds even when Socket.IO was never initialized', async () => {
  assert.throws(() => getIO(), /Socket.IO has not been initialized/);

  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedCall(ownerId, { guardianUserId: guardianId, status: 'CONNECTED' });

  const { status, body } = await endCallReq(String(call._id), sign(ownerId), 'USER_ENDED');

  assert.equal(status, 200, 'notifications are best effort');
  assert.equal(body.data.call.status, 'ENDED');
  assert.throws(() => getIO(), /Socket.IO has not been initialized/);
});

dbTest('call token database failure is handled by the central error middleware', async () => {
  const ownerId = newId();
  const call = await seedCall(ownerId);

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await tokenFor(String(call._id), sign(ownerId));

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

dbTest('end call database failure is handled by the central error middleware', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedCall(ownerId, { guardianUserId: guardianId, status: 'CONNECTED' });

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await endCallReq(String(call._id), sign(ownerId), 'USER_ENDED');

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('MongoNotConnectedError'), 'no driver details leak');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/calls/:id/accept
// ---------------------------------------------------------------------------

const acceptCallReq = (callId, token, payload) => post(`/api/v1/calls/${callId}/accept`, token, payload);

const seedRingingCall = async (ownerId, guardianId, overrides = {}) =>
  seedCall(ownerId, { guardianUserId: guardianId, status: 'RINGING', ...overrides });

test('rejects an unauthenticated accept request', async () => {
  const { status, body } = await acceptCallReq(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid call id with 400', async () => {
  const token = sign(newId());

  const { status, body } = await acceptCallReq('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

test('rejects client-supplied accept fields', async () => {
  const token = sign(newId());
  const callId = new mongoose.Types.ObjectId().toString();

  for (const payload of [
    { status: 'ACCEPTED' },
    { status: 'CONNECTED' },
    { userId: newId() },
    { guardianUserId: newId() },
    { sosId: new mongoose.Types.ObjectId().toString() },
    { roomName: 'attacker-room' },
    { participantIdentity: 'user:attacker' },
    { type: 'SIP' },
    { participants: [] },
    { connectedAt: '2030-01-01T00:00:00.000Z' },
    { token: 'stolen' },
    { apiSecret: 'stolen-secret' },
  ]) {
    const { status, body } = await acceptCallReq(callId, token, payload);

    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(String(body.error.details[0].path).startsWith('body'), JSON.stringify(payload));
  }
});

dbTest('returns 404 for a call that does not exist', async () => {
  const userId = newId();

  const { status, body } = await acceptCallReq(
    new mongoose.Types.ObjectId().toString(),
    sign(userId)
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'CALL_NOT_FOUND');
  assert.equal(body.data, undefined);
});

dbTest('refuses a user who is not the assigned guardian', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const strangerId = newId();
  const call = await seedRingingCall(ownerId, guardianId);

  const { status, body } = await acceptCallReq(String(call._id), sign(strangerId));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'CALL_NOT_AUTHORIZED');
  assert.equal(body.data, undefined, 'no call details are returned');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'RINGING', 'the call is untouched');
  assert.equal(
    stored.updatedAt.getTime(),
    call.updatedAt.getTime(),
    'nothing was written'
  );
});

dbTest('refuses the SOS owner accepting their own call', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);

  const { status, body } = await acceptCallReq(String(call._id), sign(ownerId));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'CALL_NOT_AUTHORIZED');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'RINGING', 'the owner cannot answer their own call');
});

dbTest('the assigned guardian accepts a RINGING call', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');
  const call = await seedRingingCall(ownerId, guardianId, {
    sosId: sos._id,
    participants: [
      { userId: ownerId, identity: 'user:' + ownerId, role: 'USER' },
      { userId: guardianId, identity: 'user:' + guardianId, role: 'GUARDIAN' },
    ],
  });

  const { status, body } = await acceptCallReq(String(call._id), sign(guardianId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.message, 'Call accepted');

  const accepted = body.data.call;
  assert.deepEqual(
    Object.keys(accepted).sort(),
    ['createdAt', 'guardianUserId', 'id', 'roomName', 'sosId', 'status', 'type', 'userId'],
    'only the response fields of the spec are exposed'
  );
  assert.equal(accepted.id, String(call._id));
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal(accepted.type, 'BROWSER_TO_BROWSER');
  assert.equal(accepted.roomName, call.roomName);
  assert.equal(accepted.sosId, String(sos._id));
  assert.equal(accepted.userId, ownerId);
  assert.equal(accepted.guardianUserId, guardianId);

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes('LIVEKIT_API_KEY'));
  assert.ok(!raw.includes('serverUrl'), 'no provider url');
  assert.ok(!raw.includes('token'), 'acceptance never mints a token');
  assert.equal(body.data.token, undefined);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ACCEPTED');
  assert.equal(stored.connectedAt, null, 'connectivity is proven later by LiveKit');
  assert.equal(stored.endedAt, null, 'the call is not over');
  assert.equal(stored.endReason, null);
  assert.ok(stored.updatedAt.getTime() >= call.updatedAt.getTime(), 'updatedAt is refreshed');
  assert.equal(String(stored.sosId), String(sos._id), 'sosId is unchanged');
  assert.equal(stored.roomName, call.roomName, 'the room is untouched');
  assert.deepEqual(
    stored.participants.map((p) => [String(p.userId), p.identity, p.role]),
    [
      [ownerId, 'user:' + ownerId, 'USER'],
      [guardianId, 'user:' + guardianId, 'GUARDIAN'],
    ],
    'participants are unchanged'
  );

  const sosAfter = await SosEvent.findById(sos._id).lean();
  assert.equal(sosAfter.status, 'ACTIVE', 'the SOS keeps its own state machine');
  assert.equal(sosAfter.updatedAt.getTime(), sos.updatedAt.getTime(), 'the SOS is not written');
});

dbTest('refuses every state except RINGING with 409', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();

  for (const callStatus of [
    'CREATED',
    'OUTGOING',
    'ACCEPTED',
    'CONNECTED',
    'REJECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ]) {
    const call = await seedCall(ownerId, { guardianUserId: guardianId, status: callStatus });

    const { status, body } = await acceptCallReq(String(call._id), sign(guardianId));

    assert.equal(status, 409, callStatus);
    assert.equal(body.error.code, 'CALL_NOT_ACCEPTABLE', callStatus);
    assert.ok(body.error.message.includes(callStatus), 'the current status is reported');
    assert.equal(body.data, undefined);

    const stored = await Call.findById(call._id).lean();
    assert.equal(stored.status, callStatus, callStatus + ' is preserved');
    assert.equal(stored.connectedAt, null, callStatus + ' gains no connectedAt');
    assert.equal(stored.endedAt, null, callStatus + ' gains no endedAt');
  }
});

dbTest('two simultaneous accepts perform exactly one transition', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);
  const token = sign(guardianId);

  const [first, second] = await Promise.all([
    acceptCallReq(String(call._id), token),
    acceptCallReq(String(call._id), token),
  ]);

  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], 'exactly one request wins');

  const winner = first.status === 200 ? first : second;
  const loser = first.status === 200 ? second : first;

  assert.equal(winner.body.data.call.status, 'ACCEPTED');
  assert.equal(loser.body.error.code, 'CALL_NOT_ACCEPTABLE');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ACCEPTED', 'a single RINGING → ACCEPTED transition happened');
});

dbTest('accept succeeds even when Socket.IO was never initialized', async () => {
  assert.throws(() => getIO(), /Socket.IO has not been initialized/);

  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);

  const { status, body } = await acceptCallReq(String(call._id), sign(guardianId));

  assert.equal(status, 200, 'notifications are best effort');
  assert.equal(body.data.call.status, 'ACCEPTED');
  assert.throws(() => getIO(), /Socket.IO has not been initialized/);
});

dbTest('accept database failure is handled by the central error middleware', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await acceptCallReq(String(call._id), sign(guardianId));

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('MongoNotConnectedError'), 'no driver details leak');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/calls/:id/reject
// ---------------------------------------------------------------------------

const rejectCallReq = (callId, token, payload) => post(`/api/v1/calls/${callId}/reject`, token, payload);

test('rejects an unauthenticated reject request', async () => {
  const { status, body } = await rejectCallReq(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid call id with 400', async () => {
  const token = sign(newId());

  const { status, body } = await rejectCallReq('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

test('rejects client-supplied reject fields', async () => {
  const token = sign(newId());
  const callId = new mongoose.Types.ObjectId().toString();

  for (const payload of [
    { status: 'REJECTED' },
    { status: 'ACCEPTED' },
    { endReason: 'SYSTEM' },
    { userId: newId() },
    { guardianUserId: newId() },
    { sosId: new mongoose.Types.ObjectId().toString() },
    { roomName: 'attacker-room' },
    { participantIdentity: 'user:attacker' },
    { type: 'SIP' },
    { participants: [] },
    { endedAt: '2030-01-01T00:00:00.000Z' },
    { reason: 'busy' },
    { token: 'stolen' },
    { apiSecret: 'stolen-secret' },
  ]) {
    const { status, body } = await rejectCallReq(callId, token, payload);

    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.ok(String(body.error.details[0].path).startsWith('body'), JSON.stringify(payload));
  }
});

dbTest('returns 404 for a call that does not exist', async () => {
  const userId = newId();

  const { status, body } = await rejectCallReq(
    new mongoose.Types.ObjectId().toString(),
    sign(userId)
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'CALL_NOT_FOUND');
  assert.equal(body.data, undefined);
});

dbTest('refuses a user who is not the assigned guardian', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const strangerId = newId();
  const otherGuardian = newId();
  const call = await seedRingingCall(ownerId, guardianId);

  for (const unauthorized of [strangerId, otherGuardian]) {
    const { status, body } = await rejectCallReq(String(call._id), sign(unauthorized));

    assert.equal(status, 403, unauthorized);
    assert.equal(body.error.code, 'CALL_NOT_AUTHORIZED', unauthorized);
    assert.equal(body.data, undefined, 'no call details are returned');
  }

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'RINGING', 'the call is untouched');
  assert.equal(stored.endedAt, null, 'nothing was written');
  assert.equal(stored.updatedAt.getTime(), call.updatedAt.getTime(), 'no state change');
});

dbTest('refuses the SOS owner rejecting their own call', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);

  const { status, body } = await rejectCallReq(String(call._id), sign(ownerId));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'CALL_NOT_AUTHORIZED');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'RINGING', 'the owner cannot decline their own call');
});

dbTest('the assigned guardian rejects a RINGING call without touching the SOS', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');
  const before = await SosEvent.findById(sos._id).lean();
  const call = await seedRingingCall(ownerId, guardianId, {
    sosId: sos._id,
    participants: [
      { userId: ownerId, identity: 'user:' + ownerId, role: 'USER' },
      { userId: guardianId, identity: 'user:' + guardianId, role: 'GUARDIAN' },
    ],
  });

  const { status, body } = await rejectCallReq(String(call._id), sign(guardianId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.message, 'Call rejected');

  const rejected = body.data.call;
  assert.deepEqual(
    Object.keys(rejected).sort(),
    ['endReason', 'endedAt', 'guardianUserId', 'id', 'sosId', 'status', 'type', 'userId'],
    'only the outcome fields of the spec are exposed'
  );
  assert.equal(rejected.id, String(call._id));
  assert.equal(rejected.status, 'REJECTED');
  assert.equal(rejected.endReason, 'GUARDIAN_REJECTED');
  assert.ok(rejected.endedAt, 'the decline time is returned');
  assert.equal(rejected.sosId, String(sos._id));
  assert.equal(rejected.userId, ownerId);
  assert.equal(rejected.guardianUserId, guardianId);
  assert.equal(rejected.roomName, undefined, 'no connection details are returned');

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes('LIVEKIT_API_KEY'));
  assert.ok(!raw.includes('serverUrl'), 'no provider url');
  assert.ok(!raw.includes('token'), 'rejection never touches a token');
  assert.equal(body.data.token, undefined);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'REJECTED');
  assert.equal(stored.endReason, 'GUARDIAN_REJECTED');
  assert.ok(stored.endedAt instanceof Date, 'endedAt is stored as a date');
  assert.equal(stored.connectedAt, null, 'media never started');
  assert.ok(stored.updatedAt.getTime() >= call.updatedAt.getTime(), 'updatedAt is refreshed');
  assert.equal(String(stored.sosId), String(sos._id), 'sosId is unchanged');
  assert.equal(stored.roomName, call.roomName, 'the room is untouched');
  assert.deepEqual(
    stored.participants.map((p) => [String(p.userId), p.identity, p.role]),
    [
      [ownerId, 'user:' + ownerId, 'USER'],
      [guardianId, 'user:' + guardianId, 'GUARDIAN'],
    ],
    'participants are unchanged'
  );

  const after = await SosEvent.findById(sos._id).lean();
  assert.equal(after.status, 'ACTIVE', 'the emergency is not resolved by declining a call');
  assert.equal(after.resolvedAt, null, 'the SOS is not resolved');
  assert.equal(after.escalation.currentLevel, before.escalation.currentLevel, 'no escalation change');
  assert.equal(
    after.updatedAt.getTime(),
    before.updatedAt.getTime(),
    'the SOS document is not written at all'
  );
});

dbTest('refuses every state except RINGING with 409', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();

  for (const callStatus of [
    'CREATED',
    'OUTGOING',
    'ACCEPTED',
    'CONNECTED',
    'REJECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ]) {
    const call = await seedCall(ownerId, { guardianUserId: guardianId, status: callStatus });

    const { status, body } = await rejectCallReq(String(call._id), sign(guardianId));

    assert.equal(status, 409, callStatus);
    assert.equal(body.error.code, 'CALL_NOT_REJECTABLE', callStatus);
    assert.ok(body.error.message.includes(callStatus), 'the current status is reported');
    assert.equal(body.data, undefined);

    const stored = await Call.findById(call._id).lean();
    assert.equal(stored.status, callStatus, callStatus + ' is preserved');
    assert.equal(stored.endedAt, null, callStatus + ' gains no endedAt');
    assert.equal(stored.endReason, null, callStatus + ' gains no endReason');
  }
});

dbTest('two simultaneous rejections perform exactly one transition', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);
  const token = sign(guardianId);

  const [first, second] = await Promise.all([
    rejectCallReq(String(call._id), token),
    rejectCallReq(String(call._id), token),
  ]);

  const statuses = [first.status, second.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], 'exactly one request wins');

  const winner = first.status === 200 ? first : second;
  const loser = first.status === 200 ? second : first;

  assert.equal(winner.body.data.call.status, 'REJECTED');
  assert.equal(loser.body.error.code, 'CALL_NOT_REJECTABLE');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'REJECTED', 'a single RINGING → REJECTED transition happened');
  assert.equal(stored.endReason, 'GUARDIAN_REJECTED', 'the reason is written exactly once');
});

dbTest('an accept and a reject racing each other produce exactly one transition', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const sos = await seedSos(ownerId, 'ACTIVE');
  const call = await seedRingingCall(ownerId, guardianId, { sosId: sos._id });
  const token = sign(guardianId);

  const [accepted, rejected] = await Promise.all([
    acceptCallReq(String(call._id), token),
    rejectCallReq(String(call._id), token),
  ]);

  const statuses = [accepted.status, rejected.status].sort((a, b) => a - b);
  assert.deepEqual(statuses, [200, 409], 'exactly one request wins');

  const stored = await Call.findById(call._id).lean();
  assert.ok(
    ['ACCEPTED', 'REJECTED'].includes(stored.status),
    'the final state is one of the two, never an intermediate or an overwrite'
  );

  if (stored.status === 'ACCEPTED') {
    assert.equal(accepted.status, 200);
    assert.equal(rejected.status, 409);
    assert.equal(rejected.body.error.code, 'CALL_NOT_REJECTABLE');
    assert.equal(stored.endedAt, null, 'the loser wrote nothing');
    assert.equal(stored.endReason, null);
  } else {
    assert.equal(rejected.status, 200);
    assert.equal(accepted.status, 409);
    assert.equal(accepted.body.error.code, 'CALL_NOT_ACCEPTABLE');
    assert.equal(stored.endReason, 'GUARDIAN_REJECTED');
  }

  const sosAfter = await SosEvent.findById(sos._id).lean();
  assert.equal(sosAfter.status, 'ACTIVE', 'neither outcome touches the SOS state machine');
});

dbTest('a rejected call cannot be accepted or ended afterwards', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);

  const rejected = await rejectCallReq(String(call._id), sign(guardianId));
  assert.equal(rejected.status, 200);

  const accepted = await acceptCallReq(String(call._id), sign(guardianId));
  assert.equal(accepted.status, 409, 'REJECTED is terminal');
  assert.equal(accepted.body.error.code, 'CALL_NOT_ACCEPTABLE');

  const ended = await endCallReq(String(call._id), sign(ownerId), 'USER_ENDED');
  assert.equal(ended.status, 409, 'a rejected call cannot be ended again');
  assert.equal(ended.body.error.code, 'CALL_ALREADY_TERMINAL');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'REJECTED', 'no later transition overwrites the rejection');
});

dbTest('reject succeeds even when Socket.IO was never initialized', async () => {
  assert.throws(() => getIO(), /Socket.IO has not been initialized/);

  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);

  const { status, body } = await rejectCallReq(String(call._id), sign(guardianId));

  assert.equal(status, 200, 'notifications are best effort');
  assert.equal(body.data.call.status, 'REJECTED');
  assert.throws(() => getIO(), /Socket.IO has not been initialized/);
});

dbTest('reject database failure is handled by the central error middleware', async () => {
  const { ownerId, guardianId } = await seedCallerWithGuardian();
  const call = await seedRingingCall(ownerId, guardianId);

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await rejectCallReq(String(call._id), sign(guardianId));

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('MongoNotConnectedError'), 'no driver details leak');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});
