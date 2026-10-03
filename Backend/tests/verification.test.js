import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { SosEvent } from '../src/modules/sos/sos.model.js';
import {
  createSOS,
  confirmSOS,
  cancelSOS,
  runVerificationTimeout,
} from '../src/modules/sos/sos.service.js';
import { SOS_EVENT, SOS_LIFECYCLE_EVENT } from '../src/modules/sos/sos.events.js';
import { getIO } from '../src/sockets/index.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0e1';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0e3';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0e4';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Shared `sequence` recorder: repository writes, scheduling, emissions and
 * escalation hand-offs all push their step into ONE array, so ordering
 * assertions (§10: persist -> emit -> escalate) read directly from it.
 */
const makeEmit = (sequence = []) => {
  const calls = [];
  return {
    calls,
    fn: async (userId, event, payload) => {
      calls.push({ userId, event, payload });
      sequence.push('emit');
    },
    events: () => calls.map((call) => call.event),
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

const makeEscalation = (sequence = []) => {
  const calls = [];
  return {
    calls,
    fn: async (args) => {
      calls.push(args);
      sequence.push('escalate');
      return { sosId: String(args.sosId), level: 'GUARDIAN', status: 'PENDING', targetId: null };
    },
  };
};

const verifyingSos = (overrides = {}) => ({
  _id: SOS_ID,
  userId: OWNER_ID,
  status: 'VERIFYING',
  triggerType: 'VOICE_DANGER',
  triggerData: { riskLevel: 'HIGH', confidence: 0.91, reason: 'Potential danger detected' },
  location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
  verification: {
    expiresAt: new Date(Date.now() + 10000),
    userResponse: null,
    respondedAt: null,
  },
  escalation: { currentLevel: 0, levels: [] },
  createdAt: new Date('2026-10-02T12:00:00.000Z'),
  ...overrides,
});

/**
 * Fake SOS repository: records every call in `sequence`, keeps an in-memory
 * document for the atomic verification transitions, and exposes ONLY the
 * methods the verification flow may touch — anything else throws.
 */
const makeRepository = ({ doc = null, sequence = [] } = {}) => {
  const state = { doc, activateCalls: 0 };

  const repo = {
    state,
    sequence,
    findUnresolvedSOS: async () => {
      sequence.push('findUnresolved');
      return null;
    },
    createSOS: async (data) => {
      sequence.push('create');
      state.doc = { _id: SOS_ID, createdAt: new Date(), ...data };
      return state.doc;
    },
    confirmAndActivate: async ({ userId, respondedAt }) => {
      sequence.push('db');
      if (!state.doc || state.doc.status !== 'VERIFYING') return null;
      if (String(state.doc.userId) !== String(userId)) return null;
      state.doc = {
        ...state.doc,
        status: 'ACTIVE',
        verification: { ...state.doc.verification, userResponse: 'CONFIRMED', respondedAt },
      };
      return state.doc;
    },
    cancelAndRecord: async ({ userId, respondedAt }) => {
      sequence.push('db');
      if (!state.doc || state.doc.status !== 'VERIFYING') return null;
      if (String(state.doc.userId) !== String(userId)) return null;
      state.doc = {
        ...state.doc,
        status: 'CANCELLED',
        verification: { ...state.doc.verification, userResponse: 'CANCELLED', respondedAt },
      };
      return state.doc;
    },
    activateOnVerificationTimeout: async ({ timedOutAt }) => {
      sequence.push('db');
      state.activateCalls += 1;
      if (!state.doc || state.doc.status !== 'VERIFYING') return null;
      state.doc = {
        ...state.doc,
        status: 'ACTIVE',
        verification: { ...state.doc.verification, userResponse: 'TIMEOUT', respondedAt: timedOutAt },
      };
      return state.doc;
    },
    findByIdAndUserId: async (sosId, userId) =>
      state.doc && String(state.doc._id) === String(sosId) && String(state.doc.userId) === String(userId)
        ? state.doc
        : null,
  };

  return repo;
};

const makeDependencies = ({ settings = null, session = null } = {}) => ({
  findSafetySessionById: async () => session,
  getUserEmergencySettings: async () => settings,
});

// ---------- verification creation (#1–#4) ----------

test('creation notifies the owner and arms the backend timer from the same timeout', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence });
  const emit = makeEmit(sequence);
  const schedule = makeSchedule(sequence);

  const result = await createSOS({
    userId: OWNER_ID,
    payload: {
      triggerType: 'VOICE_DANGER',
      triggerData: { riskLevel: 'HIGH', confidence: 0.91, reason: 'Potential danger detected' },
      location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
    },
    repository,
    dependencies: makeDependencies(),
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    startEscalation: makeEscalation().fn,
  });

  assert.equal(result.created, true);
  assert.equal(result.sos.status, 'VERIFYING');

  assert.deepEqual(
    sequence,
    ['findUnresolved', 'create', 'schedule', 'emit'],
    'persist -> arm the backend timer -> notify (#4 before #2)'
  );
  assert.equal(schedule.calls.length, 1, 'the verification timeout is armed (#4)');
  assert.equal(schedule.calls[0].ms, 10000, 'default sosTimeoutSeconds = 10');

  assert.deepEqual(emit.events(), [SOS_EVENT.VERIFICATION_REQUIRED], '#2 the event is emitted');
  const call = emit.calls[0];
  assert.equal(call.userId, OWNER_ID, '#28 only the owner room');

  const payload = call.payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['location', 'sosId', 'status', 'timestamp', 'triggerData', 'triggerType', 'verification']
  );
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.status, 'VERIFYING');
  assert.equal(payload.triggerType, 'VOICE_DANGER');
  assert.deepEqual(payload.triggerData, {
    riskLevel: 'HIGH',
    confidence: 0.91,
    reason: 'Potential danger detected',
  });
  assert.deepEqual(payload.location, { lat: 19.31, lng: 84.79 }, 'address stays out (#13 privacy)');
  assert.equal(payload.verification.timeoutSeconds, 10, '#3 timeoutSeconds');
  assert.equal(
    payload.verification.expiresAt,
    new Date(result.sos.verification.expiresAt).toISOString(),
    '#3 expiresAt matches the persisted window'
  );
  assert.ok(!JSON.stringify(payload).includes('address'));
  assert.ok(!JSON.stringify(payload).includes('safetySessionId'));
  assert.ok(!JSON.stringify(payload).includes('escalation'));
});

test('emergencySettings.sosTimeoutSeconds drives both expiresAt and the armed timer', async () => {
  const repository = makeRepository();
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await createSOS({
    userId: OWNER_ID,
    payload: { triggerType: 'OFF_ROUTE' },
    repository,
    dependencies: makeDependencies({ settings: { sosTimeoutSeconds: 25 } }),
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    startEscalation: makeEscalation().fn,
  });

  assert.equal(schedule.calls[0].ms, 25000, '§4: existing configuration, no second system');
  assert.equal(emit.calls[0].payload.verification.timeoutSeconds, 25);
  assert.equal(
    new Date(result.sos.verification.expiresAt).getTime() - Date.now() >= 24000,
    true
  );
});

test('a duplicate create arms no timer and emits nothing (#11)', async () => {
  const existing = verifyingSos();
  const repository = makeRepository();
  repository.findUnresolvedSOS = async () => existing;
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await createSOS({
    userId: OWNER_ID,
    payload: { triggerType: 'VOICE_DANGER' },
    repository,
    dependencies: makeDependencies(),
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    startEscalation: makeEscalation().fn,
  });

  assert.equal(result.created, false);
  assert.equal(result.sos, existing);
  assert.equal(schedule.calls.length, 0);
  assert.equal(emit.calls.length, 0);
});

test('the armed task is the real timeout handler (no response -> activate)', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence });
  const emit = makeEmit(sequence);
  const schedule = makeSchedule(sequence);
  const escalation = makeEscalation(sequence);

  await createSOS({
    userId: OWNER_ID,
    payload: { triggerType: 'LONG_STOP' },
    repository,
    dependencies: makeDependencies(),
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    startEscalation: escalation.fn,
  });

  // Nobody answers: run the exact callback the timer was armed with.
  await schedule.calls[0].task();

  assert.equal(repository.state.doc.status, 'ACTIVE', '#16 VERIFYING -> ACTIVE');
  assert.equal(repository.state.doc.verification.userResponse, 'TIMEOUT', 'the timeout is recorded');
  assert.deepEqual(
    emit.events(),
    [SOS_EVENT.VERIFICATION_REQUIRED, SOS_EVENT.TIMEOUT, SOS_LIFECYCLE_EVENT.ACTIVATED],
    '#17 sos:timeout, then the lifecycle sos:activated (after the creation notification)'
  );
  assert.deepEqual(escalation.calls, [{ sosId: SOS_ID, userId: OWNER_ID }], '#18 escalation continues');
  assert.deepEqual(
    sequence,
    ['findUnresolved', 'create', 'schedule', 'emit', 'db', 'emit', 'emit', 'escalate'],
    '#10: create -> arm -> notify, then later persist -> timeout -> activated -> escalation'
  );
});

// ---------- confirmation (#5–#9) ----------

test('confirmation emits sos:confirmed only after the database transition', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence, doc: verifyingSos() });
  const emit = makeEmit(sequence);

  await confirmSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });

  assert.deepEqual(sequence, ['db', 'emit', 'emit'], '#7/#10: persist first, then notify');
  assert.deepEqual(
    emit.events(),
    [SOS_EVENT.CONFIRMED, SOS_LIFECYCLE_EVENT.ACTIVATED],
    'sos:confirmed first, lifecycle sos:activated right after it'
  );
  assert.equal(emit.calls[0].userId, OWNER_ID, '#28 owner room only');

  const payload = emit.calls[0].payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['confirmedAt', 'previousStatus', 'sosId', 'status', 'timestamp', 'triggerType']
  );
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.status, 'ACTIVE', '#6 VERIFYING -> ACTIVE');
  assert.equal(payload.previousStatus, 'VERIFYING');
  assert.equal(payload.triggerType, 'VOICE_DANGER');
  assert.ok(payload.confirmedAt);
  assert.equal(payload.timestamp, payload.confirmedAt);
  assert.equal(repository.state.doc.status, 'ACTIVE');
});

test('confirmation cancels the armed verification timer before it can fire (#8)', async () => {
  const repository = makeRepository({ doc: verifyingSos() });
  const emit = makeEmit();
  const scheduled = [];

  await createSOS({
    userId: OWNER_ID,
    payload: { triggerType: 'VOICE_DANGER' },
    repository,
    dependencies: makeDependencies(),
    emit: emit.fn,
    // Real (but tiny) timers, so cancellation is observable behaviour.
    scheduleTimeout: (task, ms) => {
      const handle = setTimeout(task, 50);
      scheduled.push({ handle, ms });
      return handle;
    },
    startEscalation: makeEscalation().fn,
  });

  await confirmSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });

  await sleep(120);

  assert.equal(repository.state.activateCalls, 0, 'the fired timer never activated the SOS');
  assert.equal(emit.events().filter((e) => e === SOS_EVENT.TIMEOUT).length, 0, 'no sos:timeout');
  assert.equal(repository.state.doc.status, 'ACTIVE');
  assert.equal(repository.state.doc.verification.userResponse, 'CONFIRMED', 'the confirmation stands');
});

test('a failed confirmation emits nothing (#30)', async () => {
  const repository = makeRepository({ doc: verifyingSos({ status: 'ACTIVE' }) });
  const emit = makeEmit();

  const err = await confirmSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn }).then(
    () => null,
    (e) => e
  );

  assert.equal(err.statusCode, 409);
  assert.equal(err.code, 'SOS_NOT_VERIFYING');
  assert.equal(emit.calls.length, 0, 'no event for a failed state transition');
  assert.deepEqual(repository.sequence, ['db'], 'the conditional write missed and nothing else ran');
});

test('a foreign or missing SOS confirms with 404 and emits nothing (#26/#30)', async () => {
  const repository = makeRepository({ doc: verifyingSos() });
  const emit = makeEmit();

  const err = await confirmSOS({ sosId: SOS_ID, userId: STRANGER_ID, repository, emit: emit.fn }).then(
    () => null,
    (e) => e
  );

  assert.equal(err.statusCode, 404);
  assert.equal(err.code, 'SOS_NOT_FOUND');
  assert.equal(emit.calls.length, 0);
  assert.equal(repository.state.doc.status, 'VERIFYING', 'the owner SOS is untouched');
});

// ---------- cancellation (#10–#14) ----------

test('cancellation emits sos:cancelled with the user reason and starts nothing', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence, doc: verifyingSos() });
  const emit = makeEmit(sequence);

  await cancelSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });

  assert.deepEqual(sequence, ['db', 'emit'], '#10/#12: persist first, then notify');
  assert.deepEqual(emit.events(), [SOS_EVENT.CANCELLED]);
  assert.equal(emit.calls[0].userId, OWNER_ID, '#28 owner room only');

  const payload = emit.calls[0].payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['cancelledAt', 'previousStatus', 'reason', 'sosId', 'status', 'timestamp', 'triggerType']
  );
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.status, 'CANCELLED', '#11 VERIFYING -> CANCELLED');
  assert.equal(payload.previousStatus, 'VERIFYING');
  assert.equal(payload.reason, 'USER_CANCELLED');
  assert.equal(repository.state.doc.status, 'CANCELLED');
  assert.deepEqual(repository.state.doc.escalation.levels, [], '#13 no escalation exists or starts');
});

test('cancellation cancels the armed verification timer (#14)', async () => {
  const repository = makeRepository({ doc: verifyingSos() });
  const emit = makeEmit();

  await createSOS({
    userId: OWNER_ID,
    payload: { triggerType: 'VOICE_DANGER' },
    repository,
    dependencies: makeDependencies(),
    emit: emit.fn,
    scheduleTimeout: (task) => setTimeout(task, 50),
    startEscalation: makeEscalation().fn,
  });

  await cancelSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });

  await sleep(120);

  assert.equal(repository.state.activateCalls, 0, 'the old timer cannot activate the SOS');
  assert.equal(emit.events().filter((e) => e === SOS_EVENT.TIMEOUT).length, 0);
  assert.equal(repository.state.doc.status, 'CANCELLED', 'the cancellation stands');
});

test('a failed cancellation emits nothing (#30)', async () => {
  const repository = makeRepository({ doc: verifyingSos({ status: 'CANCELLED' }) });
  const emit = makeEmit();

  const err = await cancelSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn }).then(
    () => null,
    (e) => e
  );

  assert.equal(err.statusCode, 409);
  assert.equal(err.code, 'SOS_NOT_VERIFYING');
  assert.equal(emit.calls.length, 0);
});

// ---------- timeout (#15–#18) ----------

test('runVerificationTimeout activates, notifies and hands over to escalation', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence, doc: verifyingSos() });
  const emit = makeEmit(sequence);
  const escalation = makeEscalation(sequence);

  const won = await runVerificationTimeout({
    sosId: SOS_ID,
    repository,
    emit: emit.fn,
    startEscalation: escalation.fn,
  });

  assert.equal(won, true, '#15/#16 the timer wins a still-VERIFYING SOS');
  assert.deepEqual(
    sequence,
    ['db', 'emit', 'emit', 'escalate'],
    '#10: persist -> sos:timeout -> sos:activated -> escalation'
  );
  assert.equal(repository.state.doc.status, 'ACTIVE');
  assert.equal(repository.state.doc.verification.userResponse, 'TIMEOUT');
  assert.equal(
    repository.state.doc.triggerType,
    'VOICE_DANGER',
    '#17 the original trigger is preserved'
  );

  assert.deepEqual(
    emit.events(),
    [SOS_EVENT.TIMEOUT, SOS_LIFECYCLE_EVENT.ACTIVATED],
    '#17 the event is emitted, lifecycle activation follows'
  );
  const payload = emit.calls[0].payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['previousStatus', 'reason', 'sosId', 'status', 'timedOutAt', 'timestamp', 'triggerType']
  );
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.status, 'ACTIVE');
  assert.equal(payload.previousStatus, 'VERIFYING');
  assert.equal(payload.reason, 'VERIFICATION_TIMEOUT');
  assert.ok(payload.timedOutAt);
  assert.equal(payload.triggerType, 'VOICE_DANGER');
  assert.equal(emit.calls[0].userId, OWNER_ID, '#28 owner room only');

  assert.deepEqual(escalation.calls, [{ sosId: SOS_ID, userId: OWNER_ID }], '#18 existing workflow');
});

test('the timeout event is emitted before escalation starts (#10 order)', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence, doc: verifyingSos() });
  const emit = makeEmit(sequence);
  const escalation = makeEscalation(sequence);

  await runVerificationTimeout({
    sosId: SOS_ID,
    repository,
    emit: emit.fn,
    startEscalation: escalation.fn,
  });

  assert.deepEqual(sequence, ['db', 'emit', 'emit', 'escalate']);
  assert.equal(emit.events()[0], SOS_EVENT.TIMEOUT);
  assert.equal(emit.events()[1], SOS_LIFECYCLE_EVENT.ACTIVATED);
});

test('a timeout that lost to confirm/cancel does nothing (#24/#25)', async () => {
  for (const winner of ['confirm', 'cancel']) {
    const doc = verifyingSos();
    const repository = makeRepository({ doc });
    const emit = makeEmit();
    const escalation = makeEscalation();

    if (winner === 'confirm') {
      await confirmSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });
    } else {
      await cancelSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });
    }

    const won = await runVerificationTimeout({
      sosId: SOS_ID,
      repository,
      emit: emit.fn,
      startEscalation: escalation.fn,
    });

    assert.equal(won, false, `${winner}: the transition is already decided`);
    assert.equal(
      emit.events().filter((event) => event === SOS_EVENT.TIMEOUT).length,
      0,
      `${winner}: no timeout event`
    );
    assert.equal(escalation.calls.length, 0, `${winner}: escalation only runs after a real activation`);
    assert.equal(repository.state.doc.status, winner === 'confirm' ? 'ACTIVE' : 'CANCELLED');
    assert.equal(
      repository.state.doc.verification.userResponse,
      winner === 'confirm' ? 'CONFIRMED' : 'CANCELLED',
      'the winner response is never overwritten'
    );
  }
});

test('a socket failure never rolls back the timeout activation (#29)', async () => {
  const repository = makeRepository({ doc: verifyingSos() });
  const escalation = makeEscalation();

  const won = await runVerificationTimeout({
    sosId: SOS_ID,
    repository,
    emit: async () => {
      throw new Error('socket is down');
    },
    startEscalation: escalation.fn,
  });

  assert.equal(won, true, 'the database transition already succeeded');
  assert.equal(repository.state.doc.status, 'ACTIVE', 'state is authoritative');
  assert.equal(repository.state.doc.verification.userResponse, 'TIMEOUT');
  assert.equal(escalation.calls.length, 1, 'escalation still starts');
});

test('an escalation failure never rolls back the timeout activation', async () => {
  const repository = makeRepository({ doc: verifyingSos() });
  const emit = makeEmit();

  const won = await runVerificationTimeout({
    sosId: SOS_ID,
    repository,
    emit: emit.fn,
    startEscalation: async () => {
      throw new Error('no guardian reachable');
    },
  });

  assert.equal(won, true);
  assert.equal(repository.state.doc.status, 'ACTIVE');
  assert.deepEqual(
    emit.events(),
    [SOS_EVENT.TIMEOUT, SOS_LIFECYCLE_EVENT.ACTIVATED]
  );
});

// ---------- races (#19–#25, database-backed) ----------

const createdUserIds = [];

const sign = (userId) =>
  jwt.sign({ sub: userId, role: 'USER' }, env.jwtSecret, { expiresIn: '5m' });

const newAccountId = () => {
  const id = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(id);
  return id;
};

const seedVerifying = async ({ status = 'VERIFYING' } = {}) => {
  const userId = newAccountId();
  const sos = await SosEvent.create({
    userId,
    triggerType: 'VOICE_DANGER',
    status,
    triggerData: { riskLevel: 'HIGH', confidence: 0.9, reason: 'left route' },
    location: { lat: 19.31, lng: 84.79 },
    verification: {
      expiresAt: new Date(Date.now() + 60000),
      userResponse: null,
      respondedAt: null,
    },
    escalation: { currentLevel: 0, levels: [] },
  });

  return { userId, sosId: String(sos._id) };
};

const settle = (promise) => promise.then(() => 'ok', (err) => err.code);

dbTest('confirm and timeout race: exactly one transition wins (#19)', async () => {
  const { userId, sosId } = await seedVerifying();
  const emit = makeEmit();
  const escalation = makeEscalation();

  const [confirmOutcome] = await Promise.all([
    settle(confirmSOS({ sosId, userId, emit: emit.fn })),
    runVerificationTimeout({ sosId, emit: emit.fn, startEscalation: escalation.fn }),
  ]);

  const events = emit.events();
  assert.equal(events.length, 2, 'exactly one transition: its event + the lifecycle activation (#11)');
  assert.ok([SOS_EVENT.CONFIRMED, SOS_EVENT.TIMEOUT].includes(events[0]));
  assert.equal(events[1], SOS_LIFECYCLE_EVENT.ACTIVATED, 'activation follows the winning event');

  const timeoutWon = events[0] === SOS_EVENT.TIMEOUT;
  assert.equal(confirmOutcome, timeoutWon ? 'SOS_NOT_VERIFYING' : 'ok');
  assert.equal(escalation.calls.length, timeoutWon ? 1 : 0, 'escalation only after timeout activation');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.verification.userResponse, timeoutWon ? 'TIMEOUT' : 'CONFIRMED');
  assert.equal(doc.triggerType, 'VOICE_DANGER', '#17 trigger information preserved');
});

dbTest('cancel and timeout race: exactly one transition wins (#20)', async () => {
  const { userId, sosId } = await seedVerifying();
  const emit = makeEmit();
  const escalation = makeEscalation();

  const [cancelOutcome] = await Promise.all([
    settle(cancelSOS({ sosId, userId, emit: emit.fn })),
    runVerificationTimeout({ sosId, emit: emit.fn, startEscalation: escalation.fn }),
  ]);

  const events = emit.events();
  const timeoutWon = events[0] === SOS_EVENT.TIMEOUT;
  assert.deepEqual(
    events,
    timeoutWon
      ? [SOS_EVENT.TIMEOUT, SOS_LIFECYCLE_EVENT.ACTIVATED]
      : [SOS_EVENT.CANCELLED],
    'exactly one transition notifies (#11); only activation adds the lifecycle event'
  );
  assert.equal(cancelOutcome, timeoutWon ? 'SOS_NOT_VERIFYING' : 'ok');
  assert.equal(escalation.calls.length, timeoutWon ? 1 : 0, 'a cancelled SOS never escalates (#22)');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, timeoutWon ? 'ACTIVE' : 'CANCELLED');
  assert.equal(doc.verification.userResponse, timeoutWon ? 'TIMEOUT' : 'CANCELLED');
});

dbTest('confirm and cancel race: exactly one transition wins (#21)', async () => {
  const { userId, sosId } = await seedVerifying();
  const emit = makeEmit();

  const [confirmOutcome, cancelOutcome] = await Promise.all([
    settle(confirmSOS({ sosId, userId, emit: emit.fn })),
    settle(cancelSOS({ sosId, userId, emit: emit.fn })),
  ]);

  assert.deepEqual([confirmOutcome, cancelOutcome].sort(), ['SOS_NOT_VERIFYING', 'ok']);

  const confirmWon = confirmOutcome === 'ok';
  const events = emit.events();
  assert.deepEqual(
    events,
    confirmWon
      ? [SOS_EVENT.CONFIRMED, SOS_LIFECYCLE_EVENT.ACTIVATED]
      : [SOS_EVENT.CANCELLED],
    'exactly one transition notifies (#11)'
  );

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, confirmWon ? 'ACTIVE' : 'CANCELLED');
  assert.equal(doc.verification.userResponse, confirmWon ? 'CONFIRMED' : 'CANCELLED');
  assert.ok(doc.verification.respondedAt, 'the winner records a response exactly once');
});

dbTest('duplicate confirmations notify once (#22)', async () => {
  const { userId, sosId } = await seedVerifying();
  const emit = makeEmit();

  const first = await confirmSOS({ sosId, userId, emit: emit.fn });
  const second = await settle(confirmSOS({ sosId, userId, emit: emit.fn }));

  assert.equal(first.status, 'ACTIVE');
  assert.equal(second, 'SOS_NOT_VERIFYING', 'the second request is refused, not repeated');
  assert.equal(emit.events().filter((e) => e === SOS_EVENT.CONFIRMED).length, 1);

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.verification.userResponse, 'CONFIRMED');
});

dbTest('duplicate cancellations notify once (#23)', async () => {
  const { userId, sosId } = await seedVerifying();
  const emit = makeEmit();

  const first = await cancelSOS({ sosId, userId, emit: emit.fn });
  const second = await settle(cancelSOS({ sosId, userId, emit: emit.fn }));

  assert.equal(first.status, 'CANCELLED');
  assert.equal(second, 'SOS_NOT_VERIFYING');
  assert.equal(emit.events().filter((e) => e === SOS_EVENT.CANCELLED).length, 1);

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'CANCELLED');
  assert.equal(doc.verification.userResponse, 'CANCELLED');
});

dbTest('the timeout after a successful confirmation is a no-op (#24)', async () => {
  const { userId, sosId } = await seedVerifying();
  const emit = makeEmit();
  const escalation = makeEscalation();

  await confirmSOS({ sosId, userId, emit: emit.fn });
  const won = await runVerificationTimeout({ sosId, emit: emit.fn, startEscalation: escalation.fn });

  assert.equal(won, false);
  assert.equal(emit.events().filter((e) => e === SOS_EVENT.TIMEOUT).length, 0);
  assert.equal(escalation.calls.length, 0);

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.verification.userResponse, 'CONFIRMED');
  assert.deepEqual(doc.escalation.levels, [], 'no escalation was started twice or wrongly');
});

dbTest('the timeout after a successful cancellation is a no-op (#25)', async () => {
  const { userId, sosId } = await seedVerifying();
  const emit = makeEmit();
  const escalation = makeEscalation();

  await cancelSOS({ sosId, userId, emit: emit.fn });
  const won = await runVerificationTimeout({ sosId, emit: emit.fn, startEscalation: escalation.fn });

  assert.equal(won, false);
  assert.equal(emit.events().filter((e) => e === SOS_EVENT.TIMEOUT).length, 0);
  assert.equal(escalation.calls.length, 0, 'a cancelled SOS never escalates (#13)');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'CANCELLED');
  assert.equal(doc.verification.userResponse, 'CANCELLED');
});

dbTest('a timeout activates the SOS and continues into the existing escalation workflow (#18)', async () => {
  const { userId, sosId } = await seedVerifying();
  const emit = makeEmit();

  const won = await runVerificationTimeout({ sosId, emit: emit.fn });

  assert.equal(won, true);

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(doc.verification.userResponse, 'TIMEOUT');
  assert.equal(doc.triggerType, 'VOICE_DANGER', '#17 not overwritten with TIMEOUT');
  assert.deepEqual(doc.triggerData, { riskLevel: 'HIGH', confidence: 0.9, reason: 'left route' });

  // The REAL escalation service took over: with no guardian configured for
  // this account it records its own guardian level state — verification
  // never duplicates guardian selection or escalation timers.
  assert.equal(doc.escalation.levels.length, 1, 'the escalation workflow started');
  assert.equal(doc.escalation.levels[0].type, 'GUARDIAN');
  assert.equal(doc.escalation.currentLevel, 0);
});

// ---------- HTTP endpoints (#5, #10, #26, #27, #29) ----------

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

const confirmSos = (sosId, token) => post('/api/v1/sos/' + sosId + '/confirm', token, {});
const cancelSos = (sosId, token) => post('/api/v1/sos/' + sosId + '/cancel', token, {});

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

dbTest('an automatic safety trigger creates a VERIFYING SOS (#1)', async () => {
  const userId = newAccountId();
  const token = sign(userId);

  const { status, body } = await post('/api/v1/sos', token, {
    triggerType: 'VOICE_DANGER',
    triggerData: { riskLevel: 'HIGH', confidence: 0.91, reason: 'distress detected' },
    location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
  });

  assert.equal(status, 201);
  assert.equal(body.data.status, 'VERIFYING');
  assert.ok(body.data.verification.expiresAt, '#3 the verification window is persisted');
  assert.equal(body.data.verification.userResponse, null);
  assert.throws(() => getIO(), /has not been initialized/, 'HTTP-only process stays socket-free');
});

dbTest('the HTTP confirm flow works without a socket layer (#5/#29)', async () => {
  const { userId, sosId } = await seedVerifying();

  const { status, body } = await confirmSos(sosId, sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.status, 'ACTIVE');
  assert.equal(body.data.verification.userResponse, 'CONFIRMED');
  assert.throws(() => getIO(), /has not been initialized/, 'a missing socket layer never fails the request');

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'ACTIVE');
  assert.deepEqual(doc.escalation.levels, [], 'verification itself never starts escalation');
});

dbTest('the HTTP cancel flow cancels nobody and nothing (#10/#13)', async () => {
  const { userId, sosId } = await seedVerifying();

  const { status, body } = await cancelSos(sosId, sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.status, 'CANCELLED');
  assert.equal(body.data.verification.userResponse, 'CANCELLED');
  assert.throws(() => getIO(), /has not been initialized/);

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'CANCELLED');
  assert.deepEqual(doc.escalation.levels, [], 'no guardian, responder or police escalation');
});

dbTest('unauthenticated users cannot confirm or cancel (#26)', async () => {
  const { sosId } = await seedVerifying();

  const confirm = await confirmSos(sosId, null);
  const cancel = await cancelSos(sosId, null);

  assert.equal(confirm.status, 401);
  assert.equal(confirm.body.error.code, 'UNAUTHENTICATED');
  assert.equal(cancel.status, 401);
  assert.equal(cancel.body.error.code, 'UNAUTHENTICATED');
});

dbTest('another user cannot confirm or cancel someone else verification (#27)', async () => {
  const { sosId } = await seedVerifying();
  const stranger = sign(newAccountId());

  const foreignConfirm = await confirmSos(sosId, stranger);
  const missingConfirm = await confirmSos(new mongoose.Types.ObjectId().toString(), stranger);
  const foreignCancel = await cancelSos(sosId, stranger);

  assert.equal(foreignConfirm.status, 404);
  assert.deepEqual(foreignConfirm.body, missingConfirm.body, 'no resource enumeration');
  assert.equal(foreignCancel.status, 404);

  const doc = await SosEvent.findById(sosId).lean();
  assert.equal(doc.status, 'VERIFYING', 'the owner SOS is untouched');
  assert.equal(doc.verification.userResponse, null);
});
