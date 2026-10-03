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
import { escalateToPolice } from '../src/modules/sos/escalation.service.js';
import { SOS_EVENT, SOS_LIFECYCLE_EVENT } from '../src/modules/sos/sos.events.js';
import { getIO } from '../src/sockets/index.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0d1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0d2';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0d3';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0d4';

const RESPONDER_1 = 'responder-001';
const RESPONDER_2 = 'responder-002';

/** The prototype station — asserted as literals, never read from the source. */
const STATION = Object.freeze({
  id: 'police-001',
  name: 'Prototype Police Station',
  phone: '1000000000',
});

// ---------- unit fixtures (no database) ----------

const guardianLevel = (overrides = {}) => ({
  type: 'GUARDIAN',
  status: 'TIMEOUT',
  targetId: GUARDIAN_ID,
  notifiedAt: new Date('2026-09-30T10:00:00.000Z'),
  respondedAt: null,
  expiresAt: new Date('2026-09-30T10:01:00.000Z'),
  ...overrides,
});

const responderLevel = (overrides = {}) => ({
  type: 'NEARBY_RESPONDER',
  status: 'TIMEOUT',
  targetId: null,
  notifiedResponders: [RESPONDER_1, RESPONDER_2],
  notifiedAt: new Date('2026-09-30T10:01:00.000Z'),
  respondedAt: null,
  expiresAt: new Date('2026-09-30T10:02:00.000Z'),
  ...overrides,
});

const policeLevel = (overrides = {}) => ({
  type: 'POLICE',
  status: 'NOTIFIED',
  targetId: STATION.id,
  policeStation: { ...STATION },
  source: 'PROTOTYPE_HARDCODED',
  notifiedAt: new Date('2026-09-30T10:02:00.000Z'),
  escalatedAt: new Date('2026-09-30T10:02:00.000Z'),
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
  location: { lat: 19.31, lng: 84.79 },
  escalation: { currentLevel, levels },
});

/** Post-escalation document: three levels, SOS status untouched. */
const escalatedDoc = (overrides = {}) =>
  sosDoc({
    levels: [guardianLevel(), responderLevel(), policeLevel()],
    currentLevel: 2,
    ...overrides,
  });

/**
 * Sequence fake: `finds` feeds successive findById calls (last entry repeats);
 * `escalateResult: null` simulates a lost atomic race and `escalateError`
 * simulates a failed write. Once a write succeeds the written document
 * becomes the default read result, exactly like the database would return it.
 */
const makeRepository = (options = {}) => {
  const { finds = [], sequence = [] } = options;
  const calls = { find: [], escalate: [], lastDoc: null };
  let cursor = 0;
  let written = null;

  return {
    calls,
    sequence,
    findById: async (sosId) => {
      calls.find.push(sosId);

      if (finds.length) {
        const index = Math.min(cursor, finds.length - 1);
        cursor += 1;
        if (finds[index] !== undefined) return finds[index];
      }

      return written ?? sosDoc();
    },
    escalateToPolice: async (args) => {
      calls.escalate.push(args);
      sequence.push('write');

      if (options.escalateError) throw options.escalateError;
      if (options.escalateResult !== undefined) return options.escalateResult;

      const base = finds[0] ?? written ?? sosDoc();
      written = {
        ...base,
        escalation: { currentLevel: 2, levels: [...base.escalation.levels, args.level] },
      };
      calls.lastDoc = written;
      return written;
    },
  };
};

const makeEmit = (sequence = []) => {
  const calls = [];
  return {
    calls,
    fn: async (userId, event, payload) => {
      calls.push({ userId, event, payload });
      sequence.push('emit');
    },
  };
};

const police = (overrides = {}) =>
  escalateToPolice({
    sosId: SOS_ID,
    userId: OWNER_ID,
    emit: async () => {},
    ...overrides,
  });

// ---------- unit: success path ----------

test('police escalation: write the level, then emit the station event', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence });
  const emit = makeEmit(sequence);

  const result = await police({ repository, emit: emit.fn });

  assert.deepEqual(Object.keys(result).sort(), [
    'escalatedAt',
    'level',
    'policeStation',
    'sosId',
    'status',
  ]);
  assert.equal(result.sosId, SOS_ID);
  assert.equal(result.level, 'POLICE');
  assert.equal(result.status, 'NOTIFIED');
  assert.deepEqual(result.policeStation, STATION);
  assert.ok(result.escalatedAt instanceof Date);

  assert.deepEqual(
    sequence,
    ['write', 'emit', 'emit'],
    '§17: database first, then lifecycle escalating, then the station event'
  );

  assert.equal(repository.calls.find.length, 2, 'read, write, then confirm before notifying');

  const write = repository.calls.escalate[0];
  assert.equal(write.sosId, SOS_ID);
  assert.equal(write.userId, OWNER_ID, 'write scoped to the SOS owner');
  const level = write.level;
  assert.equal(level.type, 'POLICE');
  assert.equal(level.status, 'NOTIFIED');
  assert.equal(level.targetId, STATION.id);
  assert.deepEqual(level.policeStation, STATION, 'server-side hardcoded station only');
  assert.equal(level.source, 'PROTOTYPE_HARDCODED', '§4: clearly prototype data');
  assert.ok(level.escalatedAt instanceof Date);
  assert.equal(level.notifiedAt.getTime(), level.escalatedAt.getTime());
  assert.equal(level.respondedAt, null, 'no police acknowledgement is faked');
  assert.equal(level.expiresAt, null, 'the police level arms no timer');

  assert.equal(emit.calls.length, 2, 'lifecycle stage-move event + one specific station event');
  const lifecycle = emit.calls[0];
  assert.equal(lifecycle.userId, OWNER_ID, "the SOS owner's private room only");
  assert.equal(lifecycle.event, SOS_LIFECYCLE_EVENT.ESCALATING);
  assert.equal(lifecycle.event, 'sos:escalating');
  assert.deepEqual(
    Object.keys(lifecycle.payload).sort(),
    ['currentLevel', 'escalatedAt', 'previousLevel', 'reason', 'sosId', 'status']
  );
  assert.equal(lifecycle.payload.status, 'ESCALATING');
  assert.equal(lifecycle.payload.currentLevel, 'POLICE');
  assert.equal(lifecycle.payload.previousLevel, 'NEARBY_RESPONDER');
  assert.equal(lifecycle.payload.reason, 'RESPONDER_TIMEOUT');
  assert.equal(lifecycle.payload.escalatedAt, new Date(lifecycle.payload.escalatedAt).toISOString());

  const { userId: recipient, event, payload } = emit.calls[1];
  assert.equal(recipient, OWNER_ID, "the SOS owner's private room only");
  assert.equal(event, SOS_EVENT.POLICE_ESCALATED);
  assert.equal(event, 'sos:police:escalated');

  assert.deepEqual(Object.keys(payload).sort(), [
    'escalatedAt',
    'level',
    'policeStation',
    'sosId',
    'status',
  ]);
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.level, 'POLICE');
  assert.equal(payload.status, 'NOTIFIED');
  assert.deepEqual(payload.policeStation, STATION);
  assert.equal(payload.escalatedAt, new Date(payload.escalatedAt).toISOString());

  const storedDoc = repository.calls.lastDoc;
  assert.equal(storedDoc.escalation.currentLevel, 2, 'currentLevel = POLICE index');
  assert.deepEqual(
    storedDoc.escalation.levels.map((lvl) => lvl.type),
    ['GUARDIAN', 'NEARBY_RESPONDER', 'POLICE']
  );
  assert.equal(storedDoc.escalation.levels[2].status, 'NOTIFIED');
  assert.equal(storedDoc.escalation.levels[0].status, 'TIMEOUT', 'history untouched');
  assert.equal(storedDoc.escalation.levels[1].status, 'TIMEOUT', 'history untouched');
  assert.equal(storedDoc.status, 'ACTIVE', '§9: the SOS status is never changed here');
  assert.notEqual(storedDoc.status, 'RESOLVED');
  assert.equal(storedDoc.resolvedAt ?? null, null, '§9: never auto-resolved');
  assert.ok(
    !JSON.stringify(storedDoc.escalation.levels[2]).toLowerCase().includes('acknowledgedby'),
    'no fake acknowledgement field'
  );
});

// ---------- unit: authorization ----------

test('only the owner may escalate their SOS to police', async () => {
  const repository = makeRepository({ finds: [sosDoc()] });
  const emit = makeEmit();

  await assert.rejects(
    police({ userId: STRANGER_ID, repository, emit: emit.fn }),
    (err) => err.statusCode === 403 && err.code === 'SOS_NOT_AUTHORIZED'
  );

  assert.equal(repository.calls.escalate.length, 0, 'nothing is written');
  assert.equal(emit.calls.length, 0, 'nobody is notified');
});

test('a missing SOS is 404 and nothing is written', async () => {
  const repository = makeRepository({ finds: [null] });
  const emit = makeEmit();

  await assert.rejects(
    police({ repository, emit: emit.fn }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );

  assert.equal(repository.calls.escalate.length, 0);
  assert.equal(emit.calls.length, 0);
});

// ---------- unit: SOS and escalation state gates ----------

test('a SOS that is no longer active cannot be escalated', async () => {
  for (const status of ['CANCELLED', 'RESOLVED', 'VERIFYING']) {
    const repository = makeRepository({ finds: [sosDoc({ status })] });
    const emit = makeEmit();

    await assert.rejects(
      police({ repository, emit: emit.fn }),
      (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACTIVE',
      status
    );
    assert.equal(repository.calls.escalate.length, 0, status);
    assert.equal(emit.calls.length, 0, status);
  }

  const acknowledged = makeRepository({ finds: [sosDoc({ status: 'ACKNOWLEDGED' })] });
  await assert.rejects(
    police({ repository: acknowledged }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_ACKNOWLEDGED'
  );
  assert.equal(acknowledged.calls.escalate.length, 0);
});

test('police escalation is refused until the previous levels have timed out', async () => {
  const noLevels = makeRepository({ finds: [sosDoc({ levels: [], currentLevel: 0 })] });
  await assert.rejects(
    police({ repository: noLevels }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_GUARDIAN_NOT_TIMED_OUT'
  );
  assert.equal(noLevels.calls.escalate.length, 0, 'an unescalated SOS never jumps to police');

  const guardianPending = makeRepository({
    finds: [sosDoc({ levels: [guardianLevel({ status: 'PENDING' }), responderLevel()], currentLevel: 1 })],
  });
  await assert.rejects(
    police({ repository: guardianPending }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_GUARDIAN_NOT_TIMED_OUT'
  );
  assert.equal(guardianPending.calls.escalate.length, 0);

  const guardianAcked = makeRepository({
    finds: [sosDoc({ levels: [guardianLevel({ status: 'ACKNOWLEDGED' }), responderLevel()], currentLevel: 1 })],
  });
  await assert.rejects(
    police({ repository: guardianAcked }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_ACKNOWLEDGED'
  );

  const responderMissing = makeRepository({
    finds: [sosDoc({ levels: [guardianLevel()], currentLevel: 0 })],
  });
  await assert.rejects(
    police({ repository: responderMissing }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_POLICE_NOT_ALLOWED',
    'the responder stage must run first'
  );
  assert.equal(responderMissing.calls.escalate.length, 0);

  const responderPending = makeRepository({
    finds: [sosDoc({ levels: [guardianLevel(), responderLevel({ status: 'PENDING' })], currentLevel: 1 })],
  });
  await assert.rejects(
    police({ repository: responderPending }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_POLICE_NOT_ALLOWED'
  );
  assert.equal(responderPending.calls.escalate.length, 0, 'responders are still being waited on');

  const responderAcked = makeRepository({
    finds: [
      sosDoc({ levels: [guardianLevel(), responderLevel({ status: 'ACKNOWLEDGED', targetId: RESPONDER_1 })], currentLevel: 1 }),
    ],
  });
  await assert.rejects(
    police({ repository: responderAcked }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_ACKNOWLEDGED'
  );
  assert.equal(responderAcked.calls.escalate.length, 0);
});

// ---------- unit: idempotency, races and failures ----------

test('a duplicate police escalation replays the existing level', async () => {
  const repository = makeRepository({ finds: [escalatedDoc()] });
  const emit = makeEmit();

  const result = await police({ repository, emit: emit.fn });

  assert.deepEqual(Object.keys(result).sort(), [
    'escalatedAt',
    'level',
    'policeStation',
    'sosId',
    'status',
  ]);
  assert.equal(result.level, 'POLICE');
  assert.equal(result.status, 'NOTIFIED');
  assert.deepEqual(result.policeStation, STATION);
  assert.equal(result.escalatedAt.getTime(), new Date('2026-09-30T10:02:00.000Z').getTime());

  assert.equal(repository.calls.escalate.length, 0, 'no duplicate transition');
  assert.equal(emit.calls.length, 0, 'no duplicate notification');
  assert.equal(repository.calls.find.length, 1, 'one read decides');
});

test('losing the race to a concurrent escalation replays without a second event', async () => {
  const sequence = [];
  const repository = makeRepository({
    finds: [sosDoc(), escalatedDoc()],
    sequence,
    escalateResult: null,
  });
  const emit = makeEmit(sequence);

  const result = await police({ repository, emit: emit.fn });

  assert.equal(result.status, 'NOTIFIED', 'the winner state answers');
  assert.equal(repository.calls.escalate.length, 1, 'one write attempt');
  assert.equal(emit.calls.length, 0, 'only the write winner notifies');
});

test('a lost race with no winner surfaces a conflict', async () => {
  const repository = makeRepository({ finds: [sosDoc(), sosDoc()], escalateResult: null });

  await assert.rejects(
    police({ repository }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_POLICE_CONFLICT'
  );
  assert.equal(repository.calls.escalate.length, 1);
});

test('a failed database write never emits the police event', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence, escalateError: new Error('database down') });
  const emit = makeEmit(sequence);

  await assert.rejects(police({ repository, emit: emit.fn }), /database down/);

  assert.deepEqual(sequence, ['write'], 'the write was attempted and failed');
  assert.equal(emit.calls.length, 0, 'no notification after a failed write');
  assert.equal(repository.calls.lastDoc, null);
});

test('the police event is withheld when the SOS is no longer active after the write', async () => {
  const repository = makeRepository({ finds: [sosDoc(), escalatedDoc({ status: 'CANCELLED' })] });
  const emit = makeEmit();

  const result = await police({ repository, emit: emit.fn });

  assert.equal(result.status, 'NOTIFIED', 'the persisted state still answers');
  assert.equal(emit.calls.length, 0, 'nobody is told about a cancelled SOS');
});

// ---------- unit: no side effects beyond the contract ----------

test('no geospatial or external police lookup exists on this flow', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    'src/modules/police/police.data.js',
    'src/modules/police/police.service.js',
    'src/modules/sos/escalation.service.js',
    'src/modules/sos/sos.controller.js',
    'src/modules/sos/sos.routes.js',
  ];
  const banned = [
    '$near',
    '2dsphere',
    'haversine',
    'maps.googleapis',
    'googleapis',
    'twilio',
    'geoip',
    'distanceMatrix',
    'places?',
  ];

  for (const file of files) {
    const content = fs.readFileSync(path.join(root, file), 'utf8');
    for (const marker of banned) {
      assert.ok(!content.includes(marker), `${file} must not contain ${marker}`);
    }
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

const post = async (pathAndQuery, token, payload) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  });

  return { status: res.status, body: await res.json() };
};

const get = async (pathAndQuery, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

  return { status: res.status, body: await res.json() };
};

const policePath = (sosId) => '/api/v1/sos/' + sosId + '/escalation/police';
const escalatePolice = (sosId, token, payload) => post(policePath(sosId), token, payload);

const seedSos = (userId, status, escalation) =>
  SosEvent.create({
    userId,
    triggerType: 'MANUAL',
    status,
    verification: {
      expiresAt: new Date(Date.now() + 60000),
      userResponse: null,
      respondedAt: null,
    },
    escalation: escalation ?? { currentLevel: 0, levels: [] },
  });

const guardianSeed = () => ({
  type: 'GUARDIAN',
  status: 'TIMEOUT',
  targetId: new mongoose.Types.ObjectId(),
  notifiedAt: new Date(),
  respondedAt: null,
  expiresAt: null,
});

const responderSeed = () => ({
  type: 'NEARBY_RESPONDER',
  status: 'TIMEOUT',
  targetId: null,
  notifiedResponders: [RESPONDER_1, RESPONDER_2],
  notifiedAt: new Date(),
  respondedAt: null,
  expiresAt: null,
});

/** A SOS that already walked GUARDIAN -> timeout -> NEARBY_RESPONDER -> timeout. */
const seedPoliceStageSos = async (status = 'ACTIVE', levels = null) => {
  const userId = newAccountId();
  const seededLevels = levels ?? [guardianSeed(), responderSeed()];
  const seeded = await seedSos(userId, status, {
    currentLevel: Math.max(0, seededLevels.length - 1),
    levels: seededLevels,
  });

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

// ---------- endpoint: success ----------

dbTest('an eligible SOS escalates to the prototype police station', async () => {
  const { userId, sosId } = await seedPoliceStageSos();

  const { status, body } = await escalatePolice(sosId, sign(userId), {});

  assert.equal(status, 200);
  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), [
    'escalatedAt',
    'level',
    'policeStation',
    'sosId',
    'status',
  ]);
  assert.equal(data.sosId, sosId);
  assert.equal(data.level, 'POLICE');
  assert.equal(data.status, 'NOTIFIED');
  assert.deepEqual(data.policeStation, STATION, 'the correct hardcoded station');
  assert.ok(!Number.isNaN(Date.parse(data.escalatedAt)));

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.currentLevel, 2, 'currentLevel = POLICE');
  assert.equal(doc.escalation.levels.length, 3);

  const police = doc.escalation.levels[2];
  assert.equal(police.type, 'POLICE');
  assert.equal(police.status, 'NOTIFIED');
  assert.equal(police.targetId, STATION.id);
  assert.deepEqual(
    { id: police.policeStation.id, name: police.policeStation.name, phone: police.policeStation.phone },
    STATION
  );
  assert.equal(police.source, 'PROTOTYPE_HARDCODED');
  assert.ok(police.escalatedAt instanceof Date);
  assert.equal(police.respondedAt, null, 'no police acknowledgement is faked');
  assert.equal(police.expiresAt, null, 'no timeout timer on the police level');

  assert.equal(doc.escalation.levels[0].status, 'TIMEOUT', 'guardian history untouched');
  assert.equal(doc.escalation.levels[1].status, 'TIMEOUT', 'responder history untouched');
  assert.equal(doc.status, 'ACTIVE', '§9: the SOS itself is untouched');
  assert.notEqual(doc.status, 'RESOLVED');
  assert.notEqual(doc.status, 'CANCELLED');
  assert.equal(doc.resolvedAt ?? null, null, '§9: never auto-resolved');
});

dbTest('the acknowledged state is recoverable through the GET API', async () => {
  const { userId, sosId } = await seedPoliceStageSos();
  await escalatePolice(sosId, sign(userId), {});

  const { status, body } = await get('/api/v1/sos/' + sosId, sign(userId));

  assert.equal(status, 200);
  const levels = body.data.escalation.levels;
  assert.equal(body.data.escalation.currentLevel, 2);
  assert.equal(levels.length, 3);
  assert.equal(levels[2].type, 'POLICE');
  assert.equal(levels[2].status, 'NOTIFIED');
  assert.equal(levels[2].targetId, STATION.id, 'the station id is readable after a dropped socket');
  assert.equal(levels[0].status, 'TIMEOUT');
  assert.equal(levels[1].status, 'TIMEOUT');
  assert.notEqual(body.data.status, 'RESOLVED');
});

dbTest('the endpoint neither requires nor initializes Socket.IO', async () => {
  const { userId, sosId } = await seedPoliceStageSos();

  const { status } = await escalatePolice(sosId, sign(userId), {});

  assert.equal(status, 200, 'the database write stands without a socket layer');
  assert.throws(() => getIO(), 'no socket layer is initialized by this flow');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels[2].status, 'NOTIFIED');
});

dbTest('a client-supplied station is ignored — only the server config is used', async () => {
  const { userId, sosId } = await seedPoliceStageSos();

  const { status, body } = await escalatePolice(sosId, sign(userId), {
    policeStation: { id: 'evil-999', name: 'Not A Station', phone: '9999999999' },
    level: 'GUARDIAN',
    status: 'ACKNOWLEDGED',
  });

  assert.equal(status, 200);
  assert.deepEqual(body.data.policeStation, STATION, '§14: no user-provided station id is trusted');
  assert.equal(body.data.level, 'POLICE');
  assert.equal(body.data.status, 'NOTIFIED');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels[2].targetId, STATION.id);
  assert.deepEqual(
    { id: doc.escalation.levels[2].policeStation.id, name: doc.escalation.levels[2].policeStation.name },
    { id: STATION.id, name: STATION.name }
  );
});

// ---------- endpoint: validation and authorization ----------

dbTest('unauthenticated escalation is rejected with 401', async () => {
  const { sosId } = await seedPoliceStageSos();

  const { status, body } = await post(policePath(sosId));

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

dbTest('an invalid SOS id is rejected with 400', async () => {
  const { status, body } = await escalatePolice('not-an-id', sign(OWNER_ID), {});

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('a missing SOS is 404', async () => {
  const missingId = new mongoose.Types.ObjectId().toString();

  const { status, body } = await escalatePolice(missingId, sign(OWNER_ID), {});

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SOS_NOT_FOUND');
});

dbTest('another user cannot escalate a SOS they do not own', async () => {
  const { sosId } = await seedPoliceStageSos();
  const strangerId = newAccountId();

  const { status, body } = await escalatePolice(sosId, sign(strangerId), {});

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_NOT_AUTHORIZED');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels.length, 2, 'nothing was written');
  assert.equal(doc.escalation.currentLevel, 1);
});

dbTest('a SOS that is no longer active cannot be escalated', async () => {
  const cancelled = await seedPoliceStageSos('CANCELLED');
  const cancelledRes = await escalatePolice(cancelled.sosId, sign(cancelled.userId), {});
  assert.equal(cancelledRes.status, 409);
  assert.equal(cancelledRes.body.error.code, 'SOS_NOT_ACTIVE');

  const resolved = await seedPoliceStageSos('RESOLVED');
  const resolvedRes = await escalatePolice(resolved.sosId, sign(resolved.userId), {});
  assert.equal(resolvedRes.status, 409);
  assert.equal(resolvedRes.body.error.code, 'SOS_NOT_ACTIVE');

  const doc = await SosEvent.findById(cancelled.sosId).lean();
  assert.equal(doc.escalation.levels.length, 2, 'no police level was added');
  assert.equal(doc.status, 'CANCELLED');
});

dbTest('escalation is refused before the workflow reaches the police stage', async () => {
  const guardianPending = await seedPoliceStageSos('ACTIVE', [
    { ...guardianSeed(), status: 'PENDING' },
  ]);
  const first = await escalatePolice(guardianPending.sosId, sign(guardianPending.userId), {});
  assert.equal(first.status, 409);
  assert.equal(first.body.error.code, 'ESCALATION_GUARDIAN_NOT_TIMED_OUT');

  const responderPending = await seedPoliceStageSos('ACTIVE', [
    guardianSeed(),
    { ...responderSeed(), status: 'PENDING' },
  ]);
  const second = await escalatePolice(responderPending.sosId, sign(responderPending.userId), {});
  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'ESCALATION_POLICE_NOT_ALLOWED');

  const responderMissing = await seedPoliceStageSos('ACTIVE', [guardianSeed()]);
  const third = await escalatePolice(responderMissing.sosId, sign(responderMissing.userId), {});
  assert.equal(third.status, 409, 'the responder stage must run first');
  assert.equal(third.body.error.code, 'ESCALATION_POLICE_NOT_ALLOWED');

  const doc = await SosEvent.findById(responderPending.sosId).lean();
  assert.equal(doc.escalation.levels.length, 2, 'no police level was added');
});

dbTest('a SOS with no escalation history is refused', async () => {
  const userId = newAccountId();
  const seeded = await seedSos(userId, 'ACTIVE', { currentLevel: 0, levels: [] });

  const { status, body } = await escalatePolice(seeded._id, sign(userId), {});

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_GUARDIAN_NOT_TIMED_OUT');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 0, 'an active SOS is never blindly sent to police');
});

// ---------- endpoint: idempotency and concurrency ----------

dbTest('a duplicate police escalation is idempotent', async () => {
  const { userId, sosId } = await seedPoliceStageSos();

  const first = await escalatePolice(sosId, sign(userId), {});
  assert.equal(first.status, 200);
  const afterFirst = await SosEvent.findById(sosId).lean();

  const second = await escalatePolice(sosId, sign(userId), {});
  const afterSecond = await SosEvent.findById(sosId).lean();

  assert.equal(second.status, 200, 'idempotent replay');
  assert.deepEqual(second.body.data, first.body.data, 'the same stored state is returned');
  assert.equal(afterSecond.escalation.levels.length, 3, 'no duplicate level');
  assert.equal(afterSecond.escalation.currentLevel, 2);
  assert.equal(
    new Date(afterSecond.escalation.levels[2].escalatedAt).getTime(),
    new Date(afterFirst.escalation.levels[2].escalatedAt).getTime(),
    'the stored escalation is never rewritten'
  );
});

dbTest('concurrent police escalations produce exactly one transition', async () => {
  const { userId, sosId } = await seedPoliceStageSos();

  const [a, b] = await Promise.all([
    escalatePolice(sosId, sign(userId), {}),
    escalatePolice(sosId, sign(userId), {}),
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels.length, 3, 'one police level');
  assert.equal(doc.escalation.currentLevel, 2);
  assert.equal(doc.escalation.levels[2].status, 'NOTIFIED');
  assert.equal(doc.escalation.levels[2].targetId, STATION.id);
  assert.equal(doc.status, 'ACTIVE', 'the SOS status is untouched by either request');
});

dbTest('escalation never resolves or closes the SOS', async () => {
  const { userId, sosId } = await seedPoliceStageSos();

  const { status } = await escalatePolice(sosId, sign(userId), {});
  assert.equal(status, 200);

  const doc = await SosEvent.findById(sosId).lean();
  assert.ok(['ACTIVE', 'ESCALATING'].includes(doc.status), 'still an open emergency');
  assert.equal(doc.resolvedAt ?? null, null);
  assert.equal(doc.escalation.levels[2].respondedAt, null, 'no acknowledgement was invented');
  assert.equal(doc.escalation.levels[2].status, 'NOTIFIED');
});
