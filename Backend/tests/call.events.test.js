import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CALL_EVENT,
  callOutgoingPayload,
  callRingingPayload,
  callAcceptedPayload,
  callRejectedPayload,
  callConnectedPayload,
  callFailedPayload,
  callEndedPayload,
  emitCallOutgoing,
  emitCallRinging,
  emitCallAccepted,
  emitCallRejected,
  emitCallConnected,
  emitCallFailed,
  emitCallEnded,
  safeEmit,
} from '../src/modules/calling/call.events.js';
import { env } from '../src/config/env.js';

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0a1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0a2';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0a3';

const callRecord = (overrides = {}) => ({
  _id: '64b0f0f0f0f0f0f0f0f0f0e1',
  sosId: '64b0f0f0f0f0f0f0f0f0f0b1',
  userId: OWNER_ID,
  guardianUserId: GUARDIAN_ID,
  type: 'BROWSER_TO_BROWSER',
  status: 'OUTGOING',
  roomName: 'emergency-call-64b0f0f0f0f0f0f0f0f0f0e1',
  createdAt: new Date('2026-09-30T05:40:00.000Z'),
  ...overrides,
});

const ringingCall = (overrides = {}) =>
  callRecord({
    status: 'RINGING',
    ringingAt: new Date('2026-09-30T05:40:01.000Z'),
    ...overrides,
  });

const ACCEPTED_AT = new Date('2026-09-30T08:30:00.000Z');

const acceptedCall = (overrides = {}) =>
  callRecord({
    status: 'ACCEPTED',
    updatedAt: ACCEPTED_AT,
    ...overrides,
  });

const ENDED_AT = new Date('2026-09-30T08:35:00.000Z');

const rejectedCall = (overrides = {}) =>
  callRecord({
    status: 'REJECTED',
    endReason: 'GUARDIAN_REJECTED',
    endedAt: ENDED_AT,
    updatedAt: ENDED_AT,
    ...overrides,
  });

const CONNECTED_AT = new Date('2026-09-30T08:31:00.000Z');

const connectedCall = (overrides = {}) =>
  callRecord({
    status: 'CONNECTED',
    connectedAt: CONNECTED_AT,
    updatedAt: CONNECTED_AT,
    ...overrides,
  });

const FAILED_AT = new Date('2026-09-30T08:32:00.000Z');

const failedCall = (overrides = {}) =>
  callRecord({
    status: 'FAILED',
    endedAt: FAILED_AT,
    endReason: 'FAILED',
    updatedAt: FAILED_AT,
    ...overrides,
  });

const TERMINATED_AT = new Date('2026-09-30T08:33:00.000Z');

const endedCall = (overrides = {}) =>
  callRecord({
    status: 'ENDED',
    endedAt: TERMINATED_AT,
    endReason: 'USER_ENDED',
    updatedAt: TERMINATED_AT,
    ...overrides,
  });

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

test('the outgoing event uses the exact event name', () => {
  assert.equal(CALL_EVENT.OUTGOING, 'call:outgoing');
});

test('callOutgoingPayload exposes exactly the fields the frontend needs', () => {
  const payload = callOutgoingPayload(callRecord());

  assert.deepEqual(Object.keys(payload).sort(), [
    'callId',
    'createdAt',
    'guardianUserId',
    'sosId',
    'status',
    'type',
  ]);
  assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
  assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
  assert.equal(payload.status, 'OUTGOING');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.equal(payload.guardianUserId, GUARDIAN_ID);
  assert.equal(payload.createdAt, '2026-09-30T05:40:00.000Z', 'serialised for the wire');
});

test('callOutgoingPayload normalises ids and tolerates missing values', () => {
  const mongooseLike = callRecord({
    _id: { toString: () => '64b0f0f0f0f0f0f0f0f0f0e1' },
    sosId: null,
    guardianUserId: null,
    createdAt: '2026-09-30T05:40:00.000Z',
  });

  const payload = callOutgoingPayload(mongooseLike);
  assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
  assert.equal(payload.sosId, null);
  assert.equal(payload.guardianUserId, null);
  assert.equal(payload.createdAt, '2026-09-30T05:40:00.000Z');

  const bare = callOutgoingPayload({ _id: 'x', status: 'OUTGOING', type: 'BROWSER_TO_BROWSER' });
  assert.equal(bare.createdAt, null, 'a missing timestamp never breaks the event');
  assert.equal(bare.sosId, null);
});

test('callOutgoingPayload never carries credentials or connection details', () => {
  const payload = callOutgoingPayload(
    callRecord({
      // Everything a leaked document could contain must stay out of the wire.
      apiSecret: env.livekit.apiSecret,
      apiKey: env.livekit.apiKey,
      token: 'stolen-jwt',
      accessToken: 'stolen-jwt',
      password: 'hunter2',
      passwordHash: '$2b$10$hash',
      serverUrl: env.livekit.url,
      identities: { [OWNER_ID]: 'user:' + OWNER_ID },
      participants: [],
    })
  );

  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes(env.livekit.apiSecret), 'the configured secret never leaks');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes(env.livekit.url), 'no provider url');
  assert.ok(!raw.includes('roomName'), 'no connection details');
  assert.ok(!raw.includes('identities'));
  assert.ok(!raw.includes('participants'), 'no internal document fields');
});

test('emitCallOutgoing targets only the SOS owner private room', async () => {
  const emit = makeEmit();

  await emitCallOutgoing({ call: callRecord(), emit: emit.fn });

  assert.equal(emit.calls.length, 1, 'a single notification, never a broadcast');
  assert.equal(emit.calls[0].userId, OWNER_ID, 'the authenticated call.userId');
  assert.equal(emit.calls[0].event, 'call:outgoing');
  assert.equal(emit.calls[0].payload.status, 'OUTGOING');

  const recipients = new Set(emit.calls.map((c) => c.userId));
  assert.deepEqual([...recipients], [OWNER_ID], 'the guardian is not a recipient of this event');
});

test('emitCallOutgoing never rejects when the socket channel fails', async () => {
  const emit = makeEmit();

  await assert.doesNotReject(() =>
    emitCallOutgoing({
      call: callRecord(),
      emit: () => {
        throw new Error('socket down');
      },
    })
  );

  assert.equal(emit.calls.length, 0);
});

test('emitCallOutgoing awaits a slow delivery without losing the notification', async () => {
  const delivered = [];
  const emit = async (userId, event, payload) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    delivered.push({ userId, event });
  };

  await emitCallOutgoing({ call: callRecord(), emit });

  assert.deepEqual(delivered, [{ userId: OWNER_ID, event: 'call:outgoing' }]);
});

test('safeEmit swallows delivery failures so the request still succeeds', async () => {
  const ok = makeEmit();
  assert.equal(await safeEmit(ok.fn, OWNER_ID, 'call:outgoing', {}), undefined);
  assert.equal(ok.calls.length, 1);

  await assert.doesNotReject(() =>
    safeEmit(
      () => {
        throw new Error('socket down');
      },
      OWNER_ID,
      'call:outgoing',
      {}
    )
  );
});

test('the ringing event uses the exact event name', () => {
  assert.equal(CALL_EVENT.RINGING, 'call:ringing');
});

test('callRingingPayload gives the guardian exactly what the incoming-call UI needs', () => {
  const payload = callRingingPayload({ call: ringingCall(), callerName: 'Ansuman' });

  assert.deepEqual(Object.keys(payload).sort(), [
    'callId',
    'caller',
    'createdAt',
    'ringingAt',
    'sosId',
    'status',
    'type',
  ]);
  assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
  assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
  assert.equal(payload.status, 'RINGING');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.deepEqual(payload.caller, { userId: OWNER_ID, name: 'Ansuman' });
  assert.equal(payload.createdAt, '2026-09-30T05:40:00.000Z');
  assert.equal(payload.ringingAt, '2026-09-30T05:40:01.000Z');
});

test('callRingingPayload takes the caller identity from the stored call, not the sender', () => {
  const payload = callRingingPayload({
    call: ringingCall({ userId: { toString: () => OWNER_ID } }),
    callerName: null,
  });

  assert.equal(payload.caller.userId, OWNER_ID, 'read back from call.userId');
  assert.equal(payload.caller.name, null, 'a missing profile never breaks the event');

  const bare = callRingingPayload({ call: { _id: 'x', status: 'RINGING' } });
  assert.equal(bare.ringingAt, null, 'a missing timestamp never breaks the event');
  assert.equal(bare.createdAt, null);
  assert.equal(bare.sosId, null);
});

test('callRingingPayload never carries credentials or connection details', () => {
  const payload = callRingingPayload({
    call: ringingCall({
      apiSecret: env.livekit.apiSecret,
      apiKey: env.livekit.apiKey,
      token: 'stolen-jwt',
      accessToken: 'stolen-jwt',
      password: 'hunter2',
      passwordHash: '$2b$10$hash',
      serverUrl: env.livekit.url,
      identities: { [OWNER_ID]: 'user:' + OWNER_ID },
      participants: [{ userId: OWNER_ID, identity: 'user:' + OWNER_ID, role: 'USER' }],
    }),
    callerName: 'Ansuman',
  });

  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes(env.livekit.apiSecret), 'the configured secret never leaks');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes(env.livekit.url), 'no provider url');
  assert.ok(!raw.includes('roomName'), 'no connection details â€” ringing grants no room access');
  assert.ok(!raw.includes('identities'));
  assert.ok(!raw.includes('participants'), 'no internal document fields');
});

test('emitCallRinging targets only the assigned guardian private room', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallRinging({ call: ringingCall(), callerName: 'Ansuman', emit: emit.fn });

  assert.equal(dispatched, true);
  assert.equal(emit.calls.length, 1, 'a single notification, never a broadcast');
  assert.equal(emit.calls[0].userId, GUARDIAN_ID, 'read from call.guardianUserId');
  assert.equal(emit.calls[0].event, 'call:ringing');
  assert.equal(emit.calls[0].payload.status, 'RINGING');
  assert.deepEqual(
    new Set(emit.calls.map((c) => c.userId)),
    new Set([GUARDIAN_ID]),
    'the owner and every other guardian are excluded'
  );
});

test('call:ringing is withheld for every state that is not RINGING', async () => {
  const forbidden = [
    'CREATED',
    'OUTGOING',
    'ACCEPTED',
    'CONNECTED',
    'REJECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ];

  for (const status of forbidden) {
    const emit = makeEmit();

    const dispatched = await emitCallRinging({ call: ringingCall({ status }), callerName: 'Ansuman', emit: emit.fn });

    assert.equal(dispatched, false, status);
    assert.equal(emit.calls.length, 0, status + ' never produces call:ringing');
  }

  const missing = makeEmit();
  assert.equal(await emitCallRinging({ call: undefined, callerName: 'Ansuman', emit: missing.fn }), false);
  assert.equal(missing.calls.length, 0);
});

test('call:ringing is withheld when no guardian is assigned', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallRinging({
    call: ringingCall({ guardianUserId: null }),
    callerName: 'Ansuman',
    emit: emit.fn,
  });

  assert.equal(dispatched, false, 'there is nobody to ring');
  assert.equal(emit.calls.length, 0, 'no notification to an empty room');
});

test('call:ringing never rejects when the socket channel fails', async () => {
  await assert.doesNotReject(() =>
    emitCallRinging({
      call: ringingCall(),
      callerName: 'Ansuman',
      emit: () => {
        throw new Error('socket down');
      },
    })
  );
});

test('the accepted event uses the exact event name', () => {
  assert.equal(CALL_EVENT.ACCEPTED, 'call:accepted');
});

test('callAcceptedPayload gives the SOS owner exactly what it needs to update state', () => {
  const payload = callAcceptedPayload({
    call: acceptedCall(),
    guardianName: 'Baba',
    acceptedAt: ACCEPTED_AT,
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    'acceptedAt',
    'callId',
    'guardian',
    'sosId',
    'status',
    'type',
  ]);
  assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
  assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
  assert.equal(payload.status, 'ACCEPTED');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.deepEqual(payload.guardian, { userId: GUARDIAN_ID, name: 'Baba' });
  assert.equal(payload.acceptedAt, '2026-09-30T08:30:00.000Z');
});

test('callAcceptedPayload falls back to the stored document for missing details', () => {
  const withParam = callAcceptedPayload({ call: acceptedCall(), acceptedAt: ACCEPTED_AT });
  assert.equal(withParam.acceptedAt, '2026-09-30T08:30:00.000Z');

  const withoutParam = callAcceptedPayload({ call: acceptedCall() });
  assert.equal(
    withoutParam.acceptedAt,
    '2026-09-30T08:30:00.000Z',
    'falls back to the document timestamp'
  );

  const bare = callAcceptedPayload({
    call: { _id: 'x', status: 'ACCEPTED', guardianUserId: { toString: () => GUARDIAN_ID } },
  });
  assert.equal(bare.guardian.userId, GUARDIAN_ID);
  assert.equal(bare.guardian.name, null, 'a missing profile never breaks the event');
  assert.equal(bare.acceptedAt, null, 'a missing timestamp never breaks the event');
  assert.equal(bare.sosId, null);
});

test('callAcceptedPayload never carries credentials or connection details', () => {
  const payload = callAcceptedPayload({
    call: acceptedCall({
      apiSecret: env.livekit.apiSecret,
      apiKey: env.livekit.apiKey,
      token: 'stolen-jwt',
      accessToken: 'stolen-jwt',
      password: 'hunter2',
      passwordHash: '$2b$10$hash',
      serverUrl: env.livekit.url,
      roomName: 'emergency-call-64b0f0f0f0f0f0f0f0f0f0e1',
      identities: { [OWNER_ID]: 'user:' + OWNER_ID },
      participants: [{ userId: OWNER_ID, identity: 'user:' + OWNER_ID, role: 'USER' }],
      connectedAt: new Date('2026-09-30T08:31:00.000Z'),
    }),
    guardianName: 'Baba',
    acceptedAt: ACCEPTED_AT,
  });

  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes(env.livekit.apiSecret), 'the configured secret never leaks');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes(env.livekit.url), 'no provider url');
  assert.ok(!raw.includes('roomName'), 'no connection details â€” acceptance grants no room access');
  assert.ok(!raw.includes('identities'));
  assert.ok(!raw.includes('participants'), 'no internal document fields');
  assert.ok(!raw.includes('connectedAt'), 'acceptance is not connectivity');
});

test('emitCallAccepted targets only the SOS owner private room', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallAccepted({
    call: acceptedCall(),
    guardianName: 'Baba',
    acceptedAt: ACCEPTED_AT,
    emit: emit.fn,
  });

  assert.equal(dispatched, true);
  assert.equal(emit.calls.length, 1, 'a single notification, never a broadcast');
  assert.equal(emit.calls[0].userId, OWNER_ID, 'read from call.userId');
  assert.equal(emit.calls[0].event, 'call:accepted');
  assert.equal(emit.calls[0].payload.status, 'ACCEPTED');
  assert.deepEqual(
    [...new Set(emit.calls.map((c) => c.userId))],
    [OWNER_ID],
    'the guardian performed the action, so they are not notified of it'
  );
});

test('call:accepted is withheld for every state that is not ACCEPTED', async () => {
  const forbidden = [
    'CREATED',
    'OUTGOING',
    'RINGING',
    'CONNECTED',
    'REJECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ];

  for (const status of forbidden) {
    const emit = makeEmit();

    const dispatched = await emitCallAccepted({
      call: acceptedCall({ status }),
      guardianName: 'Baba',
      acceptedAt: ACCEPTED_AT,
      emit: emit.fn,
    });

    assert.equal(dispatched, false, status);
    assert.equal(emit.calls.length, 0, status + ' never produces call:accepted');
  }

  const missing = makeEmit();
  assert.equal(await emitCallAccepted({ call: undefined, emit: missing.fn }), false);
  assert.equal(missing.calls.length, 0);
});

test('call:accepted is withheld when the call has no SOS owner to tell', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallAccepted({
    call: acceptedCall({ userId: null }),
    guardianName: 'Baba',
    acceptedAt: ACCEPTED_AT,
    emit: emit.fn,
  });

  assert.equal(dispatched, false, 'there is nobody to notify');
  assert.equal(emit.calls.length, 0, 'no notification into a void room');
});

test('call:accepted never rejects when the socket channel fails', async () => {
  await assert.doesNotReject(() =>
    emitCallAccepted({
      call: acceptedCall(),
      guardianName: 'Baba',
      acceptedAt: ACCEPTED_AT,
      emit: () => {
        throw new Error('socket down');
      },
    })
  );
});

test('the rejected event uses the exact event name', () => {
  assert.equal(CALL_EVENT.REJECTED, 'call:rejected');
});

test('callRejectedPayload gives the SOS owner exactly what it needs to stop the ringing UI', () => {
  const payload = callRejectedPayload({ call: rejectedCall(), guardianName: 'Baba' });

  assert.deepEqual(Object.keys(payload).sort(), [
    'callId',
    'endReason',
    'endedAt',
    'guardian',
    'sosId',
    'status',
    'type',
  ]);
  assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
  assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
  assert.equal(payload.status, 'REJECTED');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.deepEqual(payload.guardian, { userId: GUARDIAN_ID, name: 'Baba' });
  assert.equal(payload.endReason, 'GUARDIAN_REJECTED');
  assert.equal(payload.endedAt, '2026-09-30T08:35:00.000Z');
});

test('callRejectedPayload reports only what the document actually recorded', () => {
  const bare = callRejectedPayload({
    call: { _id: 'x', status: 'REJECTED', guardianUserId: { toString: () => GUARDIAN_ID } },
  });

  assert.equal(bare.guardian.userId, GUARDIAN_ID);
  assert.equal(bare.guardian.name, null, 'a missing profile never breaks the event');
  assert.equal(bare.endReason, null, 'no invented reason');
  assert.equal(bare.endedAt, null, 'no invented timestamp');
  assert.equal(bare.sosId, null);
  assert.equal(Object.keys(bare).includes('sos'), false, 'no SOS state rides along');
});

test('callRejectedPayload never carries credentials or connection details', () => {
  const payload = callRejectedPayload({
    call: rejectedCall({
      apiSecret: env.livekit.apiSecret,
      apiKey: env.livekit.apiKey,
      token: 'stolen-jwt',
      accessToken: 'stolen-jwt',
      password: 'hunter2',
      passwordHash: '$2b$10$hash',
      serverUrl: env.livekit.url,
      roomName: 'emergency-call-64b0f0f0f0f0f0f0f0f0f0e1',
      identities: { [OWNER_ID]: 'user:' + OWNER_ID },
      participants: [{ userId: OWNER_ID, identity: 'user:' + OWNER_ID, role: 'USER' }],
      connectedAt: new Date('2026-09-30T08:31:00.000Z'),
    }),
    guardianName: 'Baba',
  });

  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes(env.livekit.apiSecret), 'the configured secret never leaks');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes(env.livekit.url), 'no provider url');
  assert.ok(!raw.includes('roomName'), 'no connection details â€” a rejected call never joins a room');
  assert.ok(!raw.includes('identities'));
  assert.ok(!raw.includes('participants'), 'no internal document fields');
  assert.ok(!raw.includes('connectedAt'), 'a rejected call never connected');
  assert.ok(!raw.includes('escalation'), 'no SOS internals');
});

test('emitCallRejected targets only the SOS owner private room', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallRejected({
    call: rejectedCall(),
    guardianName: 'Baba',
    emit: emit.fn,
  });

  assert.equal(dispatched, true);
  assert.equal(emit.calls.length, 1, 'a single notification, never a broadcast');
  assert.equal(emit.calls[0].userId, OWNER_ID, 'read from call.userId');
  assert.equal(emit.calls[0].event, 'call:rejected');
  assert.equal(emit.calls[0].payload.status, 'REJECTED');
  assert.deepEqual(
    [...new Set(emit.calls.map((c) => c.userId))],
    [OWNER_ID],
    'the guardian performed the action, so they are not notified of it'
  );
});

test('call:rejected is withheld for every state that is not REJECTED', async () => {
  const forbidden = [
    'CREATED',
    'OUTGOING',
    'RINGING',
    'ACCEPTED',
    'CONNECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ];

  for (const status of forbidden) {
    const emit = makeEmit();

    const dispatched = await emitCallRejected({
      call: rejectedCall({ status }),
      guardianName: 'Baba',
      emit: emit.fn,
    });

    assert.equal(dispatched, false, status);
    assert.equal(emit.calls.length, 0, status + ' never produces call:rejected');
  }

  const missing = makeEmit();
  assert.equal(await emitCallRejected({ call: undefined, emit: missing.fn }), false);
  assert.equal(missing.calls.length, 0);
});

test('call:rejected is withheld when the call has no SOS owner to tell', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallRejected({
    call: rejectedCall({ userId: null }),
    guardianName: 'Baba',
    emit: emit.fn,
  });

  assert.equal(dispatched, false, 'there is nobody to notify');
  assert.equal(emit.calls.length, 0, 'no notification into a void room');
});

test('call:rejected never rejects when the socket channel fails', async () => {
  await assert.doesNotReject(() =>
    emitCallRejected({
      call: rejectedCall(),
      guardianName: 'Baba',
      emit: () => {
        throw new Error('socket down');
      },
    })
  );
});

test('the connected event uses the exact event name', () => {
  assert.equal(CALL_EVENT.CONNECTED, 'call:connected');
});

test('callConnectedPayload gives both sides exactly what the active-call UI needs', () => {
  const payload = callConnectedPayload({ call: connectedCall(), connectedAt: CONNECTED_AT });

  assert.deepEqual(Object.keys(payload).sort(), [
    'callId',
    'connectedAt',
    'sosId',
    'status',
    'type',
  ]);
  assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
  assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
  assert.equal(payload.status, 'CONNECTED');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.equal(payload.connectedAt, '2026-09-30T08:31:00.000Z');
});

test('callConnectedPayload reads the stored document, never invents a timestamp', () => {
  const bare = callConnectedPayload({
    call: { _id: 'x', status: 'CONNECTED' },
  });

  assert.equal(bare.callId, 'x');
  assert.equal(bare.sosId, null);
  assert.equal(bare.status, 'CONNECTED');
  assert.equal(bare.connectedAt, null, 'no invented timestamp');
  assert.equal(Object.keys(bare).includes('sos'), false, 'no SOS state rides along');
});

test('callConnectedPayload never carries credentials or connection details', () => {
  const payload = callConnectedPayload({
    call: connectedCall({
      apiSecret: env.livekit.apiSecret,
      apiKey: env.livekit.apiKey,
      token: 'stolen-jwt',
      accessToken: 'stolen-jwt',
      password: 'hunter2',
      passwordHash: '$2b$10$hash',
      serverUrl: env.livekit.url,
      roomName: 'emergency-call-64b0f0f0f0f0f0f0f0f0f0e1',
      identities: { [OWNER_ID]: 'user:' + OWNER_ID },
      participants: [{ userId: OWNER_ID, identity: 'user:' + OWNER_ID, role: 'USER' }],
      endReason: 'USER_ENDED',
    }),
    connectedAt: CONNECTED_AT,
  });

  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes(env.livekit.apiSecret), 'the configured secret never leaks');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes(env.livekit.url), 'no provider url');
  assert.ok(!raw.includes('roomName'), 'no connection details');
  assert.ok(!raw.includes('identities'));
  assert.ok(!raw.includes('participants'), 'no internal document fields');
  assert.ok(!raw.includes('identity'), 'no participant metadata');
  assert.ok(!raw.includes('endReason'), 'a connected call has no end');
  assert.ok(!raw.includes('escalation'), 'no SOS internals');
});

test('emitCallConnected notifies both participants in their private rooms', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallConnected({
    call: connectedCall(),
    connectedAt: CONNECTED_AT,
    emit: emit.fn,
  });

  assert.equal(dispatched, true);
  assert.equal(emit.calls.length, 2, 'one notification per participant, never a broadcast');
  assert.deepEqual(
    emit.calls.map((c) => c.userId).sort(),
    [OWNER_ID, GUARDIAN_ID].sort(),
    'exactly user:{userId} and user:{guardianUserId}'
  );
  for (const { event, payload } of emit.calls) {
    assert.equal(event, 'call:connected');
    assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
    assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
    assert.equal(payload.status, 'CONNECTED');
    assert.equal(payload.type, 'BROWSER_TO_BROWSER');
    assert.equal(payload.connectedAt, '2026-09-30T08:31:00.000Z');
  }
});

test('emitCallConnected still reaches whichever participant exists', async () => {
  const guardianOnly = makeEmit();
  assert.equal(
    await emitCallConnected({
      call: connectedCall({ userId: null }),
      connectedAt: CONNECTED_AT,
      emit: guardianOnly.fn,
    }),
    true
  );
  assert.deepEqual(guardianOnly.calls.map((c) => c.userId), [GUARDIAN_ID]);

  const ownerOnly = makeEmit();
  assert.equal(
    await emitCallConnected({
      call: connectedCall({ guardianUserId: null }),
      connectedAt: CONNECTED_AT,
      emit: ownerOnly.fn,
    }),
    true
  );
  assert.deepEqual(ownerOnly.calls.map((c) => c.userId), [OWNER_ID]);
});

test('call:connected is withheld for every state that is not CONNECTED', async () => {
  const forbidden = [
    'CREATED',
    'OUTGOING',
    'RINGING',
    'ACCEPTED',
    'REJECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ];

  for (const status of forbidden) {
    const emit = makeEmit();

    const dispatched = await emitCallConnected({
      call: connectedCall({ status }),
      connectedAt: CONNECTED_AT,
      emit: emit.fn,
    });

    assert.equal(dispatched, false, status);
    assert.equal(emit.calls.length, 0, status + ' never produces call:connected');
  }

  const missing = makeEmit();
  assert.equal(await emitCallConnected({ call: undefined, emit: missing.fn }), false);
  assert.equal(missing.calls.length, 0);
});

test('call:connected is withheld when the call has no participants to tell', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallConnected({
    call: connectedCall({ userId: null, guardianUserId: null }),
    connectedAt: CONNECTED_AT,
    emit: emit.fn,
  });

  assert.equal(dispatched, false, 'there is nobody to notify');
  assert.equal(emit.calls.length, 0, 'no notification into a void room');
});

test('call:connected never rejects when the socket channel fails', async () => {
  await assert.doesNotReject(() =>
    emitCallConnected({
      call: connectedCall(),
      connectedAt: CONNECTED_AT,
      emit: () => {
        throw new Error('socket down');
      },
    })
  );
});

test('the failed event uses the exact event name', () => {
  assert.equal(CALL_EVENT.FAILED, 'call:failed');
});

test('callFailedPayload gives both sides exactly what the failure UI needs', () => {
  const payload = callFailedPayload({ call: failedCall(), failedAt: FAILED_AT });

  assert.deepEqual(Object.keys(payload).sort(), [
    'callId',
    'failedAt',
    'reason',
    'sosId',
    'status',
    'type',
  ]);
  assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
  assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
  assert.equal(payload.status, 'FAILED');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.equal(payload.failedAt, '2026-09-30T08:32:00.000Z');
  assert.equal(payload.reason, 'FAILED');
});

test('callFailedPayload only ever exposes the controlled failure vocabulary', () => {
  const stackLeak = callFailedPayload({
    call: failedCall({
      endReason: 'MongoServerError: E11000 duplicate key error collection',
    }),
    failedAt: FAILED_AT,
  });
  assert.equal(stackLeak.reason, null, 'database errors never reach a client');
  assert.ok(!JSON.stringify(stackLeak).includes('E11000'));

  const bare = callFailedPayload({ call: { _id: 'x', status: 'FAILED' } });
  assert.equal(bare.callId, 'x');
  assert.equal(bare.sosId, null);
  assert.equal(bare.status, 'FAILED');
  assert.equal(bare.failedAt, null, 'no invented timestamp');
  assert.equal(bare.reason, null, 'no invented reason');
  assert.equal(Object.keys(bare).includes('sos'), false, 'no SOS state rides along');
});

test('callFailedPayload never carries credentials or internal errors', () => {
  const payload = callFailedPayload({
    call: failedCall({
      apiSecret: env.livekit.apiSecret,
      apiKey: env.livekit.apiKey,
      token: 'stolen-jwt',
      accessToken: 'stolen-jwt',
      password: 'hunter2',
      passwordHash: '$2b$10$hash',
      serverUrl: env.livekit.url,
      roomName: 'emergency-call-64b0f0f0f0f0f0f0f0f0f0e1',
      identities: { [OWNER_ID]: 'user:' + OWNER_ID },
      participants: [{ userId: OWNER_ID, identity: 'user:' + OWNER_ID, role: 'USER' }],
      stack: 'Error: connect ECONNREFUSED 127.0.0.1:27017',
      connectedAt: FAILED_AT,
    }),
    failedAt: FAILED_AT,
  });

  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes(env.livekit.apiSecret), 'the configured secret never leaks');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes(env.livekit.url), 'no provider url');
  assert.ok(!raw.includes('roomName'), 'no connection details');
  assert.ok(!raw.includes('identities'));
  assert.ok(!raw.includes('participants'), 'no internal document fields');
  assert.ok(!raw.includes('stack'), 'no stack traces');
  assert.ok(!raw.includes('ECONNREFUSED'), 'no infrastructure details');
  assert.ok(!raw.includes('escalation'), 'no SOS internals');
});

test('emitCallFailed notifies both participants in their private rooms', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallFailed({
    call: failedCall(),
    failedAt: FAILED_AT,
    emit: emit.fn,
  });

  assert.equal(dispatched, true);
  assert.equal(emit.calls.length, 2, 'one notification per participant, never a broadcast');
  assert.deepEqual(
    emit.calls.map((c) => c.userId).sort(),
    [OWNER_ID, GUARDIAN_ID].sort(),
    'exactly user:{userId} and user:{guardianUserId}'
  );
  for (const { event, payload } of emit.calls) {
    assert.equal(event, 'call:failed');
    assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
    assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
    assert.equal(payload.status, 'FAILED');
    assert.equal(payload.type, 'BROWSER_TO_BROWSER');
    assert.equal(payload.failedAt, '2026-09-30T08:32:00.000Z');
    assert.equal(payload.reason, 'FAILED');
  }
});

test('call:failed is withheld for every state that is not FAILED', async () => {
  const forbidden = [
    'CREATED',
    'OUTGOING',
    'RINGING',
    'ACCEPTED',
    'CONNECTED',
    'REJECTED',
    'ENDED',
    'CANCELLED',
  ];

  for (const status of forbidden) {
    const emit = makeEmit();

    const dispatched = await emitCallFailed({
      call: failedCall({ status }),
      failedAt: FAILED_AT,
      emit: emit.fn,
    });

    assert.equal(dispatched, false, status);
    assert.equal(emit.calls.length, 0, status + ' never produces call:failed');
  }

  const missing = makeEmit();
  assert.equal(await emitCallFailed({ call: undefined, emit: missing.fn }), false);
  assert.equal(missing.calls.length, 0);
});

test('call:failed is withheld when the call has no participants to tell', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallFailed({
    call: failedCall({ userId: null, guardianUserId: null }),
    failedAt: FAILED_AT,
    emit: emit.fn,
  });

  assert.equal(dispatched, false, 'there is nobody to notify');
  assert.equal(emit.calls.length, 0, 'no notification into a void room');
});

test('call:failed never rejects when the socket channel fails', async () => {
  await assert.doesNotReject(() =>
    emitCallFailed({
      call: failedCall(),
      failedAt: FAILED_AT,
      emit: () => {
        throw new Error('socket down');
      },
    })
  );
});

test('the ended event uses the exact event name', () => {
  assert.equal(CALL_EVENT.ENDED, 'call:ended');
});

test('callEndedPayload gives both sides the final outcome', () => {
  const payload = callEndedPayload({
    call: endedCall(),
    endedAt: TERMINATED_AT,
    endedBy: { userId: OWNER_ID, role: 'USER' },
  });

  assert.deepEqual(Object.keys(payload).sort(), [
    'callId',
    'endReason',
    'endedAt',
    'endedBy',
    'sosId',
    'status',
    'type',
  ]);
  assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
  assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
  assert.equal(payload.status, 'ENDED');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.equal(payload.endedAt, '2026-09-30T08:33:00.000Z');
  assert.equal(payload.endReason, 'USER_ENDED');
  assert.deepEqual(payload.endedBy, { userId: OWNER_ID, role: 'USER' });
});

test('callEndedPayload only attributes endings the backend determined', () => {
  const systemEnd = callEndedPayload({ call: endedCall(), endedAt: TERMINATED_AT });
  assert.equal(systemEnd.endedBy, null, 'webhook/system endings name nobody');

  const fabricated = callEndedPayload({
    call: endedCall(),
    endedAt: TERMINATED_AT,
    endedBy: { userId: STRANGER_ID, role: 'ADMIN' },
  });
  assert.equal(fabricated.endedBy, null, 'an unknown role is dropped entirely');

  const noRole = callEndedPayload({
    call: endedCall(),
    endedAt: TERMINATED_AT,
    endedBy: { userId: OWNER_ID },
  });
  assert.equal(noRole.endedBy, null, 'a missing role is dropped');

  const stackLeak = callEndedPayload({
    call: endedCall({ endReason: 'MongoServerError: E11000 duplicate key error collection' }),
    endedAt: TERMINATED_AT,
    endedBy: { userId: OWNER_ID, role: 'USER' },
  });
  assert.equal(stackLeak.endReason, null, 'database errors never reach a client');
  assert.ok(!JSON.stringify(stackLeak).includes('E11000'));

  const bare = callEndedPayload({ call: { _id: 'x', status: 'ENDED' } });
  assert.equal(bare.callId, 'x');
  assert.equal(bare.sosId, null);
  assert.equal(bare.endedAt, null, 'no invented timestamp');
  assert.equal(bare.endReason, null, 'no invented reason');
  assert.equal(bare.endedBy, null);
  assert.equal(Object.keys(bare).includes('sos'), false, 'no SOS state rides along');
});

test('callEndedPayload never carries credentials or internal errors', () => {
  const payload = callEndedPayload({
    call: endedCall({
      apiSecret: env.livekit.apiSecret,
      apiKey: env.livekit.apiKey,
      token: 'stolen-jwt',
      accessToken: 'stolen-jwt',
      password: 'hunter2',
      passwordHash: '$2b$10$hash',
      serverUrl: env.livekit.url,
      roomName: 'emergency-call-64b0f0f0f0f0f0f0f0f0f0e1',
      identities: { [OWNER_ID]: 'user:' + OWNER_ID },
      participants: [{ userId: OWNER_ID, identity: 'user:' + OWNER_ID, role: 'USER' }],
      stack: 'Error: connect ECONNREFUSED 127.0.0.1:27017',
      connectedAt: TERMINATED_AT,
    }),
    endedAt: TERMINATED_AT,
    endedBy: { userId: OWNER_ID, role: 'USER' },
  });

  const raw = JSON.stringify(payload);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes(env.livekit.apiSecret), 'the configured secret never leaks');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes(env.livekit.url), 'no provider url');
  assert.ok(!raw.includes('roomName'), 'no connection details');
  assert.ok(!raw.includes('identities'));
  assert.ok(!raw.includes('participants'), 'no internal document fields');
  assert.ok(!raw.includes('stack'), 'no stack traces');
  assert.ok(!raw.includes('ECONNREFUSED'), 'no infrastructure details');
  assert.ok(!raw.includes('escalation'), 'no SOS internals');
});

test('emitCallEnded notifies both participants in their private rooms', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallEnded({
    call: endedCall(),
    endedAt: TERMINATED_AT,
    endedBy: { userId: OWNER_ID, role: 'USER' },
    emit: emit.fn,
  });

  assert.equal(dispatched, true);
  assert.equal(emit.calls.length, 2, 'one notification per participant, never a broadcast');
  assert.deepEqual(
    emit.calls.map((c) => c.userId).sort(),
    [OWNER_ID, GUARDIAN_ID].sort(),
    'exactly user:{userId} and user:{guardianUserId}'
  );
  for (const { event, payload } of emit.calls) {
    assert.equal(event, 'call:ended');
    assert.equal(payload.callId, '64b0f0f0f0f0f0f0f0f0f0e1');
    assert.equal(payload.sosId, '64b0f0f0f0f0f0f0f0f0f0b1');
    assert.equal(payload.status, 'ENDED');
    assert.equal(payload.type, 'BROWSER_TO_BROWSER');
    assert.equal(payload.endedAt, '2026-09-30T08:33:00.000Z');
    assert.equal(payload.endReason, 'USER_ENDED');
    assert.deepEqual(payload.endedBy, { userId: OWNER_ID, role: 'USER' });
  }
});

test('call:ended is withheld for every state that is not ENDED', async () => {
  const forbidden = [
    'CREATED',
    'OUTGOING',
    'RINGING',
    'ACCEPTED',
    'CONNECTED',
    'REJECTED',
    'FAILED',
    'CANCELLED',
  ];

  for (const status of forbidden) {
    const emit = makeEmit();

    const dispatched = await emitCallEnded({
      call: endedCall({ status }),
      endedAt: TERMINATED_AT,
      emit: emit.fn,
    });

    assert.equal(dispatched, false, status);
    assert.equal(emit.calls.length, 0, status + ' never produces call:ended');
  }

  const missing = makeEmit();
  assert.equal(await emitCallEnded({ call: undefined, emit: missing.fn }), false);
  assert.equal(missing.calls.length, 0);
});

test('call:ended is withheld when the call has no participants to tell', async () => {
  const emit = makeEmit();

  const dispatched = await emitCallEnded({
    call: endedCall({ userId: null, guardianUserId: null }),
    endedAt: TERMINATED_AT,
    emit: emit.fn,
  });

  assert.equal(dispatched, false, 'there is nobody to notify');
  assert.equal(emit.calls.length, 0, 'no notification into a void room');
});

test('call:ended never rejects when the socket channel fails', async () => {
  await assert.doesNotReject(() =>
    emitCallEnded({
      call: endedCall(),
      endedAt: TERMINATED_AT,
      emit: () => {
        throw new Error('socket down');
      },
    })
  );
});

