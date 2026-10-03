import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Call } from '../src/modules/calling/call.model.js';
import { SosEvent } from '../src/modules/sos/sos.model.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const createdCallIds = [];
const createdSosIds = [];
const createdUserIds = [];

const newId = () => {
  const id = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(id);
  return id;
};

let server;
let port;

const webhookUrl = () => `http://127.0.0.1:${port}/api/v1/webhooks/livekit`;

/** Signs a body exactly the way LiveKit Cloud does: HS256 over its sha256. */
const signWebhook = (raw, apiSecret = env.livekit.apiSecret) => {
  const sha256 = crypto.createHash('sha256').update(raw).digest('base64');
  return jwt.sign({ iss: env.livekit.apiKey, sub: 'wh_test', sha256 }, apiSecret, {
    algorithm: 'HS256',
    expiresIn: '5m',
  });
};

const postWebhook = async (payload, options = {}) => {
  const raw = options.raw ?? (typeof payload === 'string' ? payload : JSON.stringify(payload));
  const token = options.token === null ? null : (options.token ?? signWebhook(raw, options.apiSecret));

  const headers = { 'content-type': 'application/json' };

  if (token) {
    const headerName = options.header ?? 'authorization';
    const bearer = headerName.toLowerCase() === 'authorization' && options.format !== 'bare';
    headers[headerName] = bearer ? `Bearer ${token}` : token;
  }

  const res = await fetch(webhookUrl(), { method: 'POST', headers, body: raw });

  return { status: res.status, body: await res.json() };
};

const seedCall = async (ownerId, overrides = {}) => {
  const call = await Call.create({
    sosId: new mongoose.Types.ObjectId(),
    userId: ownerId,
    roomName: 'emergency-call-' + new mongoose.Types.ObjectId().toString(),
    status: 'OUTGOING',
    ...overrides,
  });
  createdCallIds.push(String(call._id));
  return call;
};

const seedSos = async (userId, status = 'ACTIVE') => {
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

const participantsOf = (ownerId, guardianId) => [
  { userId: ownerId, identity: 'user:' + ownerId, role: 'USER' },
  { userId: guardianId, identity: 'user:' + guardianId, role: 'GUARDIAN' },
];

const roomEvent = (type, roomName, extra = {}) => ({
  id: 'evt_' + new mongoose.Types.ObjectId().toString(),
  event: type,
  createdAt: Math.floor(Date.now() / 1000),
  room: { name: roomName, sid: 'RM_' + new mongoose.Types.ObjectId().toString().slice(0, 8) },
  ...extra,
});

const participantEvent = (type, roomName, identity) => ({
  ...roomEvent(type, roomName),
  participant: { identity, sid: 'PA_' + new mongoose.Types.ObjectId().toString().slice(0, 8), state: 'ACTIVE' },
});

const seedActivePair = async (callStatus = 'ACCEPTED') => {
  const ownerId = newId();
  const guardianId = newId();
  const sos = await seedSos(ownerId);
  const call = await seedCall(ownerId, {
    sosId: sos._id,
    guardianUserId: guardianId,
    status: callStatus,
    participants: participantsOf(ownerId, guardianId),
  });

  return { ownerId, guardianId, sos, call };
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
    const ids = createdUserIds.map((id) => new mongoose.Types.ObjectId(id));

    await Call.deleteMany({ _id: { $in: createdCallIds } });
    await Call.deleteMany({ userId: { $in: ids } });
    await SosEvent.deleteMany({ _id: { $in: createdSosIds } });
    await disconnectDB();
  }

  if (server) await new Promise((resolve) => server.close(resolve));
});

// ---------------------------------------------------------------------------
// Authentication — the caller is LiveKit, not a logged-in user
// ---------------------------------------------------------------------------

test('rejects a webhook without a signature', async () => {
  const { status, body } = await postWebhook({ event: 'room_started', id: 'evt_1' }, { token: null });

  assert.equal(status, 401);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'WEBHOOK_UNAUTHORIZED');
  assert.equal(body.data, undefined);
});

test('rejects a webhook signed with the wrong secret', async () => {
  const raw = JSON.stringify({ event: 'room_started', id: 'evt_1' });

  const { status, body } = await postWebhook(raw, { raw, apiSecret: 'not-the-livekit-secret-0000' });

  assert.equal(status, 401);
  assert.equal(body.error.code, 'WEBHOOK_UNAUTHORIZED');
});

dbTest('rejects a tampered body without touching the database', async () => {
  const { ownerId, call } = await seedActivePair('CONNECTED');
  const signed = JSON.stringify(roomEvent('room_finished', call.roomName));
  const tampered = JSON.stringify(roomEvent('participant_left', call.roomName));

  const { status } = await postWebhook(signed, { raw: tampered, token: signWebhook(signed) });

  assert.equal(status, 401, 'the signature no longer matches the bytes');

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'CONNECTED', 'an unverified webhook can never modify state');
  assert.equal(stored.endedAt, null);
  assert.equal(String(stored.userId), ownerId);
});

test('rejects an authenticated payload that is not a webhook event', async () => {
  const notJson = await postWebhook('definitely-not-json');
  assert.equal(notJson.status, 400);
  assert.equal(notJson.body.error.code, 'WEBHOOK_MALFORMED');

  const missingType = await postWebhook({ id: 'evt_1', event: '' });
  assert.equal(missingType.status, 400);
  assert.equal(missingType.body.error.code, 'WEBHOOK_MALFORMED');
});

dbTest('accepts the webhook without any user JWT', async () => {
  const raw = JSON.stringify(roomEvent('room_started', 'emergency-call-000000000000000000000000'));

  const { status, body } = await postWebhook(raw, { raw });

  assert.equal(status, 200, 'only the LiveKit signature is required');
  assert.equal(body.success, true);
});

dbTest('accepts the signature with or without the Bearer prefix', async () => {
  const raw = JSON.stringify(roomEvent('room_started', 'emergency-call-000000000000000000000000'));
  const token = signWebhook(raw);

  const bearer = await postWebhook(raw, { raw, token });
  assert.equal(bearer.status, 200);

  const bare = await postWebhook(raw, { raw, token, format: 'bare' });
  assert.equal(bare.status, 200);

  const authorizeHeader = await postWebhook(raw, { raw, token, header: 'Authorize' });
  assert.equal(authorizeHeader.status, 200);
});

// ---------------------------------------------------------------------------
// Room mapping
// ---------------------------------------------------------------------------

dbTest('acknowledges an unknown room without creating a call', async () => {
  const roomName = 'emergency-call-madeuproom-' + Date.now();

  const { status, body } = await postWebhook(roomEvent('room_started', roomName));

  assert.equal(status, 200, 'a valid webhook is always acknowledged');
  assert.equal(body.success, true);
  assert.equal(body.data, null, 'no internal details leak');

  assert.equal(
    await Call.countDocuments({ roomName }),
    0,
    'no call document is created for the unknown room'
  );
});

dbTest('room_started never connects the application call', async () => {
  const { ownerId, call } = await seedActivePair('ACCEPTED');

  const { status } = await postWebhook(roomEvent('room_started', call.roomName));

  assert.equal(status, 200);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ACCEPTED', 'a room alone proves nothing');
  assert.equal(stored.connectedAt, null);
  assert.equal(String(stored.userId), ownerId);
});

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

dbTest('participant_joined connects the call once both participants arrive', async () => {
  const { ownerId, guardianId, call } = await seedActivePair('ACCEPTED');

  const first = await postWebhook(
    participantEvent('participant_joined', call.roomName, 'user:' + ownerId)
  );
  assert.equal(first.status, 200);

  let stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ACCEPTED', 'one participant is not a connection');
  assert.ok(stored.participants[0].joinedAt, 'presence is recorded');

  const second = await postWebhook(
    participantEvent('participant_joined', call.roomName, 'user:' + guardianId)
  );
  assert.equal(second.status, 200);

  stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'CONNECTED');
  assert.ok(stored.connectedAt instanceof Date, 'connectedAt is generated by the server');
  assert.equal(String(stored.sosId), call.sosId.toString(), 'sosId is untouched');
  assert.deepEqual(
    stored.participants.map((p) => [String(p.userId), p.identity, p.role]),
    [
      [ownerId, 'user:' + ownerId, 'USER'],
      [guardianId, 'user:' + guardianId, 'GUARDIAN'],
    ],
    'participants are untouched'
  );

  const connectedAt = stored.connectedAt.getTime();

  // The same webhook delivered twice must not move anything.
  const replay = await postWebhook(
    participantEvent('participant_joined', call.roomName, 'user:' + guardianId)
  );
  assert.equal(replay.status, 200);

  stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'CONNECTED');
  assert.equal(stored.connectedAt.getTime(), connectedAt, 'connectedAt is not overwritten');
});

dbTest('a delayed participant_joined cannot resurrect a terminal call', async () => {
  for (const status of ['ENDED', 'REJECTED', 'CANCELLED', 'FAILED']) {
    const { call } = await seedActivePair(status);

    const { body } = await postWebhook(
      participantEvent('participant_joined', call.roomName, 'user:' + call.userId)
    );
    assert.equal(body.success, true, status + ' is still acknowledged');

    const stored = await Call.findById(call._id).lean();
    assert.equal(stored.status, status, status + ' is preserved');
    assert.equal(stored.connectedAt, null, status);
  }
});

dbTest('an unknown participant cannot change application state', async () => {
  const { call } = await seedActivePair('ACCEPTED');

  const { status } = await postWebhook(
    participantEvent('participant_joined', call.roomName, 'user:' + newId())
  );

  assert.equal(status, 200);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ACCEPTED', 'a stranger never connects the call');
  assert.ok(stored.participants.every((p) => !p.joinedAt), 'presence is not recorded');
});

dbTest('participant_left ends the call and leaves the SOS alone', async () => {
  const { ownerId, guardianId, sos, call } = await seedActivePair('CONNECTED');
  const sosBefore = await SosEvent.findById(sos._id).lean();

  const { status, body } = await postWebhook(
    participantEvent('participant_left', call.roomName, 'user:' + guardianId)
  );

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ENDED');
  assert.equal(stored.endReason, 'PARTICIPANT_LEFT');
  assert.ok(stored.endedAt instanceof Date, 'endedAt is server generated');
  assert.equal(String(stored.sosId), String(sos._id), 'the call still points at its SOS');
  assert.deepEqual(
    stored.participants.map((p) => String(p.userId)),
    [ownerId, guardianId],
    'participants are unchanged'
  );

  const sosAfter = await SosEvent.findById(sos._id).lean();
  assert.equal(sosAfter.status, 'ACTIVE', 'the SOS keeps its own state machine');
  assert.equal(sosAfter.resolvedAt, null, 'the SOS is not resolved by a call ending');
  assert.equal(
    sosAfter.updatedAt.getTime(),
    sosBefore.updatedAt.getTime(),
    'the SOS document is not written at all'
  );
});

dbTest('a duplicate participant_left does not move the timestamps', async () => {
  const { guardianId, call } = await seedActivePair('CONNECTED');
  const event = participantEvent('participant_left', call.roomName, 'user:' + guardianId);

  const first = await postWebhook(event);
  assert.equal(first.status, 200);

  const afterFirst = await Call.findById(call._id).lean();
  assert.equal(afterFirst.status, 'ENDED');

  const second = await postWebhook(event);
  assert.equal(second.status, 200, 'the retry is acknowledged');

  const afterSecond = await Call.findById(call._id).lean();
  assert.equal(afterSecond.status, 'ENDED');
  assert.equal(afterSecond.endedAt.getTime(), afterFirst.endedAt.getTime(), 'endedAt is stable');
  assert.equal(afterSecond.updatedAt.getTime(), afterFirst.updatedAt.getTime(), 'no second write');
});

dbTest('room_finished finalizes an in-flight call', async () => {
  const { call } = await seedActivePair('RINGING');

  const { status } = await postWebhook(roomEvent('room_finished', call.roomName));

  assert.equal(status, 200);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ENDED');
  assert.equal(stored.endReason, 'ROOM_FINISHED');
  assert.ok(stored.endedAt instanceof Date);
});

dbTest('room_finished never overwrites an already ended call', async () => {
  const { call } = await seedActivePair('ENDED');
  await Call.updateOne(
    { _id: call._id },
    { $set: { endedAt: new Date('2026-01-01T00:00:00.000Z'), endReason: 'USER_ENDED' } }
  );

  const { status } = await postWebhook(roomEvent('room_finished', call.roomName));

  assert.equal(status, 200);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'ENDED');
  assert.equal(stored.endReason, 'USER_ENDED', 'the original outcome survives');
  assert.equal(stored.endedAt.getTime(), new Date('2026-01-01T00:00:00.000Z').getTime());
});

dbTest('participant_connection_aborted marks the call FAILED', async () => {
  const { ownerId, call } = await seedActivePair('RINGING');

  const { status } = await postWebhook(
    participantEvent('participant_connection_aborted', call.roomName, 'user:' + ownerId)
  );

  assert.equal(status, 200);

  const stored = await Call.findById(call._id).lean();
  assert.equal(stored.status, 'FAILED');
  assert.equal(stored.endReason, 'FAILED');
  assert.ok(stored.endedAt instanceof Date);
});

// ---------------------------------------------------------------------------
// Security
// ---------------------------------------------------------------------------

dbTest('the webhook response never exposes LiveKit credentials', async () => {
  const { call } = await seedActivePair('ACCEPTED');

  const { status, body } = await postWebhook(roomEvent('room_started', call.roomName));

  assert.equal(status, 200);

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('apiSecret'), 'no API secret');
  assert.ok(!raw.includes('LIVEKIT_API_SECRET'));
  assert.ok(!raw.includes(env.livekit.apiSecret), 'the configured secret never leaks');
  assert.ok(!raw.includes('token'), 'no access token');
  assert.ok(!raw.includes('jwt'));
});
