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
import {
  acknowledgeResponderNotification,
  runResponderTimeout,
} from '../src/modules/sos/escalation.service.js';
import { SOS_EVENT, RESPONDER_SOS_EVENT } from '../src/modules/sos/sos.events.js';
import { getIO } from '../src/sockets/index.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0d1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0d2';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0d3';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0d4';

const RESPONDER_1 = 'responder-001';
const RESPONDER_2 = 'responder-002';
const RESPONDER_3 = 'responder-003'; // OFFLINE in the dataset, never notified

// ---------- unit fixtures (no database) ----------

const guardianLevel = (overrides = {}) => ({
  type: 'GUARDIAN',
  status: 'PENDING',
  targetId: GUARDIAN_ID,
  notifiedAt: new Date('2026-09-30T10:00:00.000Z'),
  respondedAt: null,
  expiresAt: new Date('2026-09-30T10:01:00.000Z'),
  ...overrides,
});

const responderLevel = (overrides = {}) => ({
  type: 'NEARBY_RESPONDER',
  status: 'PENDING',
  targetId: null,
  notifiedResponders: [RESPONDER_1, RESPONDER_2],
  notifiedAt: new Date('2026-09-30T10:01:00.000Z'),
  respondedAt: null,
  expiresAt: new Date('2026-09-30T10:02:00.000Z'),
  ...overrides,
});

const policeLevel = (overrides = {}) => ({
  type: 'POLICE',
  status: 'PENDING',
  targetId: null,
  notifiedAt: new Date('2026-09-30T10:02:00.000Z'),
  respondedAt: null,
  expiresAt: null,
  ...overrides,
});

const sosDoc = ({
  status = 'ACTIVE',
  levels = [guardianLevel()],
  currentLevel = 0,
  userId = OWNER_ID,
} = {}) => ({
  _id: SOS_ID,
  userId,
  status,
  escalation: { currentLevel, levels },
});

/** The persisted post-notify shape: guardian TIMEOUT + responder PENDING. */
const notifiedSos = (overrides = {}) =>
  sosDoc({
    levels: [guardianLevel({ status: 'TIMEOUT' }), responderLevel()],
    currentLevel: 1,
    ...overrides,
  });

/**
 * Sequence fake: `finds` feeds successive findById calls (last entry repeats);
 * `ackResult: null` simulates a lost atomic race. Once a write succeeds the
 * derived document is reported through `calls.lastAckDoc`.
 */
const makeRepository = (options = {}) => {
  const { finds = [], sequence = [] } = options;
  const calls = { find: [], ack: [], lastAckDoc: null };
  let cursor = 0;

  return {
    calls,
    sequence,
    findById: async (sosId) => {
      calls.find.push(sosId);
      if (!finds.length) return sosDoc();
      const index = Math.min(cursor, finds.length - 1);
      cursor += 1;
      return finds[index] === undefined ? null : finds[index];
    },
    acknowledgeEscalationLevel: async (args) => {
      calls.ack.push(args);
      sequence.push('write');
      if (options.ackResult !== undefined) {
        calls.lastAckDoc = options.ackResult;
        return options.ackResult;
      }

      const base = finds[0] ?? sosDoc();
      const current = base.escalation.currentLevel;
      const levels = base.escalation.levels.map((lvl, i) =>
        i === current
          ? {
              ...lvl,
              status: 'ACKNOWLEDGED',
              respondedAt: args.respondedAt,
              targetId: args.levelType === 'NEARBY_RESPONDER' ? args.target : lvl.targetId,
            }
          : lvl
      );
      const doc = {
        ...base,
        status: 'ACKNOWLEDGED',
        escalation: { currentLevel: current, levels },
      };
      calls.lastAckDoc = doc;
      return doc;
    },
    timeoutGuardianEscalation: async () => null,
  };
};

/**
 * Stateful fake mirroring the real conditional-update filters of
 * acknowledgeEscalationLevel / timeoutResponderEscalation, so the
 * acknowledge-vs-timeout race is exercised against persisted state.
 */
const makeStatefulRepository = (initial = notifiedSos()) => {
  const state = { doc: initial };
  const calls = { ack: [], timeout: [] };

  return {
    state,
    calls,
    findById: async () => state.doc,
    acknowledgeEscalationLevel: async ({ levelIndex, levelType, target, respondedAt }) => {
      calls.ack.push({ levelIndex, levelType, target, respondedAt });
      const doc = state.doc;
      const level = doc?.escalation?.levels?.[levelIndex];
      const open =
        doc &&
        ['ACTIVE', 'ESCALATING'].includes(doc.status) &&
        level?.type === levelType &&
        level?.status === 'PENDING' &&
        (levelType === 'GUARDIAN'
          ? String(level.targetId) === String(target)
          : (level.notifiedResponders ?? []).map(String).includes(String(target)));
      if (!open) return null;

      const levels = doc.escalation.levels.map((lvl, i) =>
        i === levelIndex
          ? {
              ...lvl,
              status: 'ACKNOWLEDGED',
              respondedAt,
              ...(levelType === 'NEARBY_RESPONDER' ? { targetId: target } : {}),
            }
          : lvl
      );
      state.doc = {
        ...doc,
        status: 'ACKNOWLEDGED',
        escalation: { currentLevel: levelIndex, levels },
      };
      return state.doc;
    },
    timeoutResponderEscalation: async ({ sosId }) => {
      calls.timeout.push({ sosId });
      const doc = state.doc;
      const level = doc?.escalation?.levels?.[1];
      const open =
        doc &&
        ['ACTIVE', 'ESCALATING'].includes(doc.status) &&
        level?.type === 'NEARBY_RESPONDER' &&
        level?.status === 'PENDING';
      if (!open) return null;

      state.doc = {
        ...doc,
        escalation: {
          currentLevel: 1,
          levels: doc.escalation.levels.map((lvl, i) =>
            i === 1 ? { ...lvl, status: 'TIMEOUT' } : lvl
          ),
        },
      };
      return state.doc;
    },
  };
};

const makeRelationships = () => {
  const calls = [];
  return {
    calls,
    findRelationship: async (ownerId, guardianId) => {
      calls.push({ ownerId, guardianId });
      return { _id: 'rel-1', status: 'ACTIVE' };
    },
  };
};

const makeProfiles = (names = {}) => ({
  findUserById: async (id) =>
    names[String(id)] !== undefined ? { _id: id, name: names[String(id)] } : null,
});

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

const makeCancel = (sequence = []) => {
  const calls = [];
  return {
    calls,
    fn: (sosId) => {
      calls.push(sosId);
      sequence.push('cancel');
      return true;
    },
  };
};

const ack = (overrides = {}) =>
  acknowledgeResponderNotification({
    sosId: SOS_ID,
    userId: RESPONDER_1,
    responderId: RESPONDER_1,
    relationships: makeRelationships(),
    profiles: makeProfiles({}),
    emit: async () => {},
    ...overrides,
  });

// ---------- unit: success path ----------

test('responder acknowledgement: write, cancel the timeout, then notify the owner', async () => {
  const sequence = [];
  const repository = makeRepository({ finds: [notifiedSos()], sequence });
  const relationships = makeRelationships();
  const emit = makeEmit(sequence);
  const cancel = makeCancel(sequence);

  const result = await ack({
    repository,
    relationships,
    emit: emit.fn,
    cancelTimeout: cancel.fn,
  });

  assert.deepEqual(Object.keys(result).sort(), [
    'acknowledgedAt',
    'acknowledgedBy',
    'level',
    'sosId',
    'status',
  ]);
  assert.equal(result.sosId, SOS_ID);
  assert.equal(result.level, 'NEARBY_RESPONDER');
  assert.equal(result.status, 'ACKNOWLEDGED');
  assert.equal(result.acknowledgedBy, RESPONDER_1);
  assert.ok(result.acknowledgedAt instanceof Date);

  assert.equal(relationships.calls.length, 0, 'responders are not guardian relationships');

  const write = repository.calls.ack[0];
  assert.equal(write.sosId, SOS_ID);
  assert.equal(write.userId, OWNER_ID, 'write scoped to the SOS owner');
  assert.equal(write.levelIndex, 1, 'acknowledges the CURRENT level');
  assert.equal(write.levelType, 'NEARBY_RESPONDER', 'this endpoint only ever acks the responder level');
  assert.equal(write.target, RESPONDER_1, 'backend-derived target');
  assert.ok(write.respondedAt instanceof Date);

  assert.deepEqual(
    sequence,
    ['write', 'cancel', 'emit', 'emit'],
    '§17: database first, then cancel, then notify (both channels)'
  );
  assert.deepEqual(cancel.calls, [SOS_ID], 'the responder timeout is cancelled');

  assert.equal(
    emit.calls.length,
    2,
    'the detailed event + the responder channel, no generic escalation event'
  );
  const { userId: recipient, event, payload } = emit.calls[0];
  assert.equal(recipient, OWNER_ID, "notified through the SOS owner's private room only");
  assert.equal(event, SOS_EVENT.RESPONDER_ACKNOWLEDGED);
  assert.equal(event, 'sos:responder:acknowledged');

  // §10-§11: responder:sos-acknowledged goes to the SAME owner room with the
  // SAME payload, right after the detailed event.
  const channel = emit.calls[1];
  assert.equal(channel.userId, OWNER_ID, 'the owner learns through their private room');
  assert.equal(channel.event, RESPONDER_SOS_EVENT.ACKNOWLEDGED);
  assert.equal(channel.event, 'responder:sos-acknowledged');
  assert.deepEqual(channel.payload, payload);

  assert.deepEqual(Object.keys(payload).sort(), [
    'acknowledgedAt',
    'level',
    'responder',
    'sosId',
    'status',
  ]);
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.level, 'NEARBY_RESPONDER');
  assert.equal(payload.status, 'ACKNOWLEDGED');
  assert.deepEqual(
    payload.responder,
    { responderId: RESPONDER_1, name: 'Rahul' },
    '§19: prototype dataset name, because no profile exists for a prototype id'
  );
  assert.equal(payload.acknowledgedAt, new Date(payload.acknowledgedAt).toISOString());

  const storedDoc = repository.calls.lastAckDoc;
  assert.equal(storedDoc.status, 'ACKNOWLEDGED', 'the state machine rule: acknowledged, never RESOLVED');
  assert.notEqual(storedDoc.status, 'RESOLVED');
  assert.equal(storedDoc.resolvedAt ?? null, null, 'acknowledgement never resolves the SOS');
  assert.equal(storedDoc.escalation.currentLevel, 1, 'the level index never advances');
  assert.equal(storedDoc.escalation.levels.length, 2, 'no police level is created');
  assert.equal(
    storedDoc.escalation.levels.some((lvl) => lvl.type === 'POLICE'),
    false,
    'no police escalation is triggered'
  );
  assert.equal(storedDoc.escalation.levels[1].status, 'ACKNOWLEDGED');
  assert.equal(storedDoc.escalation.levels[1].targetId, RESPONDER_1, 'records who acknowledged');
  assert.ok(storedDoc.escalation.levels[1].respondedAt instanceof Date);
  assert.deepEqual(
    storedDoc.escalation.levels[1].notifiedResponders,
    [RESPONDER_1, RESPONDER_2],
    'the notified list is preserved, never overwritten'
  );
  assert.equal(storedDoc.escalation.levels[0].status, 'TIMEOUT', 'previous level untouched');
});

test('the persisted profile name wins over the prototype dataset name', async () => {
  const repository = makeRepository({ finds: [notifiedSos()] });
  const emit = makeEmit();

  await ack({
    repository,
    profiles: makeProfiles({ [RESPONDER_1]: 'Nearby Helper' }),
    emit: emit.fn,
  });

  assert.deepEqual(emit.calls[0].payload.responder, {
    responderId: RESPONDER_1,
    name: 'Nearby Helper',
  });
});

// ---------- unit: authorization ----------

test('the URL responder id must match the authenticated caller', async () => {
  const repository = makeRepository({ finds: [notifiedSos()] });
  const relationships = makeRelationships();
  const emit = makeEmit();
  const cancel = makeCancel();

  await assert.rejects(
    ack({
      userId: RESPONDER_1,
      responderId: RESPONDER_2, // responder A answering through responder B's URL
      repository,
      relationships,
      emit: emit.fn,
      cancelTimeout: cancel.fn,
    }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RESPONDER_IDENTITY_MISMATCH'
  );

  assert.equal(repository.calls.ack.length, 0, 'nothing is written');
  assert.equal(emit.calls.length, 0, 'nobody is notified');
  assert.equal(cancel.calls.length, 0, 'the timeout keeps running');
});

test('an unrelated caller cannot acknowledge through a responder URL', async () => {
  const repository = makeRepository({ finds: [notifiedSos()] });

  await assert.rejects(
    ack({ userId: STRANGER_ID, responderId: RESPONDER_1, repository }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RESPONDER_IDENTITY_MISMATCH'
  );

  assert.equal(repository.calls.ack.length, 0);
});

test('a responder outside the notified list cannot acknowledge', async () => {
  const repository = makeRepository({ finds: [notifiedSos()] });
  const emit = makeEmit();

  await assert.rejects(
    ack({ userId: RESPONDER_3, responderId: RESPONDER_3, repository, emit: emit.fn }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RECIPIENT_NOT_AUTHORIZED'
  );

  assert.equal(repository.calls.ack.length, 0, 'the notified list is the source of truth');
  assert.equal(emit.calls.length, 0);
});

// ---------- unit: level and state guards ----------

test('only the current responder level can be acknowledged', async () => {
  const guardianCurrent = makeRepository({
    finds: [sosDoc({ levels: [guardianLevel()], currentLevel: 0 })],
  });
  await assert.rejects(
    ack({ repository: guardianCurrent }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_LEVEL_MISMATCH'
  );
  assert.equal(guardianCurrent.calls.ack.length, 0, 'a pending guardian level is never touched here');

  const policeCurrent = makeRepository({
    finds: [
      sosDoc({
        levels: [
          guardianLevel({ status: 'TIMEOUT' }),
          responderLevel({ status: 'ACKNOWLEDGED', targetId: RESPONDER_1 }),
          policeLevel(),
        ],
        currentLevel: 2,
      }),
    ],
  });
  await assert.rejects(
    ack({ repository: policeCurrent }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_LEVEL_MISMATCH'
  );
  assert.equal(policeCurrent.calls.ack.length, 0, 'no police level is ever acknowledged');
});

test('invalid escalation states are refused with the documented codes', async () => {
  const noLevels = makeRepository({ finds: [sosDoc({ levels: [], currentLevel: 0 })] });
  await assert.rejects(
    ack({ repository: noLevels }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_NOT_PENDING'
  );

  const duplicateDoc = notifiedSos();
  duplicateDoc.escalation.levels[1] = responderLevel({
    status: 'ACKNOWLEDGED',
    targetId: RESPONDER_1,
    respondedAt: new Date('2026-09-30T10:03:00.000Z'),
  });
  const duplicate = makeRepository({ finds: [duplicateDoc] });
  await assert.rejects(
    ack({ repository: duplicate }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_ACKNOWLEDGED'
  );
  assert.equal(duplicate.calls.ack.length, 0, 'a replay never rewrites the record');

  const timedOutDoc = notifiedSos();
  timedOutDoc.escalation.levels[1] = responderLevel({ status: 'TIMEOUT' });
  const timedOutLevel = makeRepository({ finds: [timedOutDoc] });
  await assert.rejects(
    ack({ repository: timedOutLevel }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS'
  );
  assert.equal(timedOutLevel.calls.ack.length, 0);

  const cancelled = makeRepository({ finds: [notifiedSos({ status: 'CANCELLED' })] });
  await assert.rejects(
    ack({ repository: cancelled }),
    (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACKNOWLEDGEABLE'
  );

  const resolved = makeRepository({ finds: [notifiedSos({ status: 'RESOLVED' })] });
  await assert.rejects(
    ack({ repository: resolved }),
    (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACKNOWLEDGEABLE'
  );

  const acknowledged = makeRepository({ finds: [notifiedSos({ status: 'ACKNOWLEDGED' })] });
  await assert.rejects(
    ack({ repository: acknowledged }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_ACKNOWLEDGED'
  );

  const missing = makeRepository({ finds: [null] });
  await assert.rejects(
    ack({ repository: missing }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );
});

// ---------- unit: races and delivery ----------

test('a socket failure never rolls back the acknowledgement', async () => {
  const sequence = [];
  const repository = makeRepository({ finds: [notifiedSos()], sequence });
  const cancel = makeCancel(sequence);
  const emit = async () => {
    sequence.push('emit');
    throw new Error('socket layer down');
  };

  const result = await ack({ repository, emit, cancelTimeout: cancel.fn });

  assert.equal(result.status, 'ACKNOWLEDGED');
  assert.deepEqual(sequence, ['write', 'cancel', 'emit', 'emit']);
  assert.equal(repository.calls.lastAckDoc.status, 'ACKNOWLEDGED', 'the write stands on its own');
});

test('acknowledgement and the responder timeout can never both win', async () => {
  // (a) the acknowledgement writes first: the late timer finds nothing pending.
  const first = makeStatefulRepository(notifiedSos());
  const firstAck = await ack({ repository: first, emit: async () => {} });
  assert.equal(firstAck.status, 'ACKNOWLEDGED');

  const firstPolice = [];
  const firstEmit = [];
  const fired = await runResponderTimeout({
    sosId: SOS_ID,
    repository: first,
    escalatePolice: async (args) => {
      firstPolice.push(args);
    },
    emit: async (userId, event) => {
      firstEmit.push({ userId, event });
    },
  });
  assert.equal(fired, false, 'the timed-out write is refused');
  assert.equal(first.state.doc.escalation.levels[1].status, 'ACKNOWLEDGED');
  assert.equal(first.state.doc.status, 'ACKNOWLEDGED');
  assert.equal(first.calls.timeout.length, 1);
  assert.equal(firstPolice.length, 0, 'the refused timeout never continues into police escalation');
  assert.equal(firstEmit.length, 0, 'the refused timeout never emits responder:sos-expired');

  // (b) the timeout writes first: the acknowledgement is refused as a 409.
  const second = makeStatefulRepository(notifiedSos());
  const secondPolice = [];
  const secondEmit = [];
  const timedOut = await runResponderTimeout({
    sosId: SOS_ID,
    repository: second,
    escalatePolice: async (args) => {
      secondPolice.push(args);
    },
    emit: async (userId, event) => {
      secondEmit.push({ userId, event });
    },
  });
  assert.equal(timedOut, true);
  assert.equal(second.state.doc.escalation.levels[1].status, 'TIMEOUT');
  assert.deepEqual(
    secondEmit.map((call) => call.event),
    ['responder:sos-expired', 'responder:sos-expired'],
    '§15: every notified responder hears about the expiry'
  );
  assert.equal(secondPolice.length, 1, '§19: the expiry continues into police escalation');
  assert.equal(secondPolice[0].userId, second.state.doc.userId, 'owner identity comes from the write');

  await assert.rejects(
    ack({ repository: second }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS'
  );
  assert.equal(second.state.doc.status, 'ACTIVE', 'a lost acknowledgement changes nothing');
  assert.equal(second.state.doc.escalation.levels[1].targetId, null);
});

// ---------- unit: no side effects beyond the contract ----------

test('no geospatial or third-party dispatch logic exists on this flow', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const files = [
    'src/modules/sos/escalation.service.js',
    'src/modules/sos/sos.controller.js',
    'src/modules/sos/sos.routes.js',
    'src/modules/responders/responder.service.js',
  ];
  const banned = ['$near', '2dsphere', 'haversine', 'maps.googleapis', 'twilio', 'geoip'];

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

const notifyPath = (sosId) => '/api/v1/sos/' + sosId + '/responders/notify';
const ackPath = (sosId, responderId) =>
  '/api/v1/sos/' + sosId + '/responders/' + responderId + '/acknowledge';

const notifyResponders = (sosId, token) => post(notifyPath(sosId), token, {});
const ackResponder = (sosId, responderId, token) => post(ackPath(sosId, responderId), token, {});

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

const seedGuardianTimedOut = async (status = 'ACTIVE') => {
  const userId = newAccountId();
  const seeded = await seedSos(userId, status, {
    currentLevel: 0,
    levels: [
      {
        type: 'GUARDIAN',
        status: 'TIMEOUT',
        targetId: new mongoose.Types.ObjectId(),
        notifiedAt: new Date(),
        respondedAt: null,
        expiresAt: null,
      },
    ],
  });

  return { userId, seeded };
};

/** Guardian TIMEOUT + responder level armed through the real notify endpoint. */
const seedNotifiedSos = async () => {
  const { userId, seeded } = await seedGuardianTimedOut();
  const res = await notifyResponders(seeded._id, sign(userId));
  assert.equal(res.status, 200, 'seed: the notify endpoint must arm the responder level');
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

// ---------- endpoint: validation and authorization ----------

dbTest('unauthenticated acknowledgement is rejected with 401', async () => {
  const { seeded } = await seedGuardianTimedOut();

  const { status, body } = await post(ackPath(seeded._id, RESPONDER_1));

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

dbTest('an invalid SOS id is rejected with 400', async () => {
  const { status, body } = await ackResponder('not-an-id', RESPONDER_1, sign(RESPONDER_1));

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('a malformed responder id is rejected with 400', async () => {
  const { sosId } = await seedNotifiedSos();

  const { status, body } = await ackResponder(sosId, 'x'.repeat(100), sign(RESPONDER_1));

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.responderId');
});

dbTest('a missing SOS is 404 and nothing is written', async () => {
  const missingId = new mongoose.Types.ObjectId().toString();

  const { status, body } = await ackResponder(missingId, RESPONDER_1, sign(RESPONDER_1));

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SOS_NOT_FOUND');
});

dbTest('a caller who is not the URL responder cannot acknowledge', async () => {
  const { sosId } = await seedNotifiedSos();

  const { status, body } = await ackResponder(sosId, RESPONDER_1, sign(STRANGER_ID));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_RESPONDER_IDENTITY_MISMATCH');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels[1].status, 'PENDING', 'nothing was written');
  assert.equal(doc.status, 'ACTIVE', 'the SOS is untouched');
});

dbTest('a responder outside the notified list cannot acknowledge', async () => {
  const { sosId } = await seedNotifiedSos();

  const { status, body } = await ackResponder(sosId, RESPONDER_3, sign(RESPONDER_3));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_RECIPIENT_NOT_AUTHORIZED');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels[1].status, 'PENDING');
});

// ---------- endpoint: success ----------

dbTest('acknowledgement: write, cancel the timeout, preserve the history', async () => {
  const { userId, sosId } = await seedNotifiedSos();

  const { status, body } = await ackResponder(sosId, RESPONDER_1, sign(RESPONDER_1));

  assert.equal(status, 200);
  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), [
    'acknowledgedAt',
    'acknowledgedBy',
    'level',
    'sosId',
    'status',
  ]);
  assert.equal(data.sosId, sosId);
  assert.equal(data.level, 'NEARBY_RESPONDER');
  assert.equal(data.status, 'ACKNOWLEDGED');
  assert.equal(data.acknowledgedBy, RESPONDER_1);
  assert.ok(!Number.isNaN(Date.parse(data.acknowledgedAt)));

  const doc = await SosEvent.findById(sosId).lean();
  const responder = doc.escalation.levels[1];
  assert.equal(doc.escalation.currentLevel, 1, 'the level index never advances on acknowledgement');
  assert.equal(responder.status, 'ACKNOWLEDGED');
  assert.equal(String(responder.targetId), RESPONDER_1, 'records who acknowledged');
  assert.ok(responder.respondedAt instanceof Date);
  assert.deepEqual(
    responder.notifiedResponders.map(String),
    [RESPONDER_1, RESPONDER_2],
    'the notified list is preserved'
  );
  assert.equal(doc.escalation.levels[0].status, 'TIMEOUT', 'the guardian level is untouched');
  assert.notEqual(doc.status, 'RESOLVED', 'acknowledgement never resolves the SOS');
  assert.equal(doc.resolvedAt ?? null, null, 'and never sets a resolution timestamp');
  assert.equal(doc.escalation.levels.length, 2, 'no police level is created');
  assert.equal(
    doc.escalation.levels.some((lvl) => lvl.type === 'POLICE'),
    false,
    'no police escalation is triggered'
  );
  assert.ok(userId, 'the seeded owner exists for this scenario');
});

dbTest('the endpoint neither requires nor initializes Socket.IO', async () => {
  const { sosId } = await seedNotifiedSos();

  const { status } = await ackResponder(sosId, RESPONDER_1, sign(RESPONDER_1));

  assert.equal(status, 200, 'the database write stands without a socket layer');
  assert.throws(() => getIO(), 'no socket layer is initialized by this flow');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels[1].status, 'ACKNOWLEDGED');
});

dbTest('the acknowledged state is recoverable through the GET API', async () => {
  const { userId, sosId } = await seedNotifiedSos();
  await ackResponder(sosId, RESPONDER_1, sign(RESPONDER_1));

  const { status, body } = await get('/api/v1/sos/' + sosId, sign(userId));

  assert.equal(status, 200);
  const levels = body.data.escalation.levels;
  assert.equal(levels.length, 2, 'still no police level');
  assert.equal(body.data.escalation.currentLevel, 1);
  assert.equal(levels[1].type, 'NEARBY_RESPONDER');
  assert.equal(levels[1].status, 'ACKNOWLEDGED');
  assert.equal(String(levels[1].targetId), RESPONDER_1);
  assert.ok(levels[1].respondedAt, 'recoverable after a dropped socket');
  assert.equal(levels[0].status, 'TIMEOUT', 'history is still visible');
});

// ---------- endpoint: duplicates, other responders, races ----------

dbTest('a duplicate acknowledgement is 409 and never rewrites the record', async () => {
  const { sosId } = await seedNotifiedSos();

  const first = await ackResponder(sosId, RESPONDER_1, sign(RESPONDER_1));
  assert.equal(first.status, 200);
  const afterFirst = await SosEvent.findById(sosId).lean();

  const second = await ackResponder(sosId, RESPONDER_1, sign(RESPONDER_1));

  assert.equal(second.status, 409);
  assert.equal(
    second.body.error.code,
    'SOS_ALREADY_ACKNOWLEDGED',
    'the shared SOS gate reports the acknowledgement first'
  );

  const afterSecond = await SosEvent.findById(sosId).lean();
  assert.equal(
    new Date(afterSecond.escalation.levels[1].respondedAt).getTime(),
    new Date(afterFirst.escalation.levels[1].respondedAt).getTime(),
    'the stored acknowledgement is never rewritten'
  );
  assert.deepEqual(
    afterSecond.escalation.levels[1].notifiedResponders,
    afterFirst.escalation.levels[1].notifiedResponders
  );
});

dbTest('every notified responder stays listed after one of them acknowledges', async () => {
  const { sosId } = await seedNotifiedSos();

  const first = await ackResponder(sosId, RESPONDER_1, sign(RESPONDER_1));
  assert.equal(first.status, 200);

  const second = await ackResponder(sosId, RESPONDER_2, sign(RESPONDER_2));

  assert.equal(second.status, 409, 'the level acknowledges exactly once');
  assert.equal(second.body.error.code, 'SOS_ALREADY_ACKNOWLEDGED');

  const doc = await SosEvent.findById(sosId).lean();
  const responder = doc.escalation.levels[1];
  assert.deepEqual(
    responder.notifiedResponders.map(String),
    [RESPONDER_1, RESPONDER_2],
    'both responders remain represented — the notified list is history, not per-responder state'
  );
  assert.equal(String(responder.targetId), RESPONDER_1, 'the acknowledged responder is recorded');
  assert.equal(responder.status, 'ACKNOWLEDGED');
});

dbTest('the responder timeout cannot overwrite an acknowledgement', async () => {
  const { sosId } = await seedNotifiedSos();
  await ackResponder(sosId, RESPONDER_1, sign(RESPONDER_1));

  const fired = await runResponderTimeout({ sosId });

  assert.equal(fired, false, 'the late timer finds nothing pending');
  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels[1].status, 'ACKNOWLEDGED');
});

dbTest('acknowledging after the responder level timed out is refused', async () => {
  const { sosId } = await seedNotifiedSos();

  const fired = await runResponderTimeout({ sosId });
  assert.equal(fired, true, 'seed: the responder level is now TIMEOUT');

  const { status, body } = await ackResponder(sosId, RESPONDER_1, sign(RESPONDER_1));

  assert.equal(status, 409);
  // §19: the expiry already continued into the police escalation, so the
  // current level no longer matches the responder level the caller tries to
  // acknowledge — either way the transition is refused.
  assert.equal(body.error.code, 'ESCALATION_LEVEL_MISMATCH');
  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.escalation.levels[1].targetId, null, 'nothing was written');
});

// ---------- endpoint: SOS and level state gates ----------

dbTest('a cancelled or resolved SOS cannot be acknowledged', async () => {
  const cancelled = await seedNotifiedSos();
  await SosEvent.updateOne(
    { _id: cancelled.sosId },
    { $set: { status: 'CANCELLED' } }
  );

  const cancelledRes = await ackResponder(cancelled.sosId, RESPONDER_1, sign(RESPONDER_1));
  assert.equal(cancelledRes.status, 409);
  assert.equal(cancelledRes.body.error.code, 'SOS_NOT_ACKNOWLEDGEABLE');

  const resolved = await seedNotifiedSos();
  await SosEvent.updateOne(
    { _id: resolved.sosId },
    { $set: { status: 'RESOLVED', resolvedAt: new Date() } }
  );

  const resolvedRes = await ackResponder(resolved.sosId, RESPONDER_1, sign(RESPONDER_1));
  assert.equal(resolvedRes.status, 409);
  assert.equal(resolvedRes.body.error.code, 'SOS_NOT_ACKNOWLEDGEABLE');

  const doc = await SosEvent.findById(resolved.sosId).lean();
  assert.equal(doc.escalation.levels[1].status, 'PENDING', 'no write on either attempt');
});

dbTest('acknowledging while the guardian level is still pending is refused', async () => {
  const userId = newAccountId();
  const seeded = await seedSos(userId, 'ACTIVE', {
    currentLevel: 0,
    levels: [
      {
        type: 'GUARDIAN',
        status: 'PENDING',
        targetId: new mongoose.Types.ObjectId(),
        notifiedAt: new Date(),
        respondedAt: null,
        expiresAt: new Date(Date.now() + 60000),
      },
    ],
  });

  const { status, body } = await ackResponder(seeded._id, RESPONDER_1, sign(RESPONDER_1));

  assert.equal(status, 409, '§6: the current escalation level must be the responder level');
  assert.equal(body.error.code, 'ESCALATION_LEVEL_MISMATCH');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels[0].status, 'PENDING', 'the guardian level is untouched');
  assert.equal(doc.escalation.levels.length, 1, 'no responder level exists yet');
});
