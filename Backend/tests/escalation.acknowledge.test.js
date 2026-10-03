import test from 'node:test';
import assert from 'node:assert/strict';

import {
  acknowledgeEscalation,
  runGuardianTimeout,
  startGuardianEscalation,
} from '../src/modules/sos/escalation.service.js';
import { SOS_EVENT, SOS_LIFECYCLE_EVENT, RESPONDER_SOS_EVENT } from '../src/modules/sos/sos.events.js';

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0d1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0d2';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0d3';
const RESPONDER_1 = 'responder-001';
const RESPONDER_2 = 'responder-002';
const RESPONDER_3 = 'responder-003';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0d4';

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

/**
 * Fake SOS repository. `finds` feeds successive findById calls (last entry
 * repeats); `ackResult: null` simulates a lost atomic race; omitting it
 * derives the acknowledged document from the first read.
 */
const makeRepository = (options = {}) => {
  const { finds = [], sequence = [] } = options;
  const calls = { find: [], ack: [], timeout: [], lastAckDoc: null };
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
              targetId:
                args.levelType === 'NEARBY_RESPONDER' ? args.target : lvl.targetId,
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
    timeoutGuardianEscalation: async (args) => {
      calls.timeout.push(args);
      if (options.timeoutResult !== undefined) return options.timeoutResult;
      return null;
    },
  };
};

/**
 * Stateful fake mirroring the real atomic guards, used by the timeout-race
 * and real-cancellation tests: writes apply only when the persisted state
 * still allows them, exactly like the database filters.
 */
const makeStatefulRepository = (initial = sosDoc({ levels: [] })) => {
  const state = { doc: initial };
  const calls = { start: [], ack: [], timeout: [] };

  return {
    state,
    calls,
    findById: async () => state.doc,
    startGuardianEscalation: async ({ level }) => {
      calls.start.push(level);
      state.doc = sosDoc({ levels: [level] });
      return state.doc;
    },
    acknowledgeEscalationLevel: async ({ levelIndex, levelType, target, respondedAt }) => {
      calls.ack.push({ levelIndex, levelType, target, respondedAt });
      const level = state.doc?.escalation?.levels?.[levelIndex];
      const open =
        state.doc &&
        ['ACTIVE', 'ESCALATING'].includes(state.doc.status) &&
        level?.status === 'PENDING';
      if (!open) return null;

      const levels = state.doc.escalation.levels.map((lvl, i) =>
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
        ...state.doc,
        status: 'ACKNOWLEDGED',
        escalation: { currentLevel: levelIndex, levels },
      };
      return state.doc;
    },
    timeoutGuardianEscalation: async ({ sosId }) => {
      calls.timeout.push({ sosId });
      const level = state.doc?.escalation?.levels?.[0];
      const open =
        state.doc &&
        ['ACTIVE', 'ESCALATING'].includes(state.doc.status) &&
        level?.type === 'GUARDIAN' &&
        level?.status === 'PENDING';
      if (!open) return null;

      state.doc = {
        ...state.doc,
        escalation: {
          currentLevel: 0,
          levels: [{ ...level, status: 'TIMEOUT' }],
        },
      };
      return state.doc;
    },
  };
};

const activeRelationship = { _id: 'rel-1', status: 'ACTIVE' };

const makeRelationships = (relationship = activeRelationship) => {
  const calls = [];
  return {
    calls,
    findRelationship: async (ownerId, guardianId) => {
      calls.push({ ownerId, guardianId });
      return relationship;
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
  acknowledgeEscalation({
    sosId: SOS_ID,
    userId: GUARDIAN_ID,
    level: 'GUARDIAN',
    relationships: makeRelationships(),
    profiles: makeProfiles({ [GUARDIAN_ID]: 'Guardian One', [RESPONDER_1]: 'Nearby Helper' }),
    emit: async () => {},
    ...overrides,
  });

test('guardian acknowledgement: atomic write, cancel timeout, then emit', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence });
  const relationships = makeRelationships();
  const emit = makeEmit(sequence);
  const cancel = makeCancel(sequence);

  const result = await ack({ repository, relationships, emit: emit.fn, cancelTimeout: cancel.fn });

  assert.deepEqual(Object.keys(result).sort(), [
    'acknowledgedAt',
    'acknowledgedBy',
    'level',
    'sosId',
    'status',
  ]);
  assert.equal(result.sosId, SOS_ID);
  assert.equal(result.level, 'GUARDIAN');
  assert.equal(result.status, 'ACKNOWLEDGED');
  assert.equal(result.acknowledgedBy, GUARDIAN_ID);
  assert.ok(result.acknowledgedAt instanceof Date, 'acknowledgedAt is the stored respondedAt');

  assert.deepEqual(
    sequence,
    ['write', 'cancel', 'emit', 'emit'],
    '§17: database first, then timeout cancellation, then detailed + lifecycle notification'
  );

  const write = repository.calls.ack[0];
  assert.equal(write.sosId, SOS_ID);
  assert.equal(write.userId, OWNER_ID, 'write scoped to the SOS owner');
  assert.equal(write.levelIndex, 0, 'the CURRENT level');
  assert.equal(write.levelType, 'GUARDIAN');
  assert.equal(write.target, GUARDIAN_ID, 'backend-derived target');
  assert.ok(write.respondedAt instanceof Date);

  const storedDoc = repository.calls.lastAckDoc;
  assert.equal(storedDoc.status, 'ACKNOWLEDGED', 'SOS acknowledged through the existing rule');
  assert.notEqual(storedDoc.status, 'RESOLVED', 'acknowledgement never resolves the SOS');
  assert.equal(storedDoc.escalation.levels[0].status, 'ACKNOWLEDGED');
  assert.equal(storedDoc.escalation.levels[0].targetId, GUARDIAN_ID, 'targetId untouched');
  assert.ok(storedDoc.escalation.levels[0].respondedAt instanceof Date);

  assert.deepEqual(cancel.calls, [SOS_ID], 'the pending level timeout is cancelled');
  assert.equal(relationships.calls[0].ownerId, OWNER_ID, 'relationship checked against owner');
  assert.equal(relationships.calls[0].guardianId, GUARDIAN_ID);

  assert.equal(
    emit.calls.length,
    2,
    'one specific detailed event + one lifecycle event, no generic escalation event'
  );
  const { userId: recipient, event, payload } = emit.calls[0];
  assert.equal(recipient, OWNER_ID, "notified through the SOS owner's private room only");
  assert.equal(event, SOS_EVENT.GUARDIAN_ACKNOWLEDGED);
  assert.equal(event, 'sos:guardian:acknowledged');

  assert.deepEqual(Object.keys(payload).sort(), [
    'acknowledgedAt',
    'guardian',
    'level',
    'sosId',
    'status',
  ]);
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.level, 'GUARDIAN');
  assert.equal(payload.status, 'ACKNOWLEDGED');
  assert.deepEqual(payload.guardian, { userId: GUARDIAN_ID, name: 'Guardian One' });
  assert.equal(payload.acknowledgedAt, new Date(payload.acknowledgedAt).toISOString());

  const lifecycle = emit.calls[1];
  assert.equal(lifecycle.userId, OWNER_ID, 'the lifecycle event is owner-room only too');
  assert.equal(lifecycle.event, SOS_LIFECYCLE_EVENT.GUARDIAN_ACKNOWLEDGED);
  assert.equal(lifecycle.event, 'sos:guardian-acknowledged');
  assert.deepEqual(
    Object.keys(lifecycle.payload).sort(),
    ['acknowledgedAt', 'guardian', 'level', 'sosId', 'status']
  );
  assert.equal(lifecycle.payload.acknowledgedAt, payload.acknowledgedAt, 'same persisted transition');
});

test('responder acknowledgement records who acknowledged and preserves the notified list', async () => {
  const sequence = [];
  const repository = makeRepository({
    finds: [
      sosDoc({
        levels: [
          guardianLevel({ status: 'TIMEOUT' }),
          responderLevel(),
        ],
        currentLevel: 1,
      }),
    ],
    sequence,
  });
  const relationships = makeRelationships();
  const emit = makeEmit(sequence);
  const cancel = makeCancel(sequence);

  const result = await ack({
    userId: RESPONDER_1,
    level: 'NEARBY_RESPONDER',
    repository,
    relationships,
    emit: emit.fn,
    cancelTimeout: cancel.fn,
  });

  assert.equal(result.level, 'NEARBY_RESPONDER');
  assert.equal(result.status, 'ACKNOWLEDGED');
  assert.equal(result.acknowledgedBy, RESPONDER_1);
  assert.ok(result.acknowledgedAt instanceof Date);

  assert.equal(relationships.calls.length, 0, 'responders are not guardian relationships');

  const write = repository.calls.ack[0];
  assert.equal(write.levelIndex, 1, 'acknowledges the CURRENT (responder) level');
  assert.equal(write.levelType, 'NEARBY_RESPONDER');
  assert.equal(write.target, RESPONDER_1);

  assert.deepEqual(cancel.calls, [SOS_ID], 'the responder timeout is cancelled too');
  assert.deepEqual(sequence, ['write', 'cancel', 'emit', 'emit']);

  assert.equal(
    emit.calls.length,
    2,
    'the detailed event + the responder channel, no generic escalation event'
  );
  const { userId: recipient, event, payload } = emit.calls[0];
  assert.equal(recipient, OWNER_ID);
  assert.equal(event, SOS_EVENT.RESPONDER_ACKNOWLEDGED);
  assert.equal(event, 'sos:responder:acknowledged');
  assert.equal(emit.calls[1].event, RESPONDER_SOS_EVENT.ACKNOWLEDGED);
  assert.equal(emit.calls[1].userId, OWNER_ID, '§10: owner private room, never a broadcast');
  assert.deepEqual(emit.calls[1].payload, payload, '§11: same payload contract');
  assert.deepEqual(Object.keys(payload).sort(), [
    'acknowledgedAt',
    'level',
    'responder',
    'sosId',
    'status',
  ]);
  assert.equal(payload.level, 'NEARBY_RESPONDER');
  assert.deepEqual(payload.responder, { responderId: RESPONDER_1, name: 'Nearby Helper' });

  const storedDoc = repository.calls.lastAckDoc;
  assert.equal(storedDoc.status, 'ACKNOWLEDGED');
  assert.equal(storedDoc.escalation.levels[1].status, 'ACKNOWLEDGED');
  assert.equal(
    storedDoc.escalation.levels[1].targetId,
    RESPONDER_1,
    'records who acknowledged'
  );
  assert.deepEqual(
    storedDoc.escalation.levels[1].notifiedResponders,
    [RESPONDER_1, RESPONDER_2],
    'the notified list is preserved, never overwritten'
  );
  assert.equal(storedDoc.escalation.levels[0].status, 'TIMEOUT', 'previous level untouched');
  assert.equal(storedDoc.escalation.levels[0].targetId, GUARDIAN_ID);
  assert.ok(
    !JSON.stringify(storedDoc.escalation.levels[1]).includes('acknowledgedBy'),
    'who acknowledged lives in respondedAt, not a payload-only field'
  );
});

test('missing SOS is 404 and nothing is written', async () => {
  const repository = makeRepository({ finds: [null] });

  await assert.rejects(
    () => ack({ repository }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );
  assert.equal(repository.calls.ack.length, 0);
});

test('the SOS owner cannot impersonate the guardian (403)', async () => {
  const repository = makeRepository();
  const relationships = makeRelationships();

  await assert.rejects(
    () => ack({ userId: OWNER_ID, repository, relationships }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RECIPIENT_NOT_AUTHORIZED'
  );
  assert.equal(repository.calls.ack.length, 0, 'no write for a non-target');
  assert.equal(relationships.calls.length, 0, 'target check runs before the relationship lookup');
});

test('an unrelated user is rejected with 403', async () => {
  const repository = makeRepository();

  await assert.rejects(
    () => ack({ userId: STRANGER_ID, repository }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RECIPIENT_NOT_AUTHORIZED'
  );
  assert.equal(repository.calls.ack.length, 0);
});

test('a guardian whose relationship is missing or inactive is rejected with 403', async () => {
  for (const relationship of [null, { _id: 'rel-1', status: 'BLOCKED' }, { _id: 'rel-1', status: 'PENDING' }]) {
    const repository = makeRepository();

    await assert.rejects(
      () => ack({ repository, relationships: makeRelationships(relationship) }),
      (err) => err.statusCode === 403 && err.code === 'SOS_RECIPIENT_NOT_AUTHORIZED',
      JSON.stringify(relationship)
    );
    assert.equal(repository.calls.ack.length, 0, JSON.stringify(relationship));
  }
});

test('a responder outside the notified list is rejected with 403', async () => {
  const repository = makeRepository({
    finds: [sosDoc({ levels: [guardianLevel({ status: 'TIMEOUT' }), responderLevel()], currentLevel: 1 })],
  });

  await assert.rejects(
    () => ack({ userId: RESPONDER_3, level: 'NEARBY_RESPONDER', repository }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RECIPIENT_NOT_AUTHORIZED'
  );
  assert.equal(repository.calls.ack.length, 0);
});

test('the requested level must be the current level (409 mismatch)', async () => {
  const guardianCurrent = makeRepository();
  await assert.rejects(
    () => ack({ level: 'NEARBY_RESPONDER', userId: RESPONDER_1, repository: guardianCurrent }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_LEVEL_MISMATCH',
    'current GUARDIAN vs requested NEARBY_RESPONDER'
  );
  assert.equal(guardianCurrent.calls.ack.length, 0);

  const responderCurrent = makeRepository({
    finds: [sosDoc({ levels: [guardianLevel({ status: 'TIMEOUT' }), responderLevel()], currentLevel: 1 })],
  });
  await assert.rejects(
    () => ack({ level: 'GUARDIAN', repository: responderCurrent }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_LEVEL_MISMATCH',
    'current NEARBY_RESPONDER vs requested GUARDIAN'
  );
  assert.equal(responderCurrent.calls.ack.length, 0);
});

test('only a PENDING level can be acknowledged (409 otherwise)', async () => {
  const timedOut = makeRepository({ finds: [sosDoc({ levels: [guardianLevel({ status: 'TIMEOUT' })] })] });
  await assert.rejects(
    () => ack({ repository: timedOut }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS',
    'TIMEOUT'
  );
  assert.equal(timedOut.calls.ack.length, 0);

  const alreadyAcked = makeRepository({
    finds: [sosDoc({ levels: [guardianLevel({ status: 'ACKNOWLEDGED' })] })],
  });
  await assert.rejects(
    () => ack({ repository: alreadyAcked }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_ACKNOWLEDGED',
    'ACKNOWLEDGED'
  );
  assert.equal(alreadyAcked.calls.ack.length, 0);

  const empty = makeRepository({ finds: [sosDoc({ levels: [] })] });
  await assert.rejects(
    () => ack({ repository: empty }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_NOT_PENDING',
    'no escalation level at all'
  );
  assert.equal(empty.calls.ack.length, 0);
});

test('SOS state gates acknowledgement (404/409 conventions reused)', async () => {
  const acknowledged = makeRepository({ finds: [sosDoc({ status: 'ACKNOWLEDGED' })] });
  await assert.rejects(
    () => ack({ repository: acknowledged }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_ACKNOWLEDGED'
  );

  for (const status of ['VERIFYING', 'CANCELLED', 'RESOLVED']) {
    const repository = makeRepository({ finds: [sosDoc({ status })] });

    await assert.rejects(
      () => ack({ repository }),
      (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACKNOWLEDGEABLE',
      status
    );
    assert.equal(repository.calls.ack.length, 0, status);
  }

  const escalating = makeRepository({ finds: [sosDoc({ status: 'ESCALATING' })] });
  const result = await ack({ repository: escalating });
  assert.equal(result.status, 'ACKNOWLEDGED', 'ESCALATING stays acknowledgeable');
});

test('a lost race against a duplicate acknowledgement reports the existing state', async () => {
  const sequence = [];
  const repository = makeRepository({
    finds: [sosDoc(), sosDoc({ status: 'ACKNOWLEDGED' })],
    ackResult: null,
    sequence,
  });
  const emit = makeEmit(sequence);
  const cancel = makeCancel(sequence);

  await assert.rejects(
    () => ack({ repository, emit: emit.fn, cancelTimeout: cancel.fn }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_ACKNOWLEDGED'
  );

  assert.equal(repository.calls.ack.length, 1, 'one write attempt');
  assert.equal(cancel.calls.length, 0, 'loser never cancels the timer');
  assert.equal(emit.calls.length, 0, 'loser never emits');
});

test('a lost race against the timeout reports ESCALATION_ALREADY_PROGRESS', async () => {
  const repository = makeRepository({
    finds: [sosDoc(), sosDoc({ levels: [guardianLevel({ status: 'TIMEOUT' })] })],
    ackResult: null,
  });
  const emit = makeEmit();
  const cancel = makeCancel();

  await assert.rejects(
    () => ack({ repository, emit: emit.fn, cancelTimeout: cancel.fn }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS'
  );

  assert.equal(repository.calls.ack.length, 1);
  assert.equal(cancel.calls.length, 0);
  assert.equal(emit.calls.length, 0, 'no acknowledgement event for a lost race');
});

test('a failing notification never rolls back the acknowledged state', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence });
  const cancel = makeCancel(sequence);

  const result = await ack({
    repository,
    emit: async () => {
      sequence.push('emit');
      throw new Error('socket backend down');
    },
    cancelTimeout: cancel.fn,
  });

  assert.equal(result.status, 'ACKNOWLEDGED', 'delivery failure does not undo the write');
  assert.deepEqual(
    sequence,
    ['write', 'cancel', 'emit', 'emit'],
    'the write happened before both notification attempts; a dropped socket changes nothing'
  );
  assert.equal(repository.calls.ack.length, 1);
});

test('acknowledgement really cancels the armed timeout (registry path)', async () => {
  const repository = makeStatefulRepository();

  await startGuardianEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    guardianRepository: {
      findActiveGuardians: async () => [{ guardianUserId: GUARDIAN_ID, priority: 1, status: 'ACTIVE' }],
      findUserById: async (id) => ({ _id: id }),
    },
    scheduleTimeout: (task, ms) => setTimeout(task, ms),
    timeoutMs: 60,
    emit: async () => {},
  });
  assert.equal(repository.state.doc.escalation.levels[0].status, 'PENDING');

  // cancelTimeout deliberately omitted: the module-default registry runs.
  const result = await acknowledgeEscalation({
    sosId: SOS_ID,
    userId: GUARDIAN_ID,
    level: 'GUARDIAN',
    repository,
    relationships: makeRelationships(),
    profiles: makeProfiles({ [GUARDIAN_ID]: 'Guardian One' }),
    emit: async () => {},
  });
  assert.equal(result.status, 'ACKNOWLEDGED');

  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(
    repository.calls.timeout.length,
    0,
    'the armed timer was cleared — it never reached the timeout handler'
  );
  assert.equal(
    repository.state.doc.escalation.levels[0].status,
    'ACKNOWLEDGED',
    'state untouched by any late timer'
  );
});

test('acknowledgement vs timeout: both orders produce exactly one transition', async () => {
  // (a) acknowledgement wins first: the timeout becomes a no-op.
  const stateA = makeStatefulRepository(sosDoc());
  await acknowledgeEscalation({
    sosId: SOS_ID,
    userId: GUARDIAN_ID,
    level: 'GUARDIAN',
    repository: stateA,
    relationships: makeRelationships(),
    profiles: makeProfiles({ [GUARDIAN_ID]: 'Guardian One' }),
    emit: async () => {},
  });
  const timeoutA = await runGuardianTimeout({ sosId: SOS_ID, repository: stateA });
  assert.equal(timeoutA, false, 'timeout lost: nothing pending');
  assert.equal(stateA.state.doc.escalation.levels[0].status, 'ACKNOWLEDGED');
  assert.equal(stateA.state.doc.status, 'ACKNOWLEDGED', 'no PENDING -> ACKNOWLEDGED -> TIMEOUT');

  // (b) timeout wins first: the acknowledgement is refused.
  const stateB = makeStatefulRepository(sosDoc());
  const timeoutB = await runGuardianTimeout({ sosId: SOS_ID, repository: stateB });
  assert.equal(timeoutB, true, 'timeout won');
  assert.equal(stateB.state.doc.escalation.levels[0].status, 'TIMEOUT');

  await assert.rejects(
    () =>
      acknowledgeEscalation({
        sosId: SOS_ID,
        userId: GUARDIAN_ID,
        level: 'GUARDIAN',
        repository: stateB,
        relationships: makeRelationships(),
        profiles: makeProfiles(),
        emit: async () => {},
      }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS'
  );
  assert.equal(stateB.state.doc.escalation.levels[0].status, 'TIMEOUT', 'never TIMEOUT -> ACKNOWLEDGED');

  // (c) genuinely concurrent: whoever wins the atomic write, the two
  //     transitions can never both apply.
  const stateC = makeStatefulRepository(sosDoc());
  const [ackOutcome, timeoutOutcome] = await Promise.allSettled([
    acknowledgeEscalation({
      sosId: SOS_ID,
      userId: GUARDIAN_ID,
      level: 'GUARDIAN',
      repository: stateC,
      relationships: makeRelationships(),
      profiles: makeProfiles({ [GUARDIAN_ID]: 'Guardian One' }),
      emit: async () => {},
    }),
    runGuardianTimeout({ sosId: SOS_ID, repository: stateC }),
  ]);

  if (ackOutcome.status === 'fulfilled') {
    assert.equal(timeoutOutcome.value, false, 'acknowledgement won, timeout was withheld');
    assert.equal(stateC.state.doc.escalation.levels[0].status, 'ACKNOWLEDGED');
  } else {
    assert.equal(ackOutcome.reason.code, 'ESCALATION_ALREADY_PROGRESS');
    assert.equal(timeoutOutcome.value, true, 'timeout won');
    assert.equal(stateC.state.doc.escalation.levels[0].status, 'TIMEOUT');
  }
});
