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
  startResponderEscalation,
  runResponderTimeout,
} from '../src/modules/sos/escalation.service.js';
import { getNearbyResponders } from '../src/modules/responders/responder.service.js';
import { SOS_EVENT, SOS_LIFECYCLE_EVENT, RESPONDER_SOS_EVENT } from '../src/modules/sos/sos.events.js';
import { getIO } from '../src/sockets/index.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0d1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0d2';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0d4';

const RESPONDER_1 = 'responder-001';
const RESPONDER_2 = 'responder-002';
const RESPONDER_3 = 'responder-003'; // OFFLINE in the prototype dataset

// ---------- unit fixtures (no database) ----------

const guardianLevel = (status = 'TIMEOUT') => ({
  type: 'GUARDIAN',
  status,
  targetId: GUARDIAN_ID,
  notifiedAt: new Date('2026-09-30T10:00:00.000Z'),
  respondedAt: null,
  expiresAt: new Date('2026-09-30T10:01:00.000Z'),
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

const sosDoc = ({
  status = 'ACTIVE',
  levels = [guardianLevel()],
  currentLevel = 0,
  userId = OWNER_ID,
} = {}) => ({
  _id: SOS_ID,
  userId,
  status,
  location: { lat: 19.31, lng: 84.79 },
  escalation: { currentLevel, levels },
});

/**
 * Sequence fake: `finds` feeds successive findById calls (last entry repeats);
 * `startResult: null` simulates a lost atomic race. Once a write succeeds the
 * written document becomes the default read result, exactly like the database
 * would return it after the update.
 */
const makeRepository = (options = {}) => {
  const { finds = [], sequence = [], startResult } = options;
  const calls = { find: [], start: [], timeout: [] };
  let cursor = 0;
  let written = null;

  return {
    calls,
    sequence,
    findById: async (sosId) => {
      calls.find.push(sosId);
      sequence.push('read');

      if (finds.length) {
        const index = Math.min(cursor, finds.length - 1);
        cursor += 1;
        if (finds[index] !== undefined) return finds[index];
      }

      return written ?? sosDoc();
    },
    startResponderEscalation: async (args) => {
      calls.start.push(args);
      sequence.push('write');

      if (startResult !== undefined) return startResult;

      const base = finds[0] ?? sosDoc();
      written = {
        ...base,
        escalation: {
          currentLevel: 1,
          levels: [...base.escalation.levels, args.level],
        },
      };
      return written;
    },
    timeoutResponderEscalation: async (args) => {
      calls.timeout.push(args);
      sequence.push('timeout');
      return options.timeoutResult ?? null;
    },
  };
};

/**
 * Stateful fake mirroring the real conditional-update filters: a write only
 * applies while the persisted state still allows it (same guards as
 * startResponderEscalation / timeoutResponderEscalation in sos.repository.js).
 */
const makeStatefulRepository = (initial = sosDoc()) => {
  const state = { doc: initial };
  const calls = { start: [], timeout: [] };

  return {
    state,
    calls,
    findById: async () => state.doc,
    startResponderEscalation: async ({ sosId, userId, level }) => {
      calls.start.push({ sosId, userId, level });
      const doc = state.doc;
      const open =
        doc &&
        ['ACTIVE', 'ESCALATING'].includes(doc.status) &&
        doc.escalation.levels[0]?.type === 'GUARDIAN' &&
        doc.escalation.levels[0]?.status === 'TIMEOUT' &&
        doc.escalation.levels.length === 1;
      if (!open) return null;

      state.doc = {
        ...doc,
        escalation: { currentLevel: 1, levels: [...doc.escalation.levels, level] },
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

const makeSchedule = (sequence = []) => {
  const calls = [];
  return {
    calls,
    fn: (task, ms) => {
      calls.push({ task, ms });
      sequence.push('schedule');
      return undefined;
    },
  };
};

const makeProfiles = (names = {}) => ({
  findUserById: async (id) =>
    names[String(id)] !== undefined ? { _id: id, name: names[String(id)] } : null,
});

const notify = (overrides = {}) =>
  startResponderEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    profiles: makeProfiles({ [OWNER_ID]: 'Ansuman' }),
    emit: async () => {},
    ...overrides,
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
const notifyResponders = (sosId, token) => post(notifyPath(sosId), token, {});

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

// ---------- unit: success path ----------

test('responder escalation: validate, write, arm the timer, then notify each responder', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence });
  const emit = makeEmit(sequence);
  const schedule = makeSchedule(sequence);

  const result = await notify({
    repository,
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    timeoutMs: 5000,
  });

  assert.deepEqual(
    Object.keys(result).sort(),
    ['expiresAt', 'level', 'notifiedResponders', 'radiusKm', 'sosId', 'status'],
    'the documented response shape, nothing extra'
  );
  assert.equal(result.sosId, SOS_ID);
  assert.equal(result.level, 'NEARBY_RESPONDER');
  assert.equal(result.status, 'PENDING', 'notified, never acknowledged');
  assert.equal(result.radiusKm, 2, 'the 2 km business-rule label');

  // §8/§29: the ids come from the SAME hardcoded dataset as GET /responders/nearby.
  const fromService = getNearbyResponders().responders.map((responder) => responder.id);
  assert.deepEqual(result.notifiedResponders, fromService);
  assert.ok(result.notifiedResponders.includes(RESPONDER_1));
  assert.ok(result.notifiedResponders.includes(RESPONDER_2));
  assert.ok(!result.notifiedResponders.includes(RESPONDER_3), 'offline sample is not notified');
  assert.ok(result.notifiedResponders.length >= 2, 'every eligible responder is notified');

  const written = repository.calls.start[0];
  assert.equal(repository.calls.start.length, 1, 'one atomic write');
  assert.equal(written.sosId, SOS_ID);
  assert.equal(written.userId, OWNER_ID, 'ownership is part of the filter');

  const level = written.level;
  assert.equal(level.type, 'NEARBY_RESPONDER');
  assert.equal(level.status, 'PENDING', 'notification is not acknowledgement');
  assert.equal(level.targetId, null);
  assert.deepEqual(level.notifiedResponders, result.notifiedResponders);
  assert.equal(level.respondedAt, null, 'nobody has responded yet');
  assert.ok(level.notifiedAt instanceof Date);
  assert.equal(
    level.expiresAt.getTime() - level.notifiedAt.getTime(),
    5000,
    'expiresAt follows the configured timeout'
  );

  // §17: validate -> write -> arm the timer -> re-read -> emit, never the
  // other way round (the lifecycle stage-move event first, then one emit per
  // responder, after everything else).
  assert.deepEqual(
    sequence.filter((step) => step !== 'emit'),
    ['read', 'write', 'schedule', 'read']
  );
  assert.ok(
    sequence.indexOf('emit') > sequence.indexOf('write'),
    'the database write always precedes the notification'
  );
  assert.ok(
    sequence.indexOf('emit') > sequence.lastIndexOf('read'),
    'the persisted state is re-checked before anyone is told'
  );
  assert.equal(
    sequence.filter((step) => step === 'emit').length,
    result.notifiedResponders.length * 2 + 1,
    'one sos:escalating for the owner + two events per responder (detailed + responder channel)'
  );
  assert.equal(schedule.calls.length, 1, 'exactly one timeout registered');
  assert.equal(schedule.calls[0].ms, 5000);

  // §15/§16: the owner hears sos:escalating first, then one private room per
  // responder for each of the two notification channels, never a broadcast.
  assert.equal(emit.calls.length, result.notifiedResponders.length * 2 + 1);
  assert.equal(emit.calls[0].event, SOS_LIFECYCLE_EVENT.ESCALATING);
  assert.equal(emit.calls[0].userId, OWNER_ID, 'stage-move event: owner room only');
  assert.deepEqual(
    Object.keys(emit.calls[0].payload).sort(),
    ['currentLevel', 'escalatedAt', 'previousLevel', 'reason', 'sosId', 'status']
  );
  assert.equal(emit.calls[0].payload.currentLevel, 'NEARBY_RESPONDER');
  assert.equal(emit.calls[0].payload.previousLevel, 'GUARDIAN');
  assert.equal(emit.calls[0].payload.reason, 'GUARDIAN_TIMEOUT');

  const responderCalls = emit.calls.slice(1);
  const detailed = responderCalls.filter((call) => call.event === SOS_EVENT.RESPONDER_NOTIFY);
  const channel = responderCalls.filter(
    (call) => call.event === RESPONDER_SOS_EVENT.NOTIFICATION
  );
  assert.equal(
    detailed.length,
    result.notifiedResponders.length,
    'one detailed sos:responder:notify per responder'
  );
  assert.equal(
    channel.length,
    result.notifiedResponders.length,
    'one responder:sos-notification per responder (§4)'
  );
  assert.deepEqual(
    responderCalls.map((call) => call.userId).sort(),
    [...result.notifiedResponders, ...result.notifiedResponders].sort()
  );
  for (const call of responderCalls) {
    assert.equal(call.userId.includes('*'), false, 'never a broadcast');
    assert.ok(
      result.notifiedResponders.includes(call.userId),
      'only responders actually selected by the escalation'
    );
  }
  assert.deepEqual(
    channel[0].payload,
    detailed[0].payload,
    'both channels carry the same §4 payload'
  );

  const payload = detailed[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), [
    'expiresAt',
    'level',
    'location',
    'radiusKm',
    'sosId',
    'status',
    'user',
  ]);
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.level, 'NEARBY_RESPONDER');
  assert.equal(payload.status, 'PENDING');
  assert.equal(payload.radiusKm, 2, 'a label, not a measured distance');
  assert.deepEqual(payload.user, { userId: OWNER_ID, name: 'Ansuman' });
  assert.deepEqual(payload.location, { lat: 19.31, lng: 84.79 }, 'display only, from the SOS');
  assert.equal(typeof payload.expiresAt, 'string');
  for (const forbidden of ['password', 'token', 'jwt', 'apiKey', 'secret']) {
    assert.ok(!(forbidden in payload), `payload must not carry ${forbidden}`);
  }

  // §19/§20: the SOS stays ACTIVE, nothing is resolved, nothing is acknowledged.
  const doc = await repository.findById(SOS_ID);
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.resolvedAt, undefined);
  assert.equal(doc.escalation.currentLevel, 1, 'current level index advanced');
  assert.equal(doc.escalation.levels.length, 2, 'guardian history preserved');
  assert.equal(doc.escalation.levels[0].status, 'TIMEOUT', 'guardian level untouched');
  assert.equal(doc.escalation.levels[1].status, 'PENDING');
});

// ---------- unit: authorization and state validation ----------

test('a missing SOS is 404 and nothing is written', async () => {
  const repository = makeRepository({ finds: [null] });
  const emit = makeEmit();

  await assert.rejects(
    () => notify({ repository, emit: emit.fn }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );

  assert.equal(repository.calls.start.length, 0);
  assert.equal(emit.calls.length, 0);
});

test("another user's SOS is rejected with 403 and nothing is written", async () => {
  const repository = makeRepository({ finds: [sosDoc({ userId: '64b0f0f0f0f0f0f0f0f0f0d9' })] });
  const emit = makeEmit();
  const schedule = makeSchedule();

  await assert.rejects(
    () => notify({ repository, emit: emit.fn, scheduleTimeout: schedule.fn }),
    (err) => err.statusCode === 403 && err.code === 'SOS_NOT_AUTHORIZED'
  );

  assert.equal(repository.calls.start.length, 0);
  assert.equal(emit.calls.length, 0);
  assert.equal(schedule.calls.length, 0);
});

test('a guardian that is still PENDING cannot be skipped', async () => {
  const repository = makeRepository({ finds: [sosDoc({ levels: [guardianLevel('PENDING')] })] });
  const emit = makeEmit();
  const schedule = makeSchedule();

  await assert.rejects(
    () => notify({ repository, emit: emit.fn, scheduleTimeout: schedule.fn }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_GUARDIAN_NOT_TIMED_OUT'
  );

  assert.equal(repository.calls.start.length, 0, 'no escalation level is written');
  assert.equal(repository.calls.timeout.length, 0);
  assert.equal(emit.calls.length, 0, 'nobody is notified');
  assert.equal(schedule.calls.length, 0, 'no timeout is armed');
});

test('an SOS that never started escalation is refused', async () => {
  const repository = makeRepository({ finds: [sosDoc({ levels: [] })] });

  await assert.rejects(
    () => notify({ repository }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_GUARDIAN_NOT_TIMED_OUT'
  );

  assert.equal(repository.calls.start.length, 0);
});

test('an acknowledged guardian level is refused', async () => {
  const repository = makeRepository({
    finds: [sosDoc({ status: 'ACTIVE', levels: [guardianLevel('ACKNOWLEDGED')] })],
  });

  await assert.rejects(
    () => notify({ repository }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_ACKNOWLEDGED'
  );

  assert.equal(repository.calls.start.length, 0);
});

test('cancelled, resolved and acknowledged SOS records are refused', async () => {
  for (const [status, code] of [
    ['CANCELLED', 'SOS_NOT_ACTIVE'],
    ['RESOLVED', 'SOS_NOT_ACTIVE'],
    ['VERIFYING', 'SOS_NOT_ACTIVE'],
    ['ACKNOWLEDGED', 'SOS_ALREADY_ACKNOWLEDGED'],
  ]) {
    const repository = makeRepository({ finds: [sosDoc({ status })] });
    const emit = makeEmit();

    await assert.rejects(
      () => notify({ repository, emit: emit.fn }),
      (err) => err.statusCode === 409 && err.code === code,
      `${status} SOS must be refused with ${code}`
    );

    assert.equal(repository.calls.start.length, 0, `${status}: nothing written`);
    assert.equal(emit.calls.length, 0, `${status}: nobody notified`);
  }
});

// ---------- unit: duplicates and races ----------

test('a duplicate request replays the existing level without notifying twice', async () => {
  const existing = sosDoc({
    currentLevel: 1,
    levels: [guardianLevel(), responderLevel()],
  });
  const repository = makeRepository({ finds: [existing] });
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await notify({ repository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.equal(result.status, 'PENDING');
  assert.deepEqual(result.notifiedResponders, [RESPONDER_1, RESPONDER_2]);
  assert.equal(repository.calls.start.length, 0, 'no second level is written');
  assert.equal(emit.calls.length, 0, 'no duplicate notification batch');
  assert.equal(schedule.calls.length, 0, 'no duplicate timeout job');
});

test('an acknowledged responder level is refused', async () => {
  const repository = makeRepository({
    finds: [
      sosDoc({
        currentLevel: 1,
        levels: [guardianLevel(), responderLevel({ status: 'ACKNOWLEDGED' })],
      }),
    ],
  });

  await assert.rejects(
    () => notify({ repository }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_ACKNOWLEDGED'
  );

  assert.equal(repository.calls.start.length, 0);
});

test('a timed-out responder level or an existing police level is refused', async () => {
  const timedOut = makeRepository({
    finds: [
      sosDoc({
        currentLevel: 1,
        levels: [guardianLevel(), responderLevel({ status: 'TIMEOUT' })],
      }),
    ],
  });

  await assert.rejects(
    () => notify({ repository: timedOut }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS'
  );
  assert.equal(timedOut.calls.start.length, 0, 'escalation never moves backwards');

  const police = makeRepository({
    finds: [
      sosDoc({
        currentLevel: 1,
        levels: [
          guardianLevel(),
          { type: 'POLICE', status: 'PENDING', targetId: null, notifiedAt: new Date(), respondedAt: null },
        ],
      }),
    ],
  });

  await assert.rejects(
    () => notify({ repository: police }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS'
  );
  assert.equal(police.calls.start.length, 0, 'police escalation is never restarted here');
});

test('a lost race replays the winner instead of notifying twice', async () => {
  const before = sosDoc();
  const winner = sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] });
  const repository = makeRepository({ finds: [before, winner], startResult: null });
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await notify({ repository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.equal(result.status, 'PENDING');
  assert.equal(repository.calls.start.length, 1, 'the write was attempted exactly once');
  assert.equal(emit.calls.length, 0, 'the loser never notifies');
  assert.equal(schedule.calls.length, 0, 'the loser never arms a timer');
});

test('a lost race against a state that never changed reports a conflict', async () => {
  const before = sosDoc();
  const repository = makeRepository({ finds: [before, before], startResult: null });

  await assert.rejects(
    () => notify({ repository }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_RESPONDER_CONFLICT'
  );
});

// ---------- unit: no eligible responders ----------

test('no eligible responders: TIMEOUT level recorded, nothing faked', async () => {
  const repository = makeRepository();
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await notify({
    repository,
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    eligibleResponders: () => [],
  });

  assert.equal(repository.calls.start.length, 1, 'the state still advances');
  const level = repository.calls.start[0].level;
  assert.equal(level.type, 'NEARBY_RESPONDER');
  assert.equal(level.status, 'TIMEOUT', 'the next stage can proceed instead of waiting forever');
  assert.deepEqual(level.notifiedResponders, []);

  assert.equal(result.status, 'TIMEOUT');
  assert.deepEqual(result.notifiedResponders, []);
  assert.equal(result.expiresAt, null);

  assert.equal(emit.calls.length, 0, 'nobody is notified');
  assert.equal(schedule.calls.length, 0, 'no timeout is armed for an empty level');

  const doc = await repository.findById(SOS_ID);
  assert.equal(doc.escalation.levels[1].status, 'TIMEOUT');
  assert.equal(doc.status, 'ACTIVE', 'the SOS is never left stuck or resolved');
  assert.notEqual(
    doc.escalation.levels[1].status,
    'ACKNOWLEDGED',
    'a fake acknowledgement is never created'
  );
});

// ---------- unit: socket failure and cancellation races ----------

test('a failing notification never rolls back the persisted level', async () => {
  const repository = makeRepository();
  const failingEmit = async (userId, event) => {
    throw new Error(`socket backend down: ${event}`);
  };

  const result = await notify({ repository, emit: failingEmit, timeoutMs: 5000 });

  assert.equal(result.status, 'PENDING', 'the request still succeeds');
  assert.equal(repository.calls.start.length, 1, 'the write happened first');
  assert.equal(
    repository.calls.start[0].level.status,
    'PENDING',
    'the stored state is untouched by the delivery failure'
  );

  const doc = await repository.findById(SOS_ID);
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.escalation.levels[1].status, 'PENDING', 'recoverable through the GET APIs');
});

test('a SOS cancelled while the request is in flight notifies nobody', async () => {
  const before = sosDoc();
  const cancelled = sosDoc({ status: 'CANCELLED' });
  const repository = makeRepository({ finds: [before, cancelled] });
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await notify({ repository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.equal(result.status, 'PENDING', 'the level written first stays as recorded');
  assert.equal(repository.calls.start.length, 1);
  assert.equal(emit.calls.length, 0, 'emission is withheld for a cancelled SOS');
  assert.equal(schedule.calls.length, 1, 'the armed timer re-validates and will not escalate');
});

// ---------- unit: timeout races (same registry as the guardian level) ----------

test('a responder acknowledgement is never overwritten by the timeout', async () => {
  const repository = makeStatefulRepository(
    sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] })
  );

  // The ack endpoint's atomic write moves the level (and the SOS) to
  // ACKNOWLEDGED — simulate exactly that persisted outcome.
  repository.state.doc = {
    ...repository.state.doc,
    status: 'ACKNOWLEDGED',
    escalation: {
      currentLevel: 1,
      levels: [
        repository.state.doc.escalation.levels[0],
        {
          ...repository.state.doc.escalation.levels[1],
          status: 'ACKNOWLEDGED',
          respondedAt: new Date(),
          targetId: RESPONDER_1,
        },
      ],
    },
  };

  const policeCalls = [];
  const fired = await runResponderTimeout({
    sosId: SOS_ID,
    repository,
    escalatePolice: async (args) => {
      policeCalls.push(args);
    },
  });

  assert.equal(fired, false, 'the late timer refuses to write');
  assert.equal(repository.state.doc.escalation.levels[1].status, 'ACKNOWLEDGED');
  assert.equal(repository.state.doc.escalation.levels[1].targetId, RESPONDER_1);
  assert.equal(policeCalls.length, 0, 'a lost timeout never continues into police escalation');
});

test('the responder timeout records TIMEOUT once, notifies the expiry and continues into police once', async () => {
  const repository = makeStatefulRepository(
    sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] })
  );
  const emit = makeEmit();
  const policeCalls = [];
  const escalatePolice = async (args) => {
    policeCalls.push(args);
  };

  assert.equal(
    await runResponderTimeout({ sosId: SOS_ID, repository, emit: emit.fn, escalatePolice }),
    true
  );
  assert.equal(repository.state.doc.escalation.levels[1].status, 'TIMEOUT');
  assert.equal(repository.state.doc.status, 'ACTIVE', 'the SOS is not resolved by a timeout');

  // §15-§18: responder:sos-expired goes to every responder on the level
  // (persisted status TIMEOUT, reason label), nothing to the owner here.
  assert.deepEqual(emit.calls.map((call) => call.event), [
    RESPONDER_SOS_EVENT.EXPIRED,
    RESPONDER_SOS_EVENT.EXPIRED,
  ]);
  for (const call of emit.calls) {
    assert.ok([RESPONDER_1, RESPONDER_2].includes(call.userId), 'notified responders only');
    assert.deepEqual(Object.keys(call.payload).sort(), [
      'expiredAt',
      'level',
      'reason',
      'sosId',
      'status',
    ]);
    assert.equal(call.payload.sosId, SOS_ID);
    assert.equal(call.payload.level, 'NEARBY_RESPONDER');
    assert.equal(call.payload.status, 'TIMEOUT', 'the persisted status, not a new EXPIRED state');
    assert.equal(call.payload.reason, 'RESPONDER_TIMEOUT');
    assert.equal(typeof call.payload.expiredAt, 'string');
  }

  // §19: the expiry continues through the existing police escalation service.
  assert.equal(policeCalls.length, 1, 'exactly one police escalation attempt');
  assert.equal(policeCalls[0].sosId, SOS_ID);
  assert.equal(policeCalls[0].userId, OWNER_ID, 'driven with the persisted owner identity');

  assert.equal(await runResponderTimeout({ sosId: SOS_ID, repository, emit: emit.fn, escalatePolice }), false, 'idempotent');
  assert.equal(repository.state.doc.escalation.levels[1].status, 'TIMEOUT');
  assert.equal(repository.calls.timeout.length, 2, 'the second write was refused');
  assert.equal(emit.calls.length, 2, 'a duplicate timeout never duplicates the expiry event');
  assert.equal(policeCalls.length, 1, 'a duplicate timeout never duplicates police escalation');
});

test('a cancelled SOS never escalates further when the timeout fires', async () => {
  const repository = makeStatefulRepository(
    sosDoc({
      status: 'CANCELLED',
      currentLevel: 1,
      levels: [guardianLevel(), responderLevel()],
    })
  );
  const policeCalls = [];

  assert.equal(
    await runResponderTimeout({
      sosId: SOS_ID,
      repository,
      escalatePolice: async (args) => {
        policeCalls.push(args);
      },
    }),
    false
  );
  assert.equal(repository.state.doc.escalation.levels[1].status, 'PENDING', 'untouched');
  assert.equal(policeCalls.length, 0, 'a cancelled SOS never reaches police through a timer');
});

// ---------- unit: prototype constraints ----------

test('the responder escalation contains no geospatial or phone-call logic', async () => {
  const backend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = [
    'modules/sos/escalation.service.js',
    'modules/sos/sos.repository.js',
    'modules/sos/sos.events.js',
    'modules/sos/sos.controller.js',
    'modules/responders/responder.service.js',
    'modules/responders/responder.data.js',
    'modules/responders/responder.constants.js',
  ];

  const forbidden = [
    '$near',
    '2dsphere',
    'haversine',
    'maps.googleapis',
    'directionsapi',
    'geocod',
    'distanceKm',
    'twilio',
    'pstn',
    'req.query',
  ];

  for (const file of files) {
    const source = fs.readFileSync(path.join(backend, file), 'utf8').toLowerCase();

    for (const marker of forbidden) {
      assert.ok(
        !source.includes(marker.toLowerCase()),
        `${file} must not reference "${marker}"`
      );
    }
  }
});

// ---------- endpoint ----------

test('rejects an unauthenticated responder notification', async () => {
  const { status, body } = await notifyResponders(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid SOS id with 400', async () => {
  const token = sign(newAccountId());
  const { status, body } = await notifyResponders('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('returns 404 for a valid but non-existent SOS id', async () => {
  const { status, body } = await notifyResponders(
    new mongoose.Types.ObjectId().toString(),
    sign(newAccountId())
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'SOS_NOT_FOUND');
});

dbTest("returns 403 when the SOS belongs to another user", async () => {
  const { seeded } = await seedGuardianTimedOut();
  const stranger = newAccountId();

  const { status, body } = await notifyResponders(seeded._id, sign(stranger));

  assert.equal(status, 403);
  assert.equal(body.error.code, 'SOS_NOT_AUTHORIZED');
  assert.equal(body.data, undefined, 'no escalation data is exposed to foreign callers');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 1, 'nothing was written');
});

dbTest('starts responder escalation for a guardian that timed out', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();

  const before = Date.now();
  const { status, body } = await notifyResponders(seeded._id, sign(userId));
  const after = Date.now();

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const data = body.data;
  assert.deepEqual(Object.keys(data).sort(), [
    'expiresAt',
    'level',
    'notifiedResponders',
    'radiusKm',
    'sosId',
    'status',
  ]);
  assert.equal(data.sosId, String(seeded._id));
  assert.equal(data.level, 'NEARBY_RESPONDER');
  assert.equal(data.status, 'PENDING', 'notified, never acknowledged');
  assert.equal(data.radiusKm, 2);
  assert.deepEqual(
    data.notifiedResponders,
    getNearbyResponders().responders.map((responder) => responder.id),
    'the same hardcoded dataset as GET /responders/nearby'
  );

  const expiresAt = new Date(data.expiresAt).getTime();
  assert.ok(expiresAt >= before + 50000 && expiresAt <= after + 70000, 'server-generated expiry');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE', 'the SOS remains active');
  assert.equal(doc.resolvedAt, null, 'no automatic resolution');
  assert.equal(doc.escalation.currentLevel, 1);
  assert.equal(doc.escalation.levels.length, 2, 'guardian history preserved');

  const guardian = doc.escalation.levels[0];
  assert.equal(guardian.type, 'GUARDIAN');
  assert.equal(guardian.status, 'TIMEOUT', 'untouched');

  const responder = doc.escalation.levels[1];
  assert.equal(responder.type, 'NEARBY_RESPONDER');
  assert.equal(responder.status, 'PENDING', 'no automatic acknowledgement');
  assert.equal(responder.respondedAt, null);
  assert.equal(responder.targetId, null);
  assert.deepEqual(
    responder.notifiedResponders.map(String),
    data.notifiedResponders,
    'the notified responder ids are persisted'
  );
  assert.ok(responder.notifiedAt, 'the notification timestamp is persisted');
});

dbTest('the escalation state is recoverable through the GET API', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();
  await notifyResponders(seeded._id, sign(userId));

  const { status, body } = await get('/api/v1/sos/' + seeded._id, sign(userId));

  assert.equal(status, 200);
  const levels = body.data.escalation.levels;
  assert.equal(levels.length, 2);
  assert.equal(body.data.escalation.currentLevel, 1);
  assert.equal(levels[1].type, 'NEARBY_RESPONDER');
  assert.equal(levels[1].status, 'PENDING', 'recoverable after a dropped socket');
  assert.equal(levels[0].type, 'GUARDIAN');
  assert.equal(levels[0].status, 'TIMEOUT', 'history is still visible');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.deepEqual(
    doc.escalation.levels[1].notifiedResponders.map(String),
    getNearbyResponders().responders.map((responder) => responder.id),
    'the notified list stays persisted in the database'
  );
});

dbTest('a duplicate request does not notify or rewrite anything', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();

  const first = await notifyResponders(seeded._id, sign(userId));
  assert.equal(first.status, 200);

  const afterFirst = await SosEvent.findById(seeded._id).lean();
  const second = await notifyResponders(seeded._id, sign(userId));
  const afterSecond = await SosEvent.findById(seeded._id).lean();

  assert.equal(second.status, 200, 'idempotent replay');
  assert.equal(afterSecond.escalation.levels.length, 2, 'no duplicate level');
  assert.equal(
    new Date(afterSecond.escalation.levels[1].notifiedAt).getTime(),
    new Date(afterFirst.escalation.levels[1].notifiedAt).getTime(),
    'the stored notification is never rewritten'
  );
  assert.deepEqual(
    afterSecond.escalation.levels[1].notifiedResponders,
    afterFirst.escalation.levels[1].notifiedResponders
  );
});

dbTest('concurrent requests produce exactly one responder escalation', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();

  const [a, b] = await Promise.all([
    notifyResponders(seeded._id, sign(userId)),
    notifyResponders(seeded._id, sign(userId)),
  ]);

  assert.equal(a.status, 200);
  assert.equal(b.status, 200);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 2, 'one guardian level + one responder level');
  assert.equal(doc.escalation.currentLevel, 1);
  assert.equal(doc.escalation.levels[1].status, 'PENDING');
});

dbTest('a guardian that is still PENDING cannot be skipped', async () => {
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

  const { status, body } = await notifyResponders(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_GUARDIAN_NOT_TIMED_OUT');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 1, 'no responder level was written');
});

dbTest('an SOS without escalation cannot start responder notification', async () => {
  const userId = newAccountId();
  const seeded = await seedSos(userId, 'ACTIVE');

  const { status, body } = await notifyResponders(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_GUARDIAN_NOT_TIMED_OUT');
});

dbTest('cancelled, resolved and acknowledged SOS records are refused', async () => {
  for (const [status, code] of [
    ['CANCELLED', 'SOS_NOT_ACTIVE'],
    ['RESOLVED', 'SOS_NOT_ACTIVE'],
    ['ACKNOWLEDGED', 'SOS_ALREADY_ACKNOWLEDGED'],
  ]) {
    const { userId, seeded } = await seedGuardianTimedOut(status);
    const { status: httpStatus, body } = await notifyResponders(seeded._id, sign(userId));

    assert.equal(httpStatus, 409, `${status} SOS is refused`);
    assert.equal(body.error.code, code);

    const doc = await SosEvent.findById(seeded._id).lean();
    assert.equal(doc.escalation.levels.length, 1, `${status}: nothing was written`);
  }
});

dbTest('an already acknowledged responder level is refused', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();
  await SosEvent.updateOne(
    { _id: seeded._id },
    {
      $set: { 'escalation.currentLevel': 1 },
      $push: {
        'escalation.levels': {
          type: 'NEARBY_RESPONDER',
          status: 'ACKNOWLEDGED',
          targetId: null,
          notifiedResponders: ['responder-001'],
          notifiedAt: new Date(),
          respondedAt: new Date(),
          expiresAt: null,
        },
      },
    }
  );

  const { status, body } = await notifyResponders(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_ALREADY_ACKNOWLEDGED');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels.length, 2, 'no duplicate level');
});

dbTest('an existing police level is never replaced by responder escalation', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();
  await SosEvent.updateOne(
    { _id: seeded._id },
    {
      $set: { 'escalation.currentLevel': 1 },
      $push: {
        'escalation.levels': {
          type: 'POLICE',
          status: 'PENDING',
          targetId: null,
          notifiedAt: new Date(),
          respondedAt: null,
          expiresAt: null,
        },
      },
    }
  );

  const { status, body } = await notifyResponders(seeded._id, sign(userId));

  assert.equal(status, 409);
  assert.equal(body.error.code, 'ESCALATION_ALREADY_PROGRESS');

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels[1].type, 'POLICE', 'police escalation is untouched');
});

dbTest('notification succeeds without initializing Socket.IO and keeps the state', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();

  const { status, body } = await notifyResponders(seeded._id, sign(userId));

  assert.equal(status, 200, 'delivery is best effort over HTTP');
  assert.throws(() => getIO(), /has not been initialized/);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.escalation.levels[1].status, 'PENDING', 'state recovers through the GET API');
});

dbTest('the armed timeout moves PENDING to TIMEOUT exactly once', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();
  await notifyResponders(seeded._id, sign(userId));

  const fired = await runResponderTimeout({ sosId: String(seeded._id) });
  assert.equal(fired, true);

  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels[1].status, 'TIMEOUT');
  assert.equal(doc.status, 'ACTIVE', 'the SOS is still active after the responder timeout');
  assert.equal(
    doc.escalation.levels[2]?.type,
    'POLICE',
    'the expiry continues into the existing police escalation (§19)'
  );

  const again = await runResponderTimeout({ sosId: String(seeded._id) });
  assert.equal(again, false, 'a late timer never rewrites a terminal level');
});

dbTest('an acknowledged responder level is never overwritten by the timeout', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();
  await notifyResponders(seeded._id, sign(userId));

  const responderId = getNearbyResponders().responders[0].id;
  const ack = await post(
    '/api/v1/sos/' + seeded._id + '/escalation/acknowledge',
    sign(responderId),
    { level: 'NEARBY_RESPONDER' }
  );
  assert.equal(ack.status, 200, 'the responder acknowledged through the existing endpoint');

  const fired = await runResponderTimeout({ sosId: String(seeded._id) });

  assert.equal(fired, false, 'acknowledgement and timeout can never both win');
  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels[1].status, 'ACKNOWLEDGED');
  assert.equal(doc.status, 'ACKNOWLEDGED');
});

dbTest('a SOS cancelled after notification never escalates further', async () => {
  const { userId, seeded } = await seedGuardianTimedOut();
  const { status, body } = await notifyResponders(seeded._id, sign(userId));
  assert.equal(status, 200);

  await SosEvent.updateOne({ _id: seeded._id }, { $set: { status: 'CANCELLED' } });

  const fired = await runResponderTimeout({ sosId: String(seeded._id) });

  assert.equal(fired, false, 'a cancelled SOS never escalates further');
  const doc = await SosEvent.findById(seeded._id).lean();
  assert.equal(doc.escalation.levels[1].status, 'PENDING', 'no police escalation happened');
});
