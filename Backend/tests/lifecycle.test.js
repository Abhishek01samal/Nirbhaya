import test from 'node:test';
import assert from 'node:assert/strict';

import {
  confirmSOS,
  cancelSOS,
  resolveSOS,
  acknowledgeSOS,
  runVerificationTimeout,
} from '../src/modules/sos/sos.service.js';
import {
  startGuardianEscalation,
  acknowledgeEscalation,
  startResponderEscalation,
  escalateToPolice,
} from '../src/modules/sos/escalation.service.js';
import { SOS_EVENT, SOS_LIFECYCLE_EVENT, RESPONDER_SOS_EVENT } from '../src/modules/sos/sos.events.js';

/**
 * Owner-room lifecycle events (§3–§16): sos:activated, sos:guardian-notified,
 * sos:guardian-acknowledged, sos:escalating, sos:resolved.
 *
 * Every test below drives the REAL service functions with recording fakes and
 * asserts the invariants the spec cares about: emitted only after the atomic
 * write, exactly in the documented order relative to the detailed events,
 * private owner room only, exact payload key sets, and silence for losers,
 * refusals, empty recipient sets and cancelled flights.
 */

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0a1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0a2';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0a3';
const RESPONDER_1 = 'responder-001';
const RESPONDER_2 = 'responder-002';

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

const lifecycleCalls = (emit) =>
  emit.calls.filter((call) => Object.values(SOS_LIFECYCLE_EVENT).includes(call.event));

// ---------- fakes: verification / acknowledge / resolve (sos.service) ------

const verifyingDoc = () => ({
  _id: SOS_ID,
  userId: OWNER_ID,
  status: 'VERIFYING',
  triggerType: 'VOICE_DANGER',
  triggerData: { riskLevel: 'HIGH' },
  location: { lat: 19.31, lng: 84.79, address: 'Cuttack, Odisha' },
  verification: { expiresAt: new Date(Date.now() + 60000), userResponse: null, respondedAt: null },
  escalation: { currentLevel: 0, levels: [] },
});

const acknowledgedDoc = () => ({
  _id: SOS_ID,
  userId: OWNER_ID,
  status: 'ACKNOWLEDGED',
  triggerType: 'MANUAL',
  location: { lat: 19.31, lng: 84.79, address: 'Cuttack, Odisha' },
  verification: { expiresAt: new Date(Date.now() - 60000), userResponse: 'CONFIRMED', respondedAt: new Date() },
  escalation: {
    currentLevel: 0,
    levels: [
      {
        type: 'GUARDIAN',
        status: 'ACKNOWLEDGED',
        targetId: GUARDIAN_ID,
        notifiedAt: new Date('2026-09-30T10:00:00.000Z'),
        respondedAt: new Date('2026-09-30T10:00:30.000Z'),
        expiresAt: new Date('2026-09-30T10:01:00.000Z'),
      },
    ],
  },
});

/** In-memory repository covering exactly the methods these flows touch.
 *  Reads return FRESH snapshots (like a real .lean() read) so a service that
 *  captured the pre-write document cannot see its own later mutation; every
 *  write pushes 'db' into the optional shared `sequence`. */
const makeSosRepository = (doc, sequence = null) => {
  const snapshot = () => ({
    ...doc,
    verification: { ...doc.verification },
    escalation: {
      ...doc.escalation,
      levels: (doc.escalation?.levels ?? []).map((level) => ({ ...level })),
    },
  });
  const record = () => {
    if (sequence) sequence.push('db');
  };

  return {
    doc,
    findById: async () => snapshot(),
    findByIdAndUserId: async () => snapshot(),
    confirmAndActivate: async ({ respondedAt }) => {
      if (doc.status !== 'VERIFYING') return null;
      record();
      doc.status = 'ACTIVE';
      doc.verification = { ...doc.verification, userResponse: 'CONFIRMED', respondedAt };
      return doc;
    },
    cancelAndRecord: async ({ respondedAt }) => {
      if (doc.status !== 'VERIFYING') return null;
      record();
      doc.status = 'CANCELLED';
      doc.verification = { ...doc.verification, userResponse: 'CANCELLED', respondedAt };
      return doc;
    },
    activateOnVerificationTimeout: async ({ timedOutAt }) => {
      if (doc.status !== 'VERIFYING') return null;
      record();
      doc.status = 'ACTIVE';
      doc.verification = { ...doc.verification, userResponse: 'TIMEOUT', respondedAt: timedOutAt };
      return doc;
    },
    acknowledgeByRecipient: async ({ levelIndex, respondedAt }) => {
      if (doc.status !== 'ACTIVE' && doc.status !== 'ESCALATING') return null;
      const level = doc.escalation?.levels?.[levelIndex];
      if (!level || level.status === 'ACKNOWLEDGED') return null;
      record();
      doc.status = 'ACKNOWLEDGED';
      level.status = 'ACKNOWLEDGED';
      level.respondedAt = respondedAt;
      return doc;
    },
    resolveById: async ({ asOwner, levelIndex, resolvedAt }) => {
      if (doc.status !== 'ACKNOWLEDGED') return null;
      if (!asOwner && doc.escalation.levels[levelIndex]?.status !== 'ACKNOWLEDGED') return null;
      record();
      doc.status = 'RESOLVED';
      doc.resolvedAt = resolvedAt;
      return doc;
    },
  };
};

const profilesWith = (name = 'Guardian One') => ({
  findUserById: async (userId) => ({ _id: userId, name }),
});

const relationshipsOk = () => ({
  findRelationship: async () => ({ _id: 'rel-1', status: 'ACTIVE' }),
});

// ---------- fakes: escalation flows ----------------------------------------

const activeDoc = (overrides = {}) => ({
  _id: SOS_ID,
  userId: OWNER_ID,
  status: 'ACTIVE',
  triggerType: 'MANUAL',
  location: { lat: 19.31, lng: 84.79, address: 'Cuttack, Odisha' },
  escalation: { currentLevel: 0, levels: [] },
  ...overrides,
});

const guardianLevel = (status = 'PENDING') => ({
  type: 'GUARDIAN',
  status,
  targetId: status === 'PENDING' ? GUARDIAN_ID : null,
  notifiedAt: status === 'PENDING' ? new Date() : null,
  respondedAt: null,
  expiresAt: status === 'PENDING' ? new Date(Date.now() + 60000) : null,
});

const makeGuardianRepository = () => ({
  findActiveGuardians: async () => [{ guardianUserId: GUARDIAN_ID, priority: 1, status: 'ACTIVE' }],
  findUserById: async (userId) => ({ _id: userId, name: userId === OWNER_ID ? 'Ansuman' : 'Guardian One' }),
});

/** findById cursor for flows that re-read (classify, write, still-valid gate).
 *  Writes push 'write' into the optional shared `sequence`. */
const makeEscalationRepository = ({ finds, sequence = null, onStart = null, onAck = null }) => {
  const calls = { start: [], ack: [], escalate: [] };
  const record = () => {
    if (sequence) sequence.push('write');
  };
  let cursor = 0;
  return {
    calls,
    findById: async () => {
      const index = Math.min(cursor, finds.length - 1);
      cursor += 1;
      return finds[index] ?? null;
    },
    startGuardianEscalation: async ({ level }) => {
      calls.start.push(level);
      record();
      if (onStart) return onStart(level);
      return activeDoc({ escalation: { currentLevel: 0, levels: [level] } });
    },
    acknowledgeEscalationLevel: async ({ levelIndex, respondedAt }) => {
      if (onAck) return onAck(respondedAt);
      record();
      const levels = finds[0].escalation.levels.map((level, index) =>
        index === levelIndex ? { ...level, status: 'ACKNOWLEDGED', respondedAt } : { ...level }
      );
      return activeDoc({
        status: 'ACKNOWLEDGED',
        escalation: { currentLevel: levelIndex, levels },
      });
    },
    startResponderEscalation: async ({ level }) => {
      calls.start.push(level);
      record();
      return activeDoc({
        escalation: {
          currentLevel: 1,
          levels: [finds[0].escalation.levels[0], level],
        },
      });
    },
    escalateToPolice: async ({ level }) => {
      calls.escalate.push(level);
      record();
      return activeDoc({
        escalation: {
          currentLevel: 2,
          levels: [
            finds[0].escalation.levels[0],
            finds[0].escalation.levels[1],
            level,
          ],
        },
      });
    },
  };
};

const responderPreDoc = () =>
  activeDoc({
    escalation: {
      currentLevel: 1,
      levels: [guardianLevel('TIMEOUT')],
    },
  });

const responderWrittenDoc = (level) =>
  activeDoc({
    escalation: {
      currentLevel: 1,
      levels: [guardianLevel('TIMEOUT'), level],
    },
  });

const responderLevel = () => ({
  type: 'NEARBY_RESPONDER',
  status: 'PENDING',
  targetId: null,
  notifiedResponders: [RESPONDER_1, RESPONDER_2],
  notifiedAt: new Date(),
  respondedAt: null,
  expiresAt: new Date(Date.now() + 60000),
});

const emptyResponderLevel = () => ({
  type: 'NEARBY_RESPONDER',
  status: 'TIMEOUT',
  targetId: null,
  notifiedResponders: [],
  notifiedAt: null,
  respondedAt: null,
  expiresAt: null,
});

const policePreDoc = () =>
  activeDoc({
    escalation: {
      currentLevel: 2,
      levels: [guardianLevel('TIMEOUT'), { ...responderLevel(), status: 'TIMEOUT', notifiedResponders: [] }],
    },
  });

const policeLevel = () => ({
  type: 'POLICE',
  status: 'NOTIFIED',
  targetId: STATION.id,
  policeStation: { id: STATION.id, name: STATION.name, phone: STATION.phone },
  source: 'PROTOTYPE_HARDCODED',
  notifiedAt: new Date(),
  escalatedAt: new Date(),
  respondedAt: null,
  expiresAt: null,
});

const STATION = { id: 'PS-001', name: 'Lalbazar', phone: '100' };
const policeStation = () => ({ source: 'PROTOTYPE_HARDCODED', station: STATION });

const scheduleFake = (sequence = []) => (task, ms) => {
  if (sequence) sequence.push('schedule');
  return 'timer-handle';
};

// ---------- constants -------------------------------------------------------

test('the five lifecycle event names match the platform contract', () => {
  assert.deepEqual(SOS_LIFECYCLE_EVENT, {
    ACTIVATED: 'sos:activated',
    GUARDIAN_NOTIFIED: 'sos:guardian-notified',
    GUARDIAN_ACKNOWLEDGED: 'sos:guardian-acknowledged',
    ESCALATING: 'sos:escalating',
    RESOLVED: 'sos:resolved',
  });
  assert.notEqual(SOS_LIFECYCLE_EVENT.GUARDIAN_ACKNOWLEDGED, SOS_EVENT.GUARDIAN_ACKNOWLEDGED);
});

// ---------- sos:activated ---------------------------------------------------

test('confirmation emits sos:confirmed then sos:activated to the owner only', async () => {
  const repository = makeSosRepository(verifyingDoc());
  const emit = makeEmit();

  const updated = await confirmSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });

  assert.equal(updated.status, 'ACTIVE');
  assert.deepEqual(
    emit.events(),
    [SOS_EVENT.CONFIRMED, SOS_LIFECYCLE_EVENT.ACTIVATED],
    '§16: confirmed -> activated'
  );

  const call = emit.calls[1];
  assert.equal(call.userId, OWNER_ID, '§15: owner private room only');
  assert.deepEqual(
    Object.keys(call.payload).sort(),
    ['activatedAt', 'location', 'previousStatus', 'sosId', 'status', 'triggerType']
  );
  assert.equal(call.payload.sosId, SOS_ID);
  assert.equal(call.payload.status, 'ACTIVE');
  assert.equal(call.payload.previousStatus, 'VERIFYING');
  assert.equal(call.payload.triggerType, 'VOICE_DANGER');
  assert.deepEqual(call.payload.location, { lat: 19.31, lng: 84.79 }, 'lat/lng only, no address');
  assert.equal(call.payload.activatedAt, new Date(call.payload.activatedAt).toISOString());

  const serialized = JSON.stringify(call.payload);
  for (const forbidden of ['address', 'safetySession', 'escalation', 'triggerData', 'password']) {
    assert.ok(!serialized.includes(forbidden), `payload must not carry ${forbidden}`);
  }
});

test('timeout activation emits sos:timeout, sos:activated, then hands over to escalation', async () => {
  const sequence = [];
  const emit = makeEmit(sequence);
  const verifyRepo = makeSosRepository(verifyingDoc(), sequence);

  const escDoc = activeDoc();
  const escRepo = makeEscalationRepository({ finds: [escDoc], sequence });

  const won = await runVerificationTimeout({
    sosId: SOS_ID,
    repository: verifyRepo,
    emit: emit.fn,
    startEscalation: (args) =>
      startGuardianEscalation({
        ...args,
        repository: escRepo,
        guardianRepository: makeGuardianRepository(),
        emit: emit.fn,
        scheduleTimeout: scheduleFake(),
        isOnline: () => true,
      }),
  });

  assert.equal(won, true);
  assert.equal(verifyRepo.doc.status, 'ACTIVE');

  assert.deepEqual(
    emit.events(),
    [
      SOS_EVENT.TIMEOUT,
      SOS_LIFECYCLE_EVENT.ACTIVATED,
      SOS_EVENT.GUARDIAN_NOTIFY,
      SOS_LIFECYCLE_EVENT.GUARDIAN_NOTIFIED,
    ],
    '§16: timeout -> activated -> guardian notified -> guardian-notified'
  );
  assert.deepEqual(
    sequence,
    ['db', 'emit', 'emit', 'write', 'emit', 'emit'],
    'every event follows the write that produced its state'
  );

  assert.equal(emit.calls[1].event, SOS_LIFECYCLE_EVENT.ACTIVATED);
  assert.equal(emit.calls[1].userId, OWNER_ID);
  assert.equal(emit.calls[3].event, SOS_LIFECYCLE_EVENT.GUARDIAN_NOTIFIED);
  assert.equal(emit.calls[3].userId, OWNER_ID, 'the lifecycle report reaches the owner, not the guardian');
});

test('cancellation never activates and never emits sos:activated', async () => {
  const repository = makeSosRepository(verifyingDoc());
  const emit = makeEmit();

  const updated = await cancelSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });

  assert.equal(updated.status, 'CANCELLED');
  assert.deepEqual(emit.events(), [SOS_EVENT.CANCELLED]);
  assert.ok(!emit.events().includes(SOS_LIFECYCLE_EVENT.ACTIVATED));
});

test('a refused confirmation emits nothing at all', async () => {
  const repository = makeSosRepository(activeDoc());
  const emit = makeEmit();

  await assert.rejects(
    () => confirmSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn }),
    (err) => err.statusCode === 409
  );
  assert.equal(emit.calls.length, 0, 'a lost transition notifies nobody');
});

test('a throwing socket never fails an already-persisted confirmation', async () => {
  const repository = makeSosRepository(verifyingDoc());

  const updated = await confirmSOS({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    emit: async () => {
      throw new Error('socket backend down');
    },
  });

  assert.equal(updated.status, 'ACTIVE', 'state is authoritative, delivery is best effort');
});

// ---------- sos:guardian-notified ------------------------------------------

test('guardian start notifies the guardian first, then reports it to the owner', async () => {
  const sequence = [];
  const emit = makeEmit(sequence);
  const repository = makeEscalationRepository({ finds: [activeDoc()], sequence });

  await startGuardianEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    guardianRepository: makeGuardianRepository(),
    emit: emit.fn,
    scheduleTimeout: scheduleFake(),
    isOnline: () => true,
  });

  assert.deepEqual(sequence, ['write', 'emit', 'emit'], '§5: persist -> notify -> report');
  assert.deepEqual(
    emit.events(),
    [SOS_EVENT.GUARDIAN_NOTIFY, SOS_LIFECYCLE_EVENT.GUARDIAN_NOTIFIED]
  );
  assert.equal(emit.calls[0].userId, GUARDIAN_ID, 'the detailed event reaches the guardian');
  assert.equal(emit.calls[1].userId, OWNER_ID, 'the lifecycle event reaches the owner');

  const payload = emit.calls[1].payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['expiresAt', 'guardian', 'level', 'notifiedAt', 'sosId', 'status']
  );
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.level, 'GUARDIAN');
  assert.equal(payload.status, 'PENDING');
  assert.deepEqual(payload.guardian, { userId: GUARDIAN_ID, name: 'Guardian One' });
  assert.ok(!JSON.stringify(payload).includes('address'), 'no location at all in this payload');
});

test('no reachable guardian records TIMEOUT and claims no notification', async () => {
  const sequence = [];
  const emit = makeEmit(sequence);
  const repository = makeEscalationRepository({
    finds: [activeDoc()],
    onStart: (level) => activeDoc({ escalation: { currentLevel: 0, levels: [level] } }),
  });

  const result = await startGuardianEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    guardianRepository: {
      findActiveGuardians: async () => [{ guardianUserId: GUARDIAN_ID, priority: 1, status: 'ACTIVE' }],
      findUserById: async (userId) => ({ _id: userId }),
    },
    emit: emit.fn,
    scheduleTimeout: scheduleFake(),
    isOnline: () => false,
  });

  assert.equal(result.status, 'TIMEOUT');
  assert.equal(emit.calls.length, 0, '§16: never imply a notification that did not happen');
  assert.equal(sequence.filter((step) => step === 'emit').length, 0);
});

// ---------- sos:guardian-acknowledged --------------------------------------

test('escalation acknowledge: detailed event then lifecycle acknowledgement, never a resolve', async () => {
  const sequence = [];
  const emit = makeEmit(sequence);
  const repository = makeEscalationRepository({
    sequence,
    finds: [
      activeDoc({
        status: 'ACTIVE',
        escalation: { currentLevel: 0, levels: [guardianLevel('PENDING')] },
      }),
    ],
  });

  const result = await acknowledgeEscalation({
    sosId: SOS_ID,
    userId: GUARDIAN_ID,
    level: 'GUARDIAN',
    repository,
    relationships: relationshipsOk(),
    profiles: profilesWith(),
    emit: emit.fn,
    cancelTimeout: () => {},
  });

  assert.equal(result.status, 'ACKNOWLEDGED');
  assert.deepEqual(
    sequence,
    ['write', 'emit', 'emit'],
    '§16: write -> detailed -> lifecycle'
  );
  assert.deepEqual(
    emit.events(),
    [SOS_EVENT.GUARDIAN_ACKNOWLEDGED, SOS_LIFECYCLE_EVENT.GUARDIAN_ACKNOWLEDGED]
  );
  assert.ok(
    emit.calls.every((call) => call.userId === OWNER_ID),
    '§15: both acknowledgement events are owner-room only'
  );

  const payload = emit.calls[1].payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['acknowledgedAt', 'guardian', 'level', 'sosId', 'status']
  );
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.level, 'GUARDIAN');
  assert.equal(payload.status, 'ACKNOWLEDGED');
  assert.equal(payload.guardian.userId, GUARDIAN_ID);
  assert.equal(payload.acknowledgedAt, new Date(payload.acknowledgedAt).toISOString());
});

test('acknowledging a responder level emits no guardian lifecycle event', async () => {
  const emit = makeEmit();
  const repository = makeEscalationRepository({
    finds: [
      activeDoc({
        status: 'ACTIVE',
        escalation: {
          currentLevel: 1,
          levels: [guardianLevel('TIMEOUT'), responderLevel()],
        },
      }),
    ],
  });

  await acknowledgeEscalation({
    sosId: SOS_ID,
    userId: RESPONDER_1,
    level: 'NEARBY_RESPONDER',
    responderId: RESPONDER_1,
    repository,
    profiles: profilesWith('Nearby Helper'),
    emit: emit.fn,
    cancelTimeout: () => {},
  });

  assert.deepEqual(emit.events(), [
    SOS_EVENT.RESPONDER_ACKNOWLEDGED,
    RESPONDER_SOS_EVENT.ACKNOWLEDGED,
  ]);
  assert.ok(!emit.events().includes(SOS_LIFECYCLE_EVENT.GUARDIAN_ACKNOWLEDGED));
  assert.ok(
    !emit.events().includes('sos:resolved'),
    '§12: acknowledgement never resolves the SOS'
  );
});

test('generic acknowledge by a guardian emits sos:guardian-acknowledged after the write', async () => {
  const sequence = [];
  const emit = makeEmit(sequence);
  const doc = activeDoc({
    escalation: { currentLevel: 0, levels: [guardianLevel('PENDING')] },
  });
  const repository = makeSosRepository(doc, sequence);

  const updated = await acknowledgeSOS({
    sosId: SOS_ID,
    userId: GUARDIAN_ID,
    repository,
    profiles: profilesWith(),
    emit: emit.fn,
  });

  assert.equal(updated.status, 'ACKNOWLEDGED', 'acknowledgement resolves nothing');
  assert.deepEqual(sequence, ['db', 'emit'], 'database first, lifecycle second');
  assert.deepEqual(emit.events(), [SOS_LIFECYCLE_EVENT.GUARDIAN_ACKNOWLEDGED]);

  const call = emit.calls[0];
  assert.equal(call.userId, OWNER_ID, 'the owner learns their guardian answered');
  assert.deepEqual(
    Object.keys(call.payload).sort(),
    ['acknowledgedAt', 'guardian', 'level', 'sosId', 'status']
  );
  assert.equal(call.payload.level, 'GUARDIAN');
  assert.equal(call.payload.status, 'ACKNOWLEDGED');
  assert.equal(call.payload.guardian.userId, GUARDIAN_ID);
  assert.equal(call.payload.guardian.name, 'Guardian One');
});

test('generic acknowledge by a responder emits nothing', async () => {
  const emit = makeEmit();
  const doc = activeDoc({
    escalation: {
      currentLevel: 1,
      levels: [guardianLevel('TIMEOUT'), { ...responderLevel(), targetId: RESPONDER_1 }],
    },
  });

  const updated = await acknowledgeSOS({
    sosId: SOS_ID,
    userId: RESPONDER_1,
    repository: makeSosRepository(doc),
    profiles: profilesWith('Nearby Helper'),
    emit: emit.fn,
  });

  assert.equal(updated.status, 'ACKNOWLEDGED');
  assert.equal(emit.calls.length, 0, 'only the guardian stage has a lifecycle acknowledgement');
});

test('generic acknowledge of an already-acknowledged SOS emits nothing', async () => {
  const emit = makeEmit();
  const doc = acknowledgedDoc();
  doc.escalation.levels[0].status = 'PENDING';
  doc.status = 'ACKNOWLEDGED';

  await assert.rejects(
    () =>
      acknowledgeSOS({
        sosId: SOS_ID,
        userId: GUARDIAN_ID,
        repository: makeSosRepository(doc),
        profiles: profilesWith(),
        emit: emit.fn,
      }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_ACKNOWLEDGED'
  );
  assert.equal(emit.calls.length, 0);
});

// ---------- sos:escalating --------------------------------------------------

test('responder escalation emits sos:escalating to the owner before the responder notifications', async () => {
  const sequence = [];
  const emit = makeEmit(sequence);
  const pre = responderPreDoc();
  const written = responderWrittenDoc(responderLevel());
  const repository = makeEscalationRepository({ finds: [pre, written], sequence });

  await startResponderEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    profiles: profilesWith('Ansuman'),
    eligibleResponders: () => [{ id: RESPONDER_1 }, { id: RESPONDER_2 }],
    emit: emit.fn,
    scheduleTimeout: scheduleFake(sequence),
  });

  assert.deepEqual(
    emit.events(),
    [
      SOS_LIFECYCLE_EVENT.ESCALATING,
      SOS_EVENT.RESPONDER_NOTIFY,
      SOS_EVENT.RESPONDER_NOTIFY,
      RESPONDER_SOS_EVENT.NOTIFICATION,
      RESPONDER_SOS_EVENT.NOTIFICATION,
    ],
    '16: escalating -> responder notification (detailed + responder channel)'
  );
  assert.deepEqual(
    sequence,
    ['write', 'schedule', 'emit', 'emit', 'emit', 'emit', 'emit'],
    '17: write -> arm the timer -> lifecycle event -> per-responder notifications'
  );

  const lifecycle = emit.calls[0];
  assert.equal(lifecycle.userId, OWNER_ID, '15: owner private room only');
  assert.deepEqual(
    Object.keys(lifecycle.payload).sort(),
    ['currentLevel', 'escalatedAt', 'previousLevel', 'reason', 'sosId', 'status']
  );
  assert.equal(lifecycle.payload.sosId, SOS_ID);
  assert.equal(lifecycle.payload.status, 'ESCALATING', '13: lifecycle label, not a database rewrite');
  assert.equal(lifecycle.payload.currentLevel, 'NEARBY_RESPONDER');
  assert.equal(lifecycle.payload.previousLevel, 'GUARDIAN');
  assert.equal(lifecycle.payload.reason, 'GUARDIAN_TIMEOUT');
  assert.equal(lifecycle.payload.escalatedAt, new Date(lifecycle.payload.escalatedAt).toISOString());

  const recipients = emit.calls.slice(1).map((call) => call.userId).sort();
  assert.deepEqual(
    recipients,
    [RESPONDER_1, RESPONDER_2, RESPONDER_1, RESPONDER_2].sort(),
    'both channels reach exactly the two selected responders'
  );
  for (const call of emit.calls.slice(1)) {
    assert.ok(
      [RESPONDER_1, RESPONDER_2].includes(call.userId),
      'never the owner, never a broadcast'
    );
  }
  assert.equal(written.status, 'ACTIVE', '13: the SOS status itself never flips to ESCALATING');
});

test('police escalation emits sos:escalating before sos:police:escalated', async () => {
  const emit = makeEmit();
  const pre = policePreDoc();
  const written = activeDoc({
    escalation: {
      currentLevel: 2,
      levels: [...pre.escalation.levels, policeLevel()],
    },
  });
  const repository = makeEscalationRepository({ finds: [pre, written] });

  await escalateToPolice({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    policeStation,
    emit: emit.fn,
  });

  assert.deepEqual(
    emit.events(),
    [SOS_LIFECYCLE_EVENT.ESCALATING, SOS_EVENT.POLICE_ESCALATED]
  );
  assert.ok(emit.calls.every((call) => call.userId === OWNER_ID));

  const payload = emit.calls[0].payload;
  assert.equal(payload.currentLevel, 'POLICE');
  assert.equal(payload.previousLevel, 'NEARBY_RESPONDER');
  assert.equal(payload.reason, 'RESPONDER_TIMEOUT');
});

test('an empty responder set records TIMEOUT without a stage-move claim', async () => {
  const emit = makeEmit();
  const pre = responderPreDoc();
  const written = responderWrittenDoc(emptyResponderLevel());
  const repository = makeEscalationRepository({ finds: [pre, written] });

  const result = await startResponderEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    profiles: profilesWith('Ansuman'),
    eligibleResponders: () => [],
    emit: emit.fn,
    scheduleTimeout: scheduleFake(),
  });

  assert.equal(result.status, 'TIMEOUT');
  assert.equal(repository.calls.start.length, 1, 'the level is still recorded');
  assert.equal(emit.calls.length, 0, 'nobody was notified, so nobody is told they were');
});

test('a SOS cancelled while the request is in flight receives no sos:escalating', async () => {
  const emit = makeEmit();
  const pre = responderPreDoc();
  const written = responderWrittenDoc(responderLevel());
  const cancelled = { ...written, status: 'CANCELLED' };
  const repository = makeEscalationRepository({ finds: [pre, cancelled] });

  const result = await startResponderEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    profiles: profilesWith('Ansuman'),
    eligibleResponders: () => [{ id: RESPONDER_1 }],
    emit: emit.fn,
    scheduleTimeout: scheduleFake(),
  });

  assert.equal(result.status, 'PENDING', 'the write stands');
  assert.equal(emit.calls.length, 0, 'a cancelled SOS never claims an escalation move');
});

test('the loser of a concurrent responder escalation emits nothing', async () => {
  const emit = makeEmit();
  const pre = responderPreDoc();
  const winner = responderWrittenDoc(responderLevel());
  const repository = {
    calls: { start: [] },
    findById: async () => pre,
    startResponderEscalation: async ({ level }) => {
      repository.calls.start.push(level);
      return null;
    },
  };
  // First read (classify) sees `pre`; the lost-race re-read sees the winner.
  const finds = [pre, winner];
  let cursor = 0;
  repository.findById = async () => finds[Math.min(cursor++, finds.length - 1)];

  const result = await startResponderEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    profiles: profilesWith('Ansuman'),
    eligibleResponders: () => [{ id: RESPONDER_1 }],
    emit: emit.fn,
    scheduleTimeout: scheduleFake(),
  });

  assert.equal(result.status, 'PENDING', 'the winner state is replayed');
  assert.equal(emit.calls.length, 0, 'only the write winner may notify');
});

// ---------- sos:resolved ----------------------------------------------------

test('owner resolve emits sos:resolved with resolvedBy type USER', async () => {
  const repository = makeSosRepository(acknowledgedDoc());
  const emit = makeEmit();

  const updated = await resolveSOS({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    emit: emit.fn,
  });

  assert.equal(updated.status, 'RESOLVED');
  assert.deepEqual(emit.events(), [SOS_LIFECYCLE_EVENT.RESOLVED]);

  const call = emit.calls[0];
  assert.equal(call.userId, OWNER_ID, '§15: owner private room only');
  assert.deepEqual(
    Object.keys(call.payload).sort(),
    ['previousStatus', 'resolvedAt', 'resolvedBy', 'sosId', 'status']
  );
  assert.equal(call.payload.sosId, SOS_ID);
  assert.equal(call.payload.status, 'RESOLVED');
  assert.equal(call.payload.previousStatus, 'ACKNOWLEDGED');
  assert.deepEqual(call.payload.resolvedBy, { userId: OWNER_ID, type: 'USER' });
  assert.equal(call.payload.resolvedAt, new Date(call.payload.resolvedAt).toISOString());
  assert.ok(!('reason' in call.payload), 'no resolution reason is invented (§13)');
});

test('the acknowledging guardian can resolve and is reported with the persisted level type', async () => {
  const repository = makeSosRepository(acknowledgedDoc());
  const emit = makeEmit();

  const updated = await resolveSOS({
    sosId: SOS_ID,
    userId: GUARDIAN_ID,
    repository,
    emit: emit.fn,
  });

  assert.equal(updated.status, 'RESOLVED');
  assert.deepEqual(emit.events(), [SOS_LIFECYCLE_EVENT.RESOLVED]);
  assert.deepEqual(emit.calls[0].payload.resolvedBy, { userId: GUARDIAN_ID, type: 'GUARDIAN' });
  assert.equal(emit.calls[0].userId, OWNER_ID, 'the owner hears about the resolution');
});

test('a duplicate resolve emits nothing and stays resolved', async () => {
  const repository = makeSosRepository(acknowledgedDoc());
  const emit = makeEmit();

  await resolveSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn });
  assert.equal(emit.calls.length, 1);

  await assert.rejects(
    () => resolveSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_RESOLVED'
  );
  assert.equal(emit.calls.length, 1, 'the winning resolve notified exactly once');
});

test('resolving a non-acknowledged SOS emits nothing', async () => {
  const repository = makeSosRepository(activeDoc());
  const emit = makeEmit();

  await assert.rejects(
    () => resolveSOS({ sosId: SOS_ID, userId: OWNER_ID, repository, emit: emit.fn }),
    (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACKNOWLEDGED'
  );
  assert.equal(emit.calls.length, 0);
});

test('a throwing socket never rolls back the resolution', async () => {
  const repository = makeSosRepository(acknowledgedDoc());

  const updated = await resolveSOS({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    emit: async () => {
      throw new Error('socket backend down');
    },
  });

  assert.equal(updated.status, 'RESOLVED', 'the database remains the source of truth');
});

// ---------- §15: private-room targeting across every lifecycle event --------

test('every lifecycle emission targets the owner private room only', async () => {
  const emit = makeEmit();

  await confirmSOS({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository: makeSosRepository(verifyingDoc()),
    emit: emit.fn,
  });
  await acknowledgeSOS({
    sosId: SOS_ID,
    userId: GUARDIAN_ID,
    repository: (() => {
      const doc = activeDoc({ escalation: { currentLevel: 0, levels: [guardianLevel('PENDING')] } });
      return makeSosRepository(doc);
    })(),
    profiles: profilesWith(),
    emit: emit.fn,
  });
  await resolveSOS({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository: makeSosRepository(acknowledgedDoc()),
    emit: emit.fn,
  });

  const lifecycle = lifecycleCalls(emit);
  assert.equal(lifecycle.length, 3, 'activated + guardian-acknowledged + resolved were all recorded');
  assert.ok(
    lifecycle.every((call) => call.userId === OWNER_ID),
    'never a broadcast, never the guardian directly'
  );
  assert.deepEqual(
    [...new Set(lifecycle.map((call) => call.event))].sort(),
    [
      SOS_LIFECYCLE_EVENT.ACTIVATED,
      SOS_LIFECYCLE_EVENT.GUARDIAN_ACKNOWLEDGED,
      SOS_LIFECYCLE_EVENT.RESOLVED,
    ].sort()
  );
});
