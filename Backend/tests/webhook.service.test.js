import test from 'node:test';
import assert from 'node:assert/strict';

import { handleLiveKitEvent } from '../src/modules/webhooks/webhook.service.js';

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0a1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0a2';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0a3';
const CALL_ID = '64b0f0f0f0f0f0f0f0f0f0e1';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0b1';
const ROOM_NAME = 'emergency-call-' + CALL_ID;

const USER_IDENTITY = 'user:' + OWNER_ID;
const GUARDIAN_IDENTITY = 'user:' + GUARDIAN_ID;

const callRecord = (overrides = {}) => ({
  _id: CALL_ID,
  sosId: SOS_ID,
  userId: OWNER_ID,
  guardianUserId: GUARDIAN_ID,
  type: 'BROWSER_TO_BROWSER',
  status: 'ACCEPTED',
  roomName: ROOM_NAME,
  participants: [
    { userId: OWNER_ID, identity: USER_IDENTITY, role: 'USER', joinedAt: null },
    { userId: GUARDIAN_ID, identity: GUARDIAN_IDENTITY, role: 'GUARDIAN', joinedAt: null },
  ],
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  connectedAt: null,
  endedAt: null,
  endReason: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const FORBIDDEN_REPOSITORY_METHODS = [
  'createCall',
  'findSOSById',
  'findActiveGuardians',
  'endCallAtomically',
];

const makeRepository = ({ call = callRecord(), room = ROOM_NAME } = {}) => {
  const state = { call };
  const writes = [];

  const repository = {
    state,
    writes,
    invoked: [],
    findCallByRoomName: async (roomName) =>
      state.call && state.call.roomName === roomName ? state.call : null,
    findById: async () => state.call,
    markParticipantJoined: async (callId, identity) => {
      const participant = state.call.participants.find((p) => p.identity === identity);
      if (!participant || participant.joinedAt) return null;
      participant.joinedAt = new Date();
      writes.push({ joinedAt: identity });
      return state.call;
    },
    markParticipantLeft: async (callId, identity) => {
      const participant = state.call.participants.find((p) => p.identity === identity);
      if (!participant || !participant.joinedAt) return null;
      participant.joinedAt = null;
      writes.push({ leftAt: identity });
      return state.call;
    },
    markConnected: async (callId, allowed, connectedAt) => {
      if (!allowed.includes(state.call.status)) return null;
      state.call = { ...state.call, status: 'CONNECTED', connectedAt, updatedAt: connectedAt };
      writes.push({ status: 'CONNECTED' });
      return state.call;
    },
    markEndedFromWebhook: async (callId, allowed, { endedAt, endReason }) => {
      if (!allowed.includes(state.call.status)) return null;
      state.call = { ...state.call, status: 'ENDED', endedAt, endReason, updatedAt: endedAt };
      writes.push({ status: 'ENDED', endReason });
      return state.call;
    },
    markFailedFromWebhook: async (callId, allowed, { endedAt, endReason }) => {
      if (!allowed.includes(state.call.status)) return null;
      state.call = { ...state.call, status: 'FAILED', endedAt, endReason, updatedAt: endedAt };
      writes.push({ status: 'FAILED', endReason });
      return state.call;
    },
  };

  for (const name of FORBIDDEN_REPOSITORY_METHODS) {
    repository[name] = async () => {
      repository.invoked.push(name);
      throw new Error(`the webhook must not call ${name}`);
    };
  }

  return repository;
};

const makeEmit = () => {
  const calls = [];
  return {
    calls,
    fn: (userId, event, payload) => {
      calls.push({ userId: String(userId), event, payload });
      return true;
    },
  };
};

const makeLog = () => {
  const lines = [];
  return { lines, info: (line) => lines.push(String(line)) };
};

const roomEvent = (type, overrides = {}) => ({
  id: 'evt_' + type,
  event: type,
  createdAt: 1759000000,
  room: { name: ROOM_NAME, sid: 'RM_1' },
  ...overrides,
});

const participantEvent = (type, identity, overrides = {}) => ({
  id: 'evt_' + type + '_' + identity,
  event: type,
  createdAt: 1759000000,
  room: { name: ROOM_NAME, sid: 'RM_1' },
  participant: { identity, sid: 'PA_1', state: 'ACTIVE' },
  ...overrides,
});

const handle = (event, repository, emit, logger) =>
  handleLiveKitEvent(event, { repository, emit: emit.fn, logger });

test('room_started never marks the call connected', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  const result = await handle(roomEvent('room_started'), repository, emit, makeLog());

  assert.equal(result.handled, true);
  assert.equal(result.changed, false);
  assert.equal(repository.state.call.status, 'ACCEPTED', 'a room alone proves nothing');
  assert.equal(repository.state.call.connectedAt, null);
  assert.equal(emit.calls.length, 0, 'no socket event for a room opening');
});

test('room_started for an unknown room does not create a call', async () => {
  const repository = makeRepository({ room: 'attacker-room' });
  const emit = makeEmit();

  const result = await handle(
    roomEvent('room_started', { room: { name: 'attacker-room' } }),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.handled, true, 'the webhook is still acknowledged');
  assert.equal(result.callId, null);
  assert.equal(repository.writes.length, 0);
  assert.equal(emit.calls.length, 0);
  assert.deepEqual(repository.invoked, [], 'no call document is ever created');
});

test('participant_joined records presence but does not connect one participant', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  const result = await handle(
    participantEvent('participant_joined', USER_IDENTITY),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, false, 'both participants must be in the room');
  assert.equal(repository.state.call.participants[0].joinedAt instanceof Date, true);
  assert.equal(repository.state.call.status, 'ACCEPTED');
  assert.equal(emit.calls.length, 0);
});

test('participant_joined connects the call once both participants are present', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  await handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog());
  const result = await handle(
    participantEvent('participant_joined', GUARDIAN_IDENTITY),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, true);
  assert.equal(repository.state.call.status, 'CONNECTED');
  assert.ok(repository.state.call.connectedAt instanceof Date, 'connectedAt is server generated');
  assert.equal(repository.state.call.endedAt, null);

  assert.equal(emit.calls.length, 2, 'both participants are notified');
  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:connected', 'call:connected']
  );
  assert.deepEqual(
    emit.calls.map((e) => e.userId).sort(),
    [GUARDIAN_ID, OWNER_ID].sort()
  );
  for (const { payload } of emit.calls) {
    assert.equal(payload.callId, CALL_ID);
    assert.equal(payload.sosId, SOS_ID);
    assert.equal(payload.status, 'CONNECTED', 'the event says the call is connected');
    assert.equal(payload.type, 'BROWSER_TO_BROWSER');
    assert.equal(payload.connectedAt, repository.state.call.connectedAt.toISOString());
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['callId', 'connectedAt', 'sosId', 'status', 'type'],
      'exactly the recommended payload, nothing else'
    );
  }
  assert.deepEqual(repository.invoked, [], 'the webhook never touches the SOS on connect');
});

test('participant_joined never jumps into CONNECTED from another state', async () => {
  for (const status of ['OUTGOING', 'RINGING', 'ENDED', 'REJECTED', 'CANCELLED', 'FAILED']) {
    const call = callRecord({ status });
    call.participants = call.participants.map((p) => ({ ...p, joinedAt: new Date() }));
    const repository = makeRepository({ call });
    const emit = makeEmit();

    const result = await handle(
      participantEvent('participant_joined', USER_IDENTITY),
      repository,
      emit,
      makeLog()
    );

    assert.equal(result.changed, false, status);
    assert.equal(repository.state.call.status, status, status + ' is preserved');
    assert.equal(emit.calls.length, 0, status);
  }
});

test('participant_joined ignores an unknown participant', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  const result = await handle(
    participantEvent('participant_joined', 'user:' + STRANGER_ID),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, false);
  assert.equal(repository.writes.length, 0, 'presence is not recorded for a stranger');
  assert.equal(repository.state.call.status, 'ACCEPTED');
  assert.equal(emit.calls.length, 0, 'an unknown participant can never impersonate anyone');
});

test('a duplicate participant_joined does not connect twice', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  await handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog());
  await handle(participantEvent('participant_joined', GUARDIAN_IDENTITY), repository, emit, makeLog());
  const connectedAt = repository.state.call.connectedAt;

  const replay = await handle(
    participantEvent('participant_joined', GUARDIAN_IDENTITY),
    repository,
    emit,
    makeLog()
  );

  assert.equal(replay.changed, false, 'the second delivery is a no-op');
  assert.equal(repository.state.call.connectedAt.getTime(), connectedAt.getTime(), 'timestamp kept');
  assert.equal(emit.calls.length, 2, 'no duplicate socket event');
  assert.equal(repository.state.call.status, 'CONNECTED');
});

test('call:connected is emitted only after the database connected the call', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();
  const order = [];

  const originalConnect = repository.markConnected;
  repository.markConnected = async (...args) => {
    order.push('db');
    return originalConnect(...args);
  };
  const originalEmit = emit.fn;
  emit.fn = (userId, event, payload) => {
    order.push(event);
    return originalEmit(userId, event, payload);
  };

  await handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog());
  await handle(participantEvent('participant_joined', GUARDIAN_IDENTITY), repository, emit, makeLog());

  assert.equal(repository.state.call.status, 'CONNECTED');
  assert.deepEqual(
    order,
    ['db', 'call:connected', 'call:connected'],
    'the atomic transition happens before any socket event, and only once'
  );
});

test('a database failure during the transition emits nothing', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  repository.markConnected = async () => {
    throw new Error('database down');
  };

  await handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog());
  await assert.rejects(
    () =>
      handle(participantEvent('participant_joined', GUARDIAN_IDENTITY), repository, emit, makeLog()),
    /database down/
  );

  assert.equal(emit.calls.length, 0, 'no call:connected without a successful write');
  assert.equal(repository.state.call.status, 'ACCEPTED', 'the call is still waiting');
  assert.equal(repository.state.call.connectedAt, null, 'no phantom connectedAt');
});

test('two participants joining nearly simultaneously connect exactly once', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  const results = await Promise.all([
    handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog()),
    handle(participantEvent('participant_joined', GUARDIAN_IDENTITY), repository, emit, makeLog()),
  ]);

  assert.equal(
    results.filter((r) => r.changed).length,
    1,
    'the atomic ACCEPTED → CONNECTED guard wins once'
  );
  assert.equal(repository.state.call.status, 'CONNECTED');
  assert.equal(emit.calls.length, 2, 'exactly one call:connected per participant');
  for (const { event } of emit.calls) assert.equal(event, 'call:connected');
  assert.ok(repository.state.call.connectedAt instanceof Date, 'connectedAt written once');
});

test('an out-of-order join before ACCEPTED only records presence and connects later', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'RINGING' }) });
  const emit = makeEmit();

  await handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog());

  assert.equal(repository.state.call.status, 'RINGING', 'no jump into CONNECTED while ringing');
  assert.equal(emit.calls.length, 0, 'no call:connected before the guardian accepted');

  repository.state.call = { ...repository.state.call, status: 'ACCEPTED' };

  await handle(participantEvent('participant_joined', GUARDIAN_IDENTITY), repository, emit, makeLog());

  assert.equal(repository.state.call.status, 'CONNECTED');
  assert.equal(emit.calls.length, 2, 'the later, in-order event still connects the call');
});

test('participant_joined for an unknown room changes nothing', async () => {
  const repository = makeRepository({ room: 'attacker-room' });
  const emit = makeEmit();

  const result = await handle(
    participantEvent('participant_joined', USER_IDENTITY, { room: { name: 'attacker-room' } }),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.handled, true, 'the webhook is still acknowledged');
  assert.equal(result.callId, null);
  assert.equal(repository.writes.length, 0, 'presence is never recorded for a stranger room');
  assert.equal(emit.calls.length, 0);
  assert.deepEqual(repository.invoked, [], 'no call document is ever created');
});

test('participant_left finalizes an active call and notifies both sides', async () => {
  const call = callRecord({ status: 'CONNECTED', connectedAt: new Date('2026-01-01T00:05:00.000Z') });
  call.participants = call.participants.map((p) => ({ ...p, joinedAt: new Date() }));
  const repository = makeRepository({ call });
  const emit = makeEmit();
  const order = [];

  const original = repository.markEndedFromWebhook;
  repository.markEndedFromWebhook = async (...args) => {
    order.push('db');
    return original(...args);
  };
  const originalEmit = emit.fn;
  emit.fn = (userId, event, payload) => {
    order.push(event);
    return originalEmit(userId, event, payload);
  };

  const result = await handle(
    participantEvent('participant_left', GUARDIAN_IDENTITY),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, true);
  assert.equal(repository.state.call.status, 'ENDED');
  assert.equal(repository.state.call.endReason, 'PARTICIPANT_LEFT');
  assert.ok(repository.state.call.endedAt instanceof Date);
  assert.equal(repository.state.call.participants[1].joinedAt, null, 'presence cleared');

  assert.equal(order[0], 'db', 'the database update happens before any socket event');
  assert.deepEqual(
    order.slice(1),
    ['call:disconnected', 'call:disconnected', 'call:ended', 'call:ended'],
    'then the disconnect reaches both participants, then the end'
  );
  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:disconnected', 'call:disconnected', 'call:ended', 'call:ended']
  );
  assert.deepEqual(
    new Set(emit.calls.map((e) => e.userId)),
    new Set([OWNER_ID, GUARDIAN_ID]),
    'only the two participants hear about it'
  );

  const ended = emit.calls.find((e) => e.event === 'call:ended');
  assert.equal(ended.payload.callId, CALL_ID);
  assert.equal(ended.payload.sosId, SOS_ID);
  assert.equal(ended.payload.status, 'ENDED');
  assert.equal(ended.payload.type, 'BROWSER_TO_BROWSER');
  assert.equal(ended.payload.endedBy, null, 'the system ended it, not a user');
  assert.equal(ended.payload.endReason, 'PARTICIPANT_LEFT');
  assert.equal(ended.payload.endedAt, repository.state.call.endedAt.toISOString());
  assert.deepEqual(
    Object.keys(ended.payload).sort(),
    ['callId', 'endReason', 'endedAt', 'endedBy', 'sosId', 'status', 'type'],
    'exactly the recommended payload, nothing else'
  );

  const disconnected = emit.calls.find((e) => e.event === 'call:disconnected');
  assert.equal(disconnected.payload.identity, GUARDIAN_IDENTITY);
});

test('participant_left leaves a terminal call completely alone', async () => {
  for (const status of ['ENDED', 'FAILED', 'CANCELLED', 'REJECTED']) {
    const originalEnd = new Date('2026-02-01T00:00:00.000Z');
    const call = callRecord({ status, endedAt: originalEnd, endReason: 'USER_ENDED' });
    call.participants = call.participants.map((p) => ({ ...p, joinedAt: new Date() }));
    const repository = makeRepository({ call });
    const emit = makeEmit();

    const result = await handle(
      participantEvent('participant_left', GUARDIAN_IDENTITY),
      repository,
      emit,
      makeLog()
    );

    assert.equal(result.changed, false, status);
    assert.equal(repository.state.call.status, status, status + ' is preserved');
    assert.equal(repository.state.call.endedAt.getTime(), originalEnd.getTime(), 'endedAt kept');
    assert.equal(repository.writes.length, 0, 'no write at all');
    assert.equal(emit.calls.length, 0, 'no notification');
  }
});

test('a disconnect processed after the application ended the call reports no second ending', async () => {
  const repository = makeRepository({
    call: callRecord({ status: 'CONNECTED', connectedAt: new Date() }),
  });
  repository.state.call.participants = repository.state.call.participants.map((p) => ({
    ...p,
    joinedAt: new Date(),
  }));
  const emit = makeEmit();

  // POST /calls/end won between this webhook's read and its write.
  repository.markEndedFromWebhook = async () => null;

  const result = await handle(
    participantEvent('participant_left', USER_IDENTITY),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, true, 'presence was still recorded');
  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:disconnected', 'call:disconnected'],
    'the drop is reported, but the application-owned ending is not repeated'
  );
  assert.ok(
    !emit.calls.some((e) => e.event === 'call:ended'),
    'no duplicate call:ended after the endpoint already ended the call'
  );
});

test('a database failure during the webhook end transition emits nothing', async () => {
  const repository = makeRepository({
    call: callRecord({ status: 'CONNECTED', connectedAt: new Date() }),
  });
  const emit = makeEmit();

  repository.markEndedFromWebhook = async () => {
    throw new Error('database down');
  };

  await assert.rejects(
    () => handle(roomEvent('room_finished'), repository, emit, makeLog()),
    /database down/
  );

  assert.equal(emit.calls.length, 0, 'no call:ended without a successful write');
  assert.equal(repository.state.call.status, 'CONNECTED', 'the call keeps its state');
});

test('participant_left ignores an unknown participant', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'CONNECTED' }) });
  const emit = makeEmit();

  const result = await handle(
    participantEvent('participant_left', 'user:' + STRANGER_ID),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, false);
  assert.equal(repository.state.call.status, 'CONNECTED');
  assert.equal(repository.writes.length, 0);
  assert.equal(emit.calls.length, 0);
});

test('room_finished ends an in-flight call that never connected', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'RINGING' }) });
  const emit = makeEmit();

  const result = await handle(roomEvent('room_finished'), repository, emit, makeLog());

  assert.equal(result.changed, true);
  assert.equal(repository.state.call.status, 'ENDED');
  assert.equal(repository.state.call.endReason, 'ROOM_FINISHED');
  assert.ok(repository.state.call.endedAt instanceof Date);

  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:ended', 'call:ended'],
    'nothing was connected, so no disconnect event — one end per participant'
  );
});

test('room_finished on a connected call reports the disconnect before the end', async () => {
  const call = callRecord({ status: 'CONNECTED', connectedAt: new Date() });
  call.participants = call.participants.map((p) => ({ ...p, joinedAt: new Date() }));
  const repository = makeRepository({ call });
  const emit = makeEmit();

  const result = await handle(roomEvent('room_finished'), repository, emit, makeLog());

  assert.equal(result.changed, true);
  assert.equal(repository.state.call.status, 'ENDED');

  assert.deepEqual(
    emit.calls.filter((e) => e.userId === OWNER_ID).map((e) => e.event),
    ['call:disconnected', 'call:ended']
  );
  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:disconnected', 'call:disconnected', 'call:ended', 'call:ended'],
    'everyone hears about the disconnect before anyone hears about the end'
  );
});

test('room_finished does not overwrite a terminal call', async () => {
  for (const status of ['ENDED', 'REJECTED', 'CANCELLED', 'FAILED']) {
    const originalEnd = new Date('2026-03-01T00:00:00.000Z');
    const repository = makeRepository({
      call: callRecord({ status, endedAt: originalEnd, endReason: 'USER_ENDED' }),
    });
    const emit = makeEmit();

    const result = await handle(roomEvent('room_finished'), repository, emit, makeLog());

    assert.equal(result.changed, false, status);
    assert.equal(repository.state.call.status, status);
    assert.equal(repository.state.call.endedAt.getTime(), originalEnd.getTime());
    assert.equal(repository.writes.length, 0, status);
    assert.equal(emit.calls.length, 0, status);
  }
});

test('participant_connection_aborted marks the call FAILED and reports call:failed', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'RINGING' }) });
  const emit = makeEmit();

  const result = await handle(
    participantEvent('participant_connection_aborted', USER_IDENTITY),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, true);
  assert.equal(repository.state.call.status, 'FAILED');
  assert.equal(repository.state.call.endReason, 'FAILED');
  assert.ok(repository.state.call.endedAt instanceof Date);
  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:failed', 'call:failed'],
    'an unrecoverable failure is call:failed, never a retryable call:disconnected'
  );
  assert.deepEqual(
    emit.calls.map((e) => e.userId).sort(),
    [GUARDIAN_ID, OWNER_ID].sort(),
    'both participants, private rooms only'
  );
  for (const { payload } of emit.calls) {
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['callId', 'failedAt', 'reason', 'sosId', 'status', 'type'],
      'exactly the recommended payload, nothing else'
    );
    assert.equal(payload.callId, CALL_ID);
    assert.equal(payload.sosId, SOS_ID);
    assert.equal(payload.status, 'FAILED');
    assert.equal(payload.type, 'BROWSER_TO_BROWSER');
    assert.equal(payload.failedAt, repository.state.call.endedAt.toISOString());
    assert.equal(payload.reason, 'FAILED', 'a safe user-facing reason, never internals');
  }
  assert.deepEqual(repository.invoked, [], 'the failure never touches the SOS');
});

test('a verified LiveKit failure fails the call from every in-flight state', async () => {
  for (const status of ['OUTGOING', 'RINGING', 'ACCEPTED', 'CONNECTED']) {
    const repository = makeRepository({ call: callRecord({ status }) });
    const emit = makeEmit();

    const result = await handle(
      participantEvent('participant_connection_aborted', USER_IDENTITY),
      repository,
      emit,
      makeLog()
    );

    assert.equal(result.changed, true, status);
    assert.equal(repository.state.call.status, 'FAILED', status + ' → FAILED');
    assert.equal(repository.state.call.endReason, 'FAILED', status);
    assert.ok(repository.state.call.endedAt instanceof Date, status);
    assert.deepEqual(
      emit.calls.map((e) => e.event),
      ['call:failed', 'call:failed'],
      status
    );
    assert.deepEqual(
      emit.calls.map((e) => e.userId).sort(),
      [GUARDIAN_ID, OWNER_ID].sort(),
      status
    );
    for (const { payload } of emit.calls) {
      assert.equal(payload.status, 'FAILED', status);
      assert.equal(payload.failedAt, repository.state.call.endedAt.toISOString(), status);
      assert.equal(payload.reason, 'FAILED', status);
    }
  }
});

test('failure never overwrites a terminal state', async () => {
  for (const status of ['ENDED', 'REJECTED', 'CANCELLED', 'FAILED']) {
    const originalEnd = new Date('2026-04-01T00:00:00.000Z');
    const repository = makeRepository({
      call: callRecord({ status, endedAt: originalEnd, endReason: 'USER_ENDED' }),
    });
    const emit = makeEmit();

    const result = await handle(
      participantEvent('participant_connection_aborted', USER_IDENTITY),
      repository,
      emit,
      makeLog()
    );

    assert.equal(result.changed, false, status);
    assert.equal(repository.state.call.status, status, status + ' is preserved');
    assert.equal(
      repository.state.call.endedAt.getTime(),
      originalEnd.getTime(),
      'the original timestamp is kept'
    );
    assert.equal(repository.writes.length, 0, status);
    assert.equal(emit.calls.length, 0, status + ' never produces call:failed');
  }
});

test('a late failure cannot overwrite ENDED after a connected call ended normally', async () => {
  const repository = makeRepository({
    call: callRecord({ status: 'CONNECTED', connectedAt: new Date('2026-01-01T00:05:00.000Z') }),
  });
  const emit = makeEmit();
  repository.state.call.participants = repository.state.call.participants.map((p) => ({
    ...p,
    joinedAt: new Date(),
  }));

  await handle(roomEvent('room_finished'), repository, emit, makeLog());
  assert.equal(repository.state.call.status, 'ENDED');
  const writesAfterEnd = repository.writes.length;
  const eventsAfterEnd = emit.calls.length;

  const late = await handle(
    participantEvent('participant_connection_aborted', USER_IDENTITY),
    repository,
    emit,
    makeLog()
  );

  assert.equal(late.changed, false, 'the delayed failure is acknowledged but ignored');
  assert.equal(repository.state.call.status, 'ENDED', 'remains ENDED');
  assert.equal(repository.writes.length, writesAfterEnd, 'no second terminal write');
  assert.equal(emit.calls.length, eventsAfterEnd, 'no call:failed after the end');
  assert.ok(
    !emit.calls.some((e) => e.event === 'call:failed'),
    'an old failure event never resurrects a finished call'
  );
});

test('a concurrent failure and room_finished produce exactly one terminal outcome', async () => {
  const repository = makeRepository({
    call: callRecord({ status: 'CONNECTED', connectedAt: new Date() }),
  });
  repository.state.call.participants = repository.state.call.participants.map((p) => ({
    ...p,
    joinedAt: new Date(),
  }));
  const emit = makeEmit();

  const [failResult, endResult] = await Promise.all([
    handle(participantEvent('participant_connection_aborted', USER_IDENTITY), repository, emit, makeLog()),
    handle(roomEvent('room_finished'), repository, emit, makeLog()),
  ]);

  const winners = [failResult, endResult].filter((r) => r.changed);
  assert.equal(winners.length, 1, 'exactly one handler wins the terminal transition');

  const events = emit.calls.map((e) => e.event);
  if (failResult.changed) {
    assert.equal(repository.state.call.status, 'FAILED');
    assert.deepEqual(events, ['call:failed', 'call:failed']);
  } else {
    assert.equal(repository.state.call.status, 'ENDED');
    assert.deepEqual(
      events,
      ['call:disconnected', 'call:disconnected', 'call:ended', 'call:ended']
    );
  }
});

test('a failure racing a concurrent call end leaves the ended state intact', async () => {
  const repository = makeRepository({
    call: callRecord({ status: 'CONNECTED', connectedAt: new Date() }),
  });
  const emit = makeEmit();

  // POST /calls/:id/end commits ENDED between our read and the failure write.
  const originalFail = repository.markFailedFromWebhook;
  repository.markFailedFromWebhook = async (...args) => {
    await repository.markEndedFromWebhook(
      repository.state.call._id,
      ['CREATED', 'OUTGOING', 'RINGING', 'ACCEPTED', 'CONNECTED'],
      { endedAt: new Date(), endReason: 'USER_ENDED' }
    );
    return originalFail(...args);
  };

  const result = await handle(
    participantEvent('participant_connection_aborted', USER_IDENTITY),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, false, 'the concurrent end already finalized the call');
  assert.equal(repository.state.call.status, 'ENDED');
  assert.equal(repository.state.call.endReason, 'USER_ENDED', 'the failure does not overwrite it');
  assert.equal(emit.calls.length, 0, 'no call:failed after the call already ended');
});

test('a failure racing a successful connection resolves to a single terminal state', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  await Promise.all([
    handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog()),
    handle(participantEvent('participant_joined', GUARDIAN_IDENTITY), repository, emit, makeLog()),
    handle(participantEvent('participant_connection_aborted', USER_IDENTITY), repository, emit, makeLog()),
  ]);

  const events = emit.calls.map((e) => e.event);
  const connectedCount = events.filter((e) => e === 'call:connected').length;
  const failedCount = events.filter((e) => e === 'call:failed').length;

  assert.equal(repository.state.call.status, 'FAILED', 'the failure wins the terminal state');
  assert.equal(failedCount, 2, 'one call:failed per participant');
  assert.ok(connectedCount === 0 || connectedCount === 2, 'never half of a notification pair');
  assert.equal(
    repository.writes.filter((w) => w.status === 'FAILED').length,
    1,
    'exactly one terminal transition'
  );
});

test('a database failure during the failed transition emits nothing', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  repository.markFailedFromWebhook = async () => {
    throw new Error('database down');
  };

  await assert.rejects(
    () =>
      handle(
        participantEvent('participant_connection_aborted', USER_IDENTITY),
        repository,
        emit,
        makeLog()
      ),
    /database down/
  );

  assert.equal(emit.calls.length, 0, 'no call:failed without a successful write');
  assert.equal(repository.state.call.status, 'ACCEPTED', 'the call keeps its current state');
  assert.equal(repository.state.call.endedAt, null, 'no phantom failedAt');
});

test('a socket outage never fails the call:failed transition', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });

  const result = await handleLiveKitEvent(
    participantEvent('participant_connection_aborted', USER_IDENTITY),
    {
      repository,
      emit: () => {
        throw new Error('socket down');
      },
      logger: makeLog(),
    }
  );

  assert.equal(result.changed, true);
  assert.equal(repository.state.call.status, 'FAILED', 'the state change still stands');
  assert.equal(repository.state.call.endReason, 'FAILED');
});

test('participant_connection_aborted ignores unknown rooms and unknown participants', async () => {
  const unknownRoomRepository = makeRepository({ room: 'attacker-room' });
  const roomEmit = makeEmit();

  const roomResult = await handle(
    participantEvent('participant_connection_aborted', USER_IDENTITY, {
      room: { name: 'attacker-room' },
    }),
    unknownRoomRepository,
    roomEmit,
    makeLog()
  );

  assert.equal(roomResult.handled, true, 'the webhook is still acknowledged');
  assert.equal(roomResult.callId, null);
  assert.equal(unknownRoomRepository.writes.length, 0);
  assert.equal(roomEmit.calls.length, 0);
  assert.deepEqual(unknownRoomRepository.invoked, [], 'no call document is ever created');

  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  const result = await handle(
    participantEvent('participant_connection_aborted', 'user:' + STRANGER_ID),
    repository,
    emit,
    makeLog()
  );

  assert.equal(result.changed, false);
  assert.equal(repository.writes.length, 0, 'a stranger can never fail the call');
  assert.equal(repository.state.call.status, 'ACCEPTED');
  assert.equal(emit.calls.length, 0);
});

test('unsupported events are acknowledged without touching the call', async () => {
  const repository = makeRepository();
  const emit = makeEmit();

  for (const event of [
    { id: 'evt1', event: 'track_published', room: { name: ROOM_NAME } },
    { id: 'evt2', event: 'sip_call_incoming', room: { name: ROOM_NAME } },
    { id: 'evt3', event: 'agent_job_started', room: { name: ROOM_NAME } },
  ]) {
    const result = await handle(event, repository, emit, makeLog());

    assert.equal(result.handled, false, event.event);
    assert.equal(result.changed, false, event.event);
  }

  assert.equal(repository.writes.length, 0);
  assert.equal(emit.calls.length, 0);
  assert.deepEqual(repository.invoked, []);
});

test('the webhook never touches the SOS and never creates a call', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'CONNECTED' }) });
  const emit = makeEmit();

  await handle(participantEvent('participant_left', USER_IDENTITY), repository, emit, makeLog());

  assert.deepEqual(repository.invoked, [], 'no SOS read/write, no call creation');
  assert.equal(repository.state.call.sosId, SOS_ID, 'sosId is never rewritten');
  assert.equal(String(repository.state.call.userId), OWNER_ID, 'ownership is never rewritten');
  assert.equal(String(repository.state.call.guardianUserId), GUARDIAN_ID);
});

test('updates only ever carry backend-generated fields', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  await handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog());
  await handle(participantEvent('participant_joined', GUARDIAN_IDENTITY), repository, emit, makeLog());

  for (const write of repository.writes) {
    const allowed = ['status', 'connectedAt', 'endedAt', 'endReason', 'updatedAt', 'joinedAt', 'leftAt'];
    for (const key of Object.keys(write)) {
      assert.ok(allowed.includes(key), `unexpected field ${key}`);
    }
  }
});

test('a socket outage never fails webhook processing', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'CONNECTED' }) });

  const result = await handleLiveKitEvent(participantEvent('participant_left', USER_IDENTITY), {
    repository,
    emit: () => {
      throw new Error('socket down');
    },
    logger: makeLog(),
  });

  assert.equal(result.changed, true);
  assert.equal(repository.state.call.status, 'ENDED', 'the state change still stands');
});

test('payloads never contain LiveKit credentials', async () => {
  const repository = makeRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  await handle(participantEvent('participant_joined', USER_IDENTITY), repository, emit, makeLog());
  await handle(participantEvent('participant_joined', GUARDIAN_IDENTITY), repository, emit, makeLog());
  await handle(participantEvent('participant_left', USER_IDENTITY), repository, emit, makeLog());

  const raw = JSON.stringify(emit.calls);
  assert.equal(repository.state.call.status, 'ENDED');
  assert.ok(raw.includes('call:connected'), 'the connect payload was inspected too');
  assert.ok(!raw.includes('apiSecret'), 'no API secret');
  assert.ok(!raw.includes('LIVEKIT_API_SECRET'));
  assert.ok(!raw.includes('token'), 'no access token');
  assert.ok(!raw.includes('jwt'));
  assert.ok(!raw.includes(ROOM_NAME), 'the payload does not echo the room');

  const connectedRaw = JSON.stringify(emit.calls.filter((e) => e.event === 'call:connected'));
  assert.ok(!connectedRaw.includes(USER_IDENTITY), 'no participant identities');
  assert.ok(!connectedRaw.includes(GUARDIAN_IDENTITY), 'no participant identities');
});
