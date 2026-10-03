import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createGuardian,
  acceptGuardian,
  rejectGuardian,
} from '../src/modules/guardians/guardian.service.js';
import { GUARDIAN_EVENT } from '../src/modules/guardians/guardian.events.js';

const USER_ID = '64b0f0f0f0f0f0f0f0f0f0f1'; // requesting user
const GUARDIAN_USER_ID = '64b0f0f0f0f0f0f0f0f0f0f2'; // requested guardian
const GUARDIAN_REQUEST_ID = '64b0f0f0f0f0f0f0f0f0f0f3';

const pendingDoc = () => ({
  _id: GUARDIAN_REQUEST_ID,
  userId: USER_ID,
  guardianUserId: GUARDIAN_USER_ID,
  relationship: 'Father',
  priority: 1,
  status: 'PENDING',
  createdAt: new Date('2026-10-01T10:00:00.000Z'),
  updatedAt: new Date('2026-10-01T10:00:00.000Z'),
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

const makeCreateRepository = ({ sequence = [] } = {}) => ({
  findRelationship: async () => null,
  createGuardian: async (data) => {
    sequence.push('create');
    return { _id: GUARDIAN_REQUEST_ID, createdAt: new Date(), updatedAt: new Date(), ...data };
  },
});

/** Fake whose complete() mirrors the conditional filter: only a PENDING
 *  record whose guardianUserId matches can transition — the same atomicity
 *  the repository guarantees, so a second attempt after a concurrent flip
 *  gets null and the service reports the conflict. */
const makeTransitionRepository = ({ initialStatus, sequence = [] } = {}) => {
  const state = {
    doc: {
      ...pendingDoc(),
      status: initialStatus,
    },
  };

  const transition = (next, pushName) => async (guardianId, guardianUserId) => {
    const doc = state.doc;
    const allowed =
      String(doc._id) === String(guardianId) &&
      String(doc.guardianUserId) === String(guardianUserId) &&
      doc.status === 'PENDING';

    if (!allowed) return null;

    sequence.push(pushName);
    state.doc = { ...doc, status: next, updatedAt: new Date() };
    return state.doc;
  };

  return {
    state,
    acceptByGuardian: transition('ACTIVE', 'write'),
    rejectByGuardian: transition('REJECTED', 'write'),
    findByGuardianId: async (guardianId, guardianUserId) => {
      if (String(state.doc._id) !== String(guardianId)) return null;
      if (String(state.doc.guardianUserId) !== String(guardianUserId)) return null;
      return state.doc;
    },
  };
};

const dependencies = { findUserById: async () => ({ _id: GUARDIAN_USER_ID }) };

// ---------- guardian:request (§3) ----------

test('guardian:request is emitted to the requested guardian only, after the PENDING write', async () => {
  const sequence = [];
  const repository = makeCreateRepository({ sequence });
  const emit = makeEmit(sequence);

  const guardian = await createGuardian({
    userId: USER_ID,
    guardianUserId: GUARDIAN_USER_ID,
    relationship: 'Father',
    priority: 1,
    repository,
    dependencies,
    emit: emit.fn,
  });

  assert.equal(guardian.status, 'PENDING');
  assert.deepEqual(sequence, ['create', 'emit'], 'database first, then notification');

  assert.equal(emit.calls.length, 1, 'exactly one notification');
  const { userId, event, payload } = emit.calls[0];
  assert.equal(userId, GUARDIAN_USER_ID, 'the requested guardian gets it, never the requester');
  assert.equal(userId.includes('*'), false, 'never a broadcast');
  assert.equal(event, 'guardian:request');
  assert.deepEqual(Object.keys(payload).sort(), [
    'guardianRequestId',
    'message',
    'priority',
    'relationship',
    'status',
    'userId',
  ]);
  assert.equal(payload.guardianRequestId, GUARDIAN_REQUEST_ID);
  assert.equal(payload.userId, USER_ID);
  assert.equal(payload.relationship, 'Father');
  assert.equal(payload.priority, 1);
  assert.equal(payload.status, 'PENDING');
  assert.equal(payload.message, 'You have received a new guardian request');
  for (const forbidden of ['password', 'token', 'jwt', 'apiKey', 'secret']) {
    assert.ok(!(forbidden in payload), `payload must not carry ${forbidden}`);
  }
});

test('guardian:request is emitted even when delivery fails; the write stands', async () => {
  const repository = makeCreateRepository();

  const guardian = await createGuardian({
    userId: USER_ID,
    guardianUserId: GUARDIAN_USER_ID,
    relationship: 'Father',
    priority: 1,
    repository,
    dependencies,
    emit: async () => {
      throw new Error('socket backend down');
    },
  });

  assert.equal(guardian.status, 'PENDING', 'the persisted relationship survives a socket outage');
});

test('no guardian:request is emitted when the request is refused', async () => {
  for (const { overrides, deps, code } of [
    { overrides: { guardianUserId: USER_ID }, deps: dependencies, code: 'GUARDIAN_SELF_NOT_ALLOWED' },
    { overrides: { guardianUserId: '64b0f0f0f0f0f0f0f0f0f9f9' }, deps: { findUserById: async () => null }, code: 'GUARDIAN_USER_NOT_FOUND' },
  ]) {
    const repository = makeCreateRepository();
    const emit = makeEmit();

    await assert.rejects(
      createGuardian({
        userId: USER_ID,
        relationship: 'Father',
        priority: 1,
        repository,
        dependencies: deps,
        emit: emit.fn,
        ...overrides,
      }),
      (err) => err.code === code
    );

    assert.equal(emit.calls.length, 0, `no event after ${code}`);
  }
});

test('a duplicate pending request stays silent (no duplicate event)', async () => {
  const repository = {
    findRelationship: async () => pendingDoc(),
    createGuardian: async () => {
      throw new Error('a duplicate must never create');
    },
  };
  const emit = makeEmit();

  await assert.rejects(
    createGuardian({
      userId: USER_ID,
      guardianUserId: GUARDIAN_USER_ID,
      relationship: 'Father',
      priority: 1,
      repository,
      dependencies,
      emit: emit.fn,
    }),
    (err) => err.code === 'GUARDIAN_ALREADY_EXISTS'
  );

  assert.equal(emit.calls.length, 0, 'no event for a duplicate request');
});

// ---------- guardian:accepted (§4) and guardian:rejected (§5) ----------

test('guardian:accepted is emitted to the requester only, after PENDING -> ACTIVE', async () => {
  const sequence = [];
  const repository = makeTransitionRepository({ initialStatus: 'PENDING', sequence });
  const emit = makeEmit(sequence);

  const { guardian } = await acceptGuardian({
    guardianId: GUARDIAN_REQUEST_ID,
    guardianUserId: GUARDIAN_USER_ID,
    repository,
    emit: emit.fn,
  });

  assert.equal(guardian.status, 'ACTIVE');
  assert.deepEqual(sequence, ['write', 'emit'], 'database first, then the notification');

  assert.equal(emit.calls.length, 1);
  const { userId, event, payload } = emit.calls[0];
  assert.equal(userId, USER_ID, 'the original requester is notified, not the guardian');
  assert.equal(event, 'guardian:accepted');
  assert.deepEqual(Object.keys(payload).sort(), [
    'guardianRequestId',
    'guardianUserId',
    'message',
    'priority',
    'relationship',
    'status',
    'userId',
  ]);
  assert.equal(payload.status, 'ACTIVE');
  assert.equal(payload.guardianUserId, GUARDIAN_USER_ID);
  assert.equal(payload.userId, USER_ID);
  assert.equal(payload.message, 'Guardian request accepted');
});

test('guardian:rejected is emitted to the requester only, after PENDING -> REJECTED', async () => {
  const sequence = [];
  const repository = makeTransitionRepository({ initialStatus: 'PENDING', sequence });
  const emit = makeEmit(sequence);

  const { guardian } = await rejectGuardian({
    guardianId: GUARDIAN_REQUEST_ID,
    guardianUserId: GUARDIAN_USER_ID,
    repository,
    emit: emit.fn,
  });

  assert.equal(guardian.status, 'REJECTED');
  assert.deepEqual(sequence, ['write', 'emit']);

  assert.equal(emit.calls.length, 1);
  const { userId, event, payload } = emit.calls[0];
  assert.equal(userId, USER_ID, 'the original requester is notified, not the guardian');
  assert.equal(event, 'guardian:rejected');
  assert.equal(payload.status, 'REJECTED');
  assert.equal(payload.guardianUserId, GUARDIAN_USER_ID);
  assert.equal(payload.userId, USER_ID);
  assert.equal(payload.message, 'Guardian request rejected');
  assert.deepEqual(Object.keys(payload).sort(), [
    'guardianRequestId',
    'guardianUserId',
    'message',
    'priority',
    'relationship',
    'status',
    'userId',
  ]);
});

test('a successful transition survives a socket outage (DB stays authoritative)', async () => {
  for (const action of ['accept', 'reject']) {
    const repository = makeTransitionRepository({ initialStatus: 'PENDING' });
    const fn = action === 'accept' ? acceptGuardian : rejectGuardian;
    const expected = action === 'accept' ? 'ACTIVE' : 'REJECTED';

    const { guardian } = await fn({
      guardianId: GUARDIAN_REQUEST_ID,
      guardianUserId: GUARDIAN_USER_ID,
      repository,
      emit: async () => {
        throw new Error('socket backend down');
      },
    });

    assert.equal(guardian.status, expected, `the persisted ${expected} transition is not rolled back`);
    assert.equal(repository.state.doc.status, expected, 'the transition persists');
  }
});

test('only one accept/reject may win: the loser gets a 409, no event, no transition', async () => {
  // Concurrent: the atomic conditional write makes a second attempt null.
  const repository = makeTransitionRepository({ initialStatus: 'PENDING' });
  const emit = makeEmit();

  const first = await acceptGuardian({
    guardianId: GUARDIAN_REQUEST_ID,
    guardianUserId: GUARDIAN_USER_ID,
    repository,
    emit: emit.fn,
  });
  assert.equal(first.guardian.status, 'ACTIVE');
  assert.equal(emit.calls.length, 1);

  await assert.rejects(
    () =>
      rejectGuardian({
        guardianId: GUARDIAN_REQUEST_ID,
        guardianUserId: GUARDIAN_USER_ID,
        repository,
        emit: emit.fn,
      }),
    (err) => err.statusCode === 409 && err.code === 'GUARDIAN_NOT_PENDING',
    'a rejected operation can never follow a successful accept'
  );

  await assert.rejects(
    () =>
      acceptGuardian({
        guardianId: GUARDIAN_REQUEST_ID,
        guardianUserId: GUARDIAN_USER_ID,
        repository,
        emit: emit.fn,
      }),
    (err) => err.statusCode === 409 && err.code === 'GUARDIAN_NOT_PENDING',
    'a duplicate accept is refused'
  );

  assert.equal(emit.calls.length, 1, 'no duplicate guardian event');
  assert.equal(repository.state.doc.status, 'ACTIVE', 'the first transition stands');
});

test('an unauthorized accept or reject emits nothing and changes nothing', async () => {
  const repository = makeTransitionRepository({ initialStatus: 'PENDING' });
  const emit = makeEmit();

  await assert.rejects(
    () =>
      acceptGuardian({
        guardianId: GUARDIAN_REQUEST_ID,
        guardianUserId: USER_ID, // the requester, not the guardian
        repository,
        emit: emit.fn,
      }),
    (err) => err.statusCode === 404
  );

  await assert.rejects(
    () =>
      rejectGuardian({
        guardianId: GUARDIAN_REQUEST_ID,
        guardianUserId: USER_ID,
        repository,
        emit: emit.fn,
      }),
    (err) => err.statusCode === 404
  );

  assert.equal(repository.state.doc.status, 'PENDING', 'no transition for a foreign caller');
  assert.equal(emit.calls.length, 0, 'no event leaks to anyone');
});
