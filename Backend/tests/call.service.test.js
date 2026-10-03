import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import {
  acceptCall,
  createCallToken,
  endCall,
  issueLiveKitToken,
  rejectCall,
  resolveParticipantRole,
  startEmergencyCall,
} from '../src/modules/calling/call.service.js';
import { CALL_EVENT } from '../src/modules/calling/call.events.js';
import { env } from '../src/config/env.js';

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0a1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0a2';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0a3';

const makeRepository = (call = null) => {
  const calls = [];
  return {
    calls,
    findById: async (callId) => {
      calls.push(callId);
      return call;
    },
  };
};

const makeIssueToken = (token = 'jwt-token') => {
  const calls = [];
  return {
    calls,
    fn: async (args) => {
      calls.push(args);
      return token;
    },
  };
};

const baseCall = (overrides = {}) => ({
  _id: 'call-1',
  sosId: 'sos-1',
  userId: OWNER_ID,
  guardianUserId: GUARDIAN_ID,
  roomName: 'emergency-call-xyz',
  status: 'CREATED',
  identities: {},
  ...overrides,
});

const config = { url: 'wss://test.livekit.cloud', apiKey: 'k', apiSecret: 's', tokenTtlSeconds: 600 };

test('createCallToken issues a token for the protected owner', async () => {
  const repository = makeRepository(baseCall());
  const issuer = makeIssueToken('the-jwt');

  const result = await createCallToken({
    callId: 'call-1',
    userId: OWNER_ID,
    repository,
    issueToken: issuer.fn,
    config,
  });

  assert.deepEqual(result, {
    token: 'the-jwt',
    serverUrl: config.url,
    roomName: 'emergency-call-xyz',
    participantIdentity: 'user:' + OWNER_ID,
  });

  assert.deepEqual(issuer.calls[0], {
    roomName: 'emergency-call-xyz',
    identity: 'user:' + OWNER_ID,
    config,
  });
});

test('createCallToken issues a token for the invited guardian', async () => {
  const repository = makeRepository(baseCall());
  const issuer = makeIssueToken();

  const result = await createCallToken({
    callId: 'call-1',
    userId: GUARDIAN_ID,
    repository,
    issueToken: issuer.fn,
    config,
  });

  assert.equal(result.participantIdentity, 'user:' + GUARDIAN_ID);
  assert.equal(result.roomName, 'emergency-call-xyz');
});

test('createCallToken never lets the client pick the room', async () => {
  const repository = makeRepository(baseCall());
  const issuer = makeIssueToken();

  await createCallToken({
    callId: 'call-1',
    userId: OWNER_ID,
    repository,
    issueToken: issuer.fn,
    config,
    // not accepted by the service contract — room only comes from the record
  });

  assert.equal(issuer.calls[0].roomName, 'emergency-call-xyz');
});

test('createCallToken throws 404 when the call does not exist', async () => {
  const repository = makeRepository(null);
  const issuer = makeIssueToken();

  await assert.rejects(
    () =>
      createCallToken({
        callId: 'missing',
        userId: OWNER_ID,
        repository,
        issueToken: issuer.fn,
        config,
      }),
    (err) => err.statusCode === 404 && err.code === 'CALL_NOT_FOUND'
  );
  assert.equal(issuer.calls.length, 0, 'no token generated');
});

test('createCallToken forbids a user who is not a participant', async () => {
  const repository = makeRepository(baseCall());
  const issuer = makeIssueToken();

  await assert.rejects(
    () =>
      createCallToken({
        callId: 'call-1',
        userId: STRANGER_ID,
        repository,
        issueToken: issuer.fn,
        config,
      }),
    (err) => err.statusCode === 403 && err.code === 'CALL_NOT_AUTHORIZED'
  );
  assert.equal(issuer.calls.length, 0, 'no token generated');
});

test('createCallToken refuses non-joinable call states', async () => {
  for (const status of ['ENDED', 'FAILED', 'CANCELLED']) {
    const repository = makeRepository(baseCall({ status }));
    const issuer = makeIssueToken();

    await assert.rejects(
      () =>
        createCallToken({
          callId: 'call-1',
          userId: OWNER_ID,
          repository,
          issueToken: issuer.fn,
          config,
        }),
      (err) => err.statusCode === 409 && err.code === 'CALL_NOT_JOINABLE'
    );
    assert.equal(issuer.calls.length, 0, status);
  }
});

test('createCallToken accepts every joinable call state', async () => {
  for (const status of ['CREATED', 'OUTGOING', 'RINGING', 'CONNECTED']) {
    const repository = makeRepository(baseCall({ status }));
    const issuer = makeIssueToken();

    const result = await createCallToken({
      callId: 'call-1',
      userId: OWNER_ID,
      repository,
      issueToken: issuer.fn,
      config,
    });

    assert.equal(result.token, 'jwt-token', status);
  }
});

test('resolveParticipantRole derives the role from the call document only', async () => {
  const call = baseCall();

  assert.equal(resolveParticipantRole(call, OWNER_ID), 'USER');
  assert.equal(resolveParticipantRole(call, GUARDIAN_ID), 'GUARDIAN');
  assert.equal(resolveParticipantRole(call, STRANGER_ID), null);

  // A call with no invited guardian never authorizes a guardian.
  assert.equal(resolveParticipantRole(baseCall({ guardianUserId: null }), GUARDIAN_ID), null);

  // Identities are compared as strings, so ObjectId and string forms match.
  assert.equal(resolveParticipantRole(baseCall({ userId: OWNER_ID }), String(OWNER_ID)), 'USER');
});

test('createCallToken refuses a call record without a valid room name', async () => {
  for (const roomName of [undefined, null, '', '   ']) {
    const repository = makeRepository(baseCall({ roomName }));
    const issuer = makeIssueToken();

    await assert.rejects(
      () =>
        createCallToken({
          callId: 'call-1',
          userId: OWNER_ID,
          repository,
          issueToken: issuer.fn,
          config,
        }),
      (err) => err.statusCode === 500 && err.code === 'CALL_ROOM_MISSING',
      String(roomName)
    );

    assert.equal(issuer.calls.length, 0, 'no token is issued for invalid call data');
  }
});

test('createCallToken ignores client-supplied identity, role, permissions and room', async () => {
  const repository = makeRepository(baseCall());
  const issuer = makeIssueToken();

  const result = await createCallToken({
    callId: 'call-1',
    userId: OWNER_ID,
    repository,
    issueToken: issuer.fn,
    config,
    // none of these belong to the service contract — they must have no effect
    roomName: 'attacker-room',
    participantIdentity: 'user:' + GUARDIAN_ID,
    role: 'ADMIN',
    permissions: { canAdmin: true },
    guardianUserId: GUARDIAN_ID,
    apiSecret: 'stolen-secret',
  });

  assert.equal(result.roomName, 'emergency-call-xyz');
  assert.equal(result.participantIdentity, 'user:' + OWNER_ID);
  assert.equal(issuer.calls[0].roomName, 'emergency-call-xyz');
  assert.equal(issuer.calls[0].identity, 'user:' + OWNER_ID);
  assert.deepEqual(issuer.calls[0].config, config, 'credentials only come from configuration');
});

test('createCallToken maps missing LiveKit configuration to a non-leaky server error', async () => {
  const repository = makeRepository(baseCall());

  await assert.rejects(
    () =>
      createCallToken({
        callId: 'call-1',
        userId: OWNER_ID,
        repository,
        config: { url: '', apiKey: '', apiSecret: '', tokenTtlSeconds: 600 },
      }),
    (err) =>
      err.statusCode === 502 &&
      err.code === 'LIVEKIT_NOT_CONFIGURED' &&
      !String(err.message).includes('secret')
  );
});

test('createCallToken maps provider failures to 502', async () => {
  const repository = makeRepository(baseCall());

  await assert.rejects(
    () =>
      createCallToken({
        callId: 'call-1',
        userId: OWNER_ID,
        repository,
        issueToken: async () => {
          throw new Error('livekit down');
        },
        config,
      }),
    (err) => err.statusCode === 502 && err.code === 'LIVEKIT_TOKEN_FAILED'
  );
});

test('createCallToken propagates database failures to the error middleware', async () => {
  const repository = {
    findById: async () => {
      throw new Error('db down');
    },
  };

  await assert.rejects(
    () =>
      createCallToken({
        callId: 'call-1',
        userId: OWNER_ID,
        repository,
        issueToken: makeIssueToken().fn,
        config,
      }),
    (err) => err.message === 'db down'
  );
});

test('issueLiveKitToken refuses to run without configured credentials', async () => {
  await assert.rejects(
    () =>
      issueLiveKitToken({
        roomName: 'room',
        identity: 'user:x',
        config: { url: '', apiKey: '', apiSecret: '', tokenTtlSeconds: 600 },
      }),
    (err) => err.statusCode === 502 && err.code === 'LIVEKIT_NOT_CONFIGURED'
  );
});

test('issueLiveKitToken never embeds the api secret in the token', async () => {
  const token = await issueLiveKitToken({
    roomName: 'emergency-call-1',
    identity: 'user:u1',
    config: env.livekit,
  });

  assert.ok(!token.includes(env.livekit.apiSecret), 'apiSecret is not in the JWT');

  const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  assert.equal(claims.video.room, 'emergency-call-1');
  assert.equal(claims.video.roomJoin, true);
  assert.equal(claims.video.canPublish, true);
  assert.equal(claims.video.canSubscribe, true);
  assert.ok(!claims.video.canAdmin);
  assert.ok(claims.exp - claims.nbf <= env.livekit.tokenTtlSeconds);
});

// ---------------------------------------------------------------------------
// POST /api/v1/calls/start — startEmergencyCall
// ---------------------------------------------------------------------------

const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0b1';
const GUARDIAN2_ID = '64b0f0f0f0f0f0f0f0f0f0a4';

const activeSos = (overrides = {}) => ({
  _id: SOS_ID,
  userId: OWNER_ID,
  status: 'ACTIVE',
  ...overrides,
});

const firstGuardian = {
  _id: '64b0f0f0f0f0f0f0f0f0f0c1',
  userId: OWNER_ID,
  guardianUserId: GUARDIAN_ID,
  relationship: 'Father',
  priority: 1,
  status: 'ACTIVE',
};

const secondGuardian = {
  _id: '64b0f0f0f0f0f0f0f0f0f0c2',
  userId: OWNER_ID,
  guardianUserId: GUARDIAN2_ID,
  relationship: 'Mother',
  priority: 2,
  status: 'ACTIVE',
};

const DEFAULT_USERS = {
  [OWNER_ID]: { _id: OWNER_ID, name: 'Asha' },
  [GUARDIAN_ID]: { _id: GUARDIAN_ID, name: 'Baba' },
  [GUARDIAN2_ID]: { _id: GUARDIAN2_ID, name: 'Didi' },
};

const makeStartRepository = (overrides = {}) => {
  const {
    sos = activeSos(),
    guardians = [firstGuardian],
    users = DEFAULT_USERS,
    activeCall = null,
    createCallImpl = null,
    ringCallAtomicallyImpl = null,
  } = overrides;

  const created = [];
  const guardianQueries = [];
  const ringAttempts = [];
  let lastCreated = null;

  return {
    created,
    guardianQueries,
    ringAttempts,
    findSOSById: async () => sos,
    findActiveGuardians: async (userId) => {
      guardianQueries.push(String(userId));
      return guardians;
    },
    findUserById: async (id) => users[String(id)],
    findActiveCallBySOS: async () => activeCall,
    createCall: async (data) => {
      if (createCallImpl) return createCallImpl(data);
      created.push(data);
      lastCreated = { ...data, createdAt: new Date('2026-01-01T00:00:00.000Z') };
      return lastCreated;
    },
    // Mirrors the conditional write: it succeeds only for the call this fake
    // has stored as OUTGOING, and only for the first attempt.
    ringCallAtomically: async (callId, ringingAt) => {
      ringAttempts.push(String(callId));
      if (ringCallAtomicallyImpl) return ringCallAtomicallyImpl(callId, ringingAt);
      if (!lastCreated || String(lastCreated._id) !== String(callId)) return null;
      lastCreated = { ...lastCreated, status: 'RINGING', ringingAt, updatedAt: ringingAt };
      return lastCreated;
    },
  };
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

const start = (repository, emit) =>
  startEmergencyCall({ sosId: SOS_ID, userId: OWNER_ID, repository, emit });

test('startEmergencyCall creates an OUTGOING call and rings it on a backend-generated room', async () => {
  const repository = makeStartRepository();
  const emit = makeEmit();

  const result = await start(repository, emit.fn);

  assert.equal(result.created, true);

  const call = result.call;
  assert.equal(String(call.sosId), SOS_ID);
  assert.equal(String(call.userId), OWNER_ID);
  assert.equal(String(call.guardianUserId), GUARDIAN_ID);
  assert.equal(call.type, 'BROWSER_TO_BROWSER');
  assert.equal(repository.created[0].status, 'OUTGOING', 'the document starts OUTGOING');
  assert.equal(call.status, 'RINGING', 'then moves so the guardian can accept or reject it');
  assert.ok(call.ringingAt instanceof Date, 'ringingAt is recorded with the flip');
  assert.equal(repository.created.length, 1, 'exactly one document is persisted');

  // Room is derived from the pre-generated call id and carries no PII.
  assert.equal(call.roomName, 'emergency-call-' + String(call._id));
  assert.match(call.roomName, /^emergency-call-[0-9a-f]{24}$/);
  assert.ok(!/@/.test(call.roomName), 'no email in the room name');
  assert.ok(!/[+:\s]/.test(call.roomName), 'no phone number formatting in the room name');
  assert.ok(call.roomName.length < 64, 'room name stays short');
});

test('startEmergencyCall stores backend-generated participant identities and roles', async () => {
  const repository = makeStartRepository();
  const emit = makeEmit();

  const { call } = await start(repository, emit.fn);

  assert.deepEqual(call.participants, [
    { userId: OWNER_ID, identity: 'user:' + OWNER_ID, role: 'USER' },
    { userId: GUARDIAN_ID, identity: 'user:' + GUARDIAN_ID, role: 'GUARDIAN' },
  ]);

  const identities = call.participants.map((p) => p.identity);
  assert.equal(new Set(identities).size, identities.length, 'identities are unique in the room');
});

test('startEmergencyCall asks the SOS owner for guardians and takes the highest priority one', async () => {
  const repository = makeStartRepository({
    guardians: [firstGuardian, secondGuardian],
  });
  const emit = makeEmit();

  const { call } = await start(repository, emit.fn);

  assert.deepEqual(repository.guardianQueries, [OWNER_ID], 'guardians are the owner ones');
  assert.equal(String(call.guardianUserId), GUARDIAN_ID, 'priority 1 wins over priority 2');
});

test('startEmergencyCall skips a guardian whose account no longer exists', async () => {
  const repository = makeStartRepository({
    guardians: [firstGuardian, secondGuardian],
    users: {
      ...DEFAULT_USERS,
      [GUARDIAN_ID]: undefined,
    },
  });
  const emit = makeEmit();

  const { call } = await start(repository, emit.fn);

  assert.equal(String(call.guardianUserId), GUARDIAN2_ID, 'falls through to the next guardian');
});

test('startEmergencyCall refuses when no eligible guardian exists', async () => {
  for (const overrides of [
    { guardians: [] },
    { guardians: [firstGuardian], users: { [OWNER_ID]: DEFAULT_USERS[OWNER_ID] } },
  ]) {
    const repository = makeStartRepository(overrides);
    const emit = makeEmit();

    await assert.rejects(
      () => start(repository, emit.fn),
      (err) => err.statusCode === 409 && err.code === 'CALL_NO_ELIGIBLE_GUARDIAN'
    );

    assert.equal(repository.created.length, 0, 'no call document is created');
    assert.equal(emit.calls.length, 0, 'nobody is notified');
  }
});

test('startEmergencyCall returns 404 for a SOS that does not exist', async () => {
  const repository = makeStartRepository({ sos: null });
  const emit = makeEmit();

  await assert.rejects(
    () => start(repository, emit.fn),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );

  assert.equal(repository.created.length, 0);
  assert.equal(emit.calls.length, 0);
});

test('startEmergencyCall refuses a SOS the caller does not own', async () => {
  const repository = makeStartRepository({ sos: activeSos({ userId: STRANGER_ID }) });
  const emit = makeEmit();

  await assert.rejects(
    () => start(repository, emit.fn),
    (err) => err.statusCode === 403 && err.code === 'SOS_NOT_AUTHORIZED'
  );

  assert.equal(repository.created.length, 0);
  assert.equal(emit.calls.length, 0);
});

test('startEmergencyCall allows the states where guardian communication is allowed', async () => {
  for (const status of ['ACTIVE', 'ESCALATING', 'ACKNOWLEDGED']) {
    const repository = makeStartRepository({ sos: activeSos({ status }) });
    const emit = makeEmit();

    const result = await start(repository, emit.fn);

    assert.equal(result.created, true, status);
    assert.equal(result.call.status, 'RINGING', status);
  }
});

test('startEmergencyCall rejects SOS states that are not an active emergency', async () => {
  for (const status of ['VERIFYING', 'CANCELLED', 'RESOLVED']) {
    const repository = makeStartRepository({ sos: activeSos({ status }) });
    const emit = makeEmit();

    await assert.rejects(
      () => start(repository, emit.fn),
      (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACTIVE',
      status
    );

    assert.equal(repository.created.length, 0, status);
    assert.equal(emit.calls.length, 0, status);
  }
});

test('startEmergencyCall refuses to stack a second call on the same SOS', async () => {
  const existing = { _id: '64b0f0f0f0f0f0f0f0f0f0d1', status: 'RINGING' };
  const repository = makeStartRepository({ activeCall: existing });
  const emit = makeEmit();

  const result = await start(repository, emit.fn);

  assert.equal(result.created, false);
  assert.equal(result.existing, existing);
  assert.equal(repository.created.length, 0, 'no second call document');
  assert.equal(emit.calls.length, 0, 'nobody is rung twice');
});

test('startEmergencyCall returns the winning call when a concurrent insert loses the race', async () => {
  const winner = { _id: '64b0f0f0f0f0f0f0f0f0f0d2', status: 'OUTGOING' };
  const repository = makeStartRepository({
    activeCall: winner,
    createCallImpl: async () => {
      const err = new Error('E11000 duplicate key error');
      err.code = 11000;
      throw err;
    },
  });
  const emit = makeEmit();

  const result = await start(repository, emit.fn);

  assert.equal(result.created, false);
  assert.equal(result.existing, winner);
  assert.equal(emit.calls.length, 0);
});

test('startEmergencyCall emits call:outgoing and call:ringing to the right participants', async () => {
  const repository = makeStartRepository();
  const emit = makeEmit();

  const { call } = await start(repository, emit.fn);

  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:outgoing', 'call:ringing'],
    'only start-time events are emitted'
  );

  const [outgoing, ringing] = emit.calls;

  assert.equal(outgoing.userId, OWNER_ID);
  assert.equal(outgoing.payload.callId, String(call._id));
  assert.equal(outgoing.payload.sosId, SOS_ID);
  assert.equal(outgoing.payload.status, 'OUTGOING');
  assert.equal(outgoing.payload.type, 'BROWSER_TO_BROWSER');
  assert.equal(outgoing.payload.guardianUserId, GUARDIAN_ID);
  assert.equal(
    outgoing.payload.createdAt,
    new Date('2026-01-01T00:00:00.000Z').toISOString(),
    'the timestamp rides along so the client can show "calling since …"'
  );
  assert.deepEqual(
    Object.keys(outgoing.payload).sort(),
    ['callId', 'createdAt', 'guardianUserId', 'sosId', 'status', 'type'],
    'exactly the documented payload, no internal fields'
  );
  assert.equal(Object.keys(outgoing.payload).includes('roomName'), false);
  assert.equal(Object.keys(outgoing.payload).includes('identities'), false);


  assert.equal(ringing.userId, GUARDIAN_ID, 'the selected guardian is the recipient');
  assert.equal(ringing.payload.status, 'RINGING', 'the event describes the state after the flip');

  const { ringingAt, ...ringingRest } = ringing.payload;
  assert.deepEqual(ringingRest, {
    callId: String(call._id),
    sosId: SOS_ID,
    status: 'RINGING',
    type: 'BROWSER_TO_BROWSER',
    caller: { userId: OWNER_ID, name: 'Asha' },
    createdAt: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  });
  assert.ok(
    Math.abs(Date.now() - new Date(ringingAt).getTime()) < 60000,
    'ringingAt is a real timestamp of this transition'
  );
  assert.equal(
    new Date(call.ringingAt).toISOString(),
    ringingAt,
    'the payload reports the stored timestamp, not a re-derived one'
  );
  assert.deepEqual(
    Object.keys(ringing.payload).sort(),
    ['callId', 'caller', 'createdAt', 'ringingAt', 'sosId', 'status', 'type'],
    'exactly the documented payload, no internal fields'
  );
  assert.equal(Object.keys(ringing.payload).includes('roomName'), false);
  assert.equal(Object.keys(ringing.payload).includes('identities'), false);

  const raw = JSON.stringify(emit.calls);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes('LIVEKIT'), 'no LiveKit credentials');
  assert.ok(!raw.includes('token'), 'no access token');
  assert.ok(!raw.includes(env.livekit.url), 'no provider url');
  assert.ok(!raw.includes('passwordHash'), 'no password material');
});

test('startEmergencyCall still succeeds when the notification channel fails', async () => {
  const repository = makeStartRepository();

  const result = await start(repository, () => {
    throw new Error('socket down');
  });

  assert.equal(result.created, true);
  assert.equal(result.call.status, 'RINGING');
});

test('startEmergencyCall persists first, then rings, then notifies the guardian', async () => {
  const order = [];
  const repository = makeStartRepository();
  const originalCreate = repository.createCall;
  const originalRing = repository.ringCallAtomically;

  repository.createCall = async (data) => {
    order.push('createCall');
    return originalCreate(data);
  };

  repository.ringCallAtomically = async (...args) => {
    order.push('ringCallAtomically');
    return originalRing(...args);
  };

  const emit = {
    calls: [],
    fn: (userId, event, payload) => {
      order.push(event);
      emit.calls.push({ userId: String(userId), event, payload });
      return true;
    },
  };

  const { call } = await start(repository, emit.fn);

  assert.deepEqual(
    order,
    ['createCall', 'call:outgoing', 'ringCallAtomically', 'call:ringing'],
    'the database is authoritative: state before every event, never after'
  );
  assert.equal(emit.calls[0].payload.callId, String(call._id), 'the notification names a real call');
  assert.equal(
    emit.calls[1].payload.ringingAt,
    new Date(call.ringingAt).toISOString(),
    'the guardian hears about the transition that was actually written'
  );
});

test('startEmergencyCall emits nothing at all when the call cannot be created', async () => {
  const repository = makeStartRepository({
    createCallImpl: () => {
      throw new Error('db down');
    },
  });
  const emit = makeEmit();

  await assert.rejects(
    () => start(repository, emit.fn),
    (err) => err.message === 'db down'
  );

  assert.equal(repository.created.length, 0);
  assert.equal(emit.calls.length, 0, 'no call:outgoing without a document to point at');
});

test('startEmergencyCall delivers call:outgoing only to the authenticated SOS owner', async () => {
  const repository = makeStartRepository();
  const emit = makeEmit();

  await start(repository, emit.fn);

  const outgoing = emit.calls.filter((e) => e.event === 'call:outgoing');
  assert.deepEqual(
    outgoing.map((e) => e.userId),
    [OWNER_ID],
    'one recipient, derived from the persisted call, never broadcast'
  );

  assert.equal(
    emit.calls.some((e) => e.userId === GUARDIAN_ID && e.event === 'call:outgoing'),
    false,
    'the guardian is rung separately, never sent owner events'
  );
  assert.equal(
    emit.calls.some((e) => e.userId === STRANGER_ID),
    false,
    'no other participant receives anything at start time'
  );
});

test('startEmergencyCall rings once and only the assigned guardian hears it', async () => {
  const repository = makeStartRepository({ guardians: [firstGuardian, secondGuardian] });
  const emit = makeEmit();

  await start(repository, emit.fn);

  assert.equal(repository.ringAttempts.length, 1, 'one conditional write per start');
  assert.equal(repository.ringAttempts[0], String(repository.created[0]._id));

  const ringing = emit.calls.filter((e) => e.event === 'call:ringing');
  assert.equal(ringing.length, 1, 'exactly one call:ringing event');
  assert.equal(ringing[0].userId, GUARDIAN_ID, 'recipient comes from the stored guardian');

  assert.equal(
    emit.calls.some((e) => e.userId === GUARDIAN2_ID),
    false,
    'the next-priority guardian is never notified'
  );
  assert.equal(
    emit.calls.some((e) => e.userId === OWNER_ID && e.event === 'call:ringing'),
    false,
    'the owner never receives the guardian event'
  );
});

test('startEmergencyCall withholds call:ringing when the transition is lost', async () => {
  const repository = makeStartRepository({ ringCallAtomicallyImpl: async () => null });
  const emit = makeEmit();

  const { call } = await start(repository, emit.fn);

  assert.equal(call.status, 'OUTGOING', 'the record never claims to be ringing');
  assert.equal(call.ringingAt, undefined, 'no ringing timestamp was written');
  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:outgoing'],
    'no call:ringing without the state to back it'
  );
});

test('startEmergencyCall withholds call:ringing when the transition fails outright', async () => {
  const repository = makeStartRepository({
    ringCallAtomicallyImpl: () => {
      throw new Error('db down');
    },
  });
  const emit = makeEmit();

  const { created, call } = await start(repository, emit.fn);

  assert.equal(created, true, 'the call itself was created and stays the source of truth');
  assert.equal(call.status, 'OUTGOING');
  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:outgoing'],
    'the guardian is never rung for a state that was not written'
  );
});

test('startEmergencyCall never emits call:ringing for a document that is not RINGING', async () => {
  const repository = makeStartRepository({
    ringCallAtomicallyImpl: async (callId) => ({
      _id: callId,
      sosId: SOS_ID,
      userId: OWNER_ID,
      guardianUserId: GUARDIAN_ID,
      type: 'BROWSER_TO_BROWSER',
      status: 'OUTGOING',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      ringingAt: new Date(),
    }),
  });
  const emit = makeEmit();

  const { call } = await start(repository, emit.fn);

  assert.equal(call.status, 'OUTGOING');
  assert.deepEqual(
    emit.calls.map((e) => e.event),
    ['call:outgoing'],
    'the emission guard refuses to describe a state the document does not have'
  );
});


test('startEmergencyCall never generates a LiveKit token', async () => {
  const repository = makeStartRepository();
  const emit = makeEmit();

  const { call } = await start(repository, emit.fn);

  const raw = JSON.stringify({ call, emitted: emit.calls });
  assert.ok(!raw.includes('jwt'), 'no token material on the record');
  assert.ok(!raw.includes(env.livekit.apiKey), 'no api key on the record');
  assert.equal(Object.keys(repository.created[0]).includes('token'), false);
});

test('startEmergencyCall propagates database failures to the error middleware', async () => {
  const repository = makeStartRepository();

  repository.findSOSById = async () => {
    throw new Error('db down');
  };

  await assert.rejects(() => start(repository, makeEmit().fn), (err) => err.message === 'db down');
});

// ---------------------------------------------------------------------------
// POST /api/v1/calls/end — endCall
// ---------------------------------------------------------------------------

const CALL_ID = '64b0f0f0f0f0f0f0f0f0f0e1';

const callRecord = (overrides = {}) => ({
  _id: CALL_ID,
  sosId: SOS_ID,
  userId: OWNER_ID,
  guardianUserId: GUARDIAN_ID,
  type: 'BROWSER_TO_BROWSER',
  status: 'CONNECTED',
  roomName: 'emergency-call-' + CALL_ID,
  participants: [
    { userId: OWNER_ID, identity: 'user:' + OWNER_ID, role: 'USER' },
    { userId: GUARDIAN_ID, identity: 'user:' + GUARDIAN_ID, role: 'GUARDIAN' },
  ],
  startedAt: new Date('2026-01-01T00:00:00.000Z'),
  ringingAt: null,
  connectedAt: null,
  endedAt: null,
  endReason: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const FORBIDDEN_REPOSITORY_METHODS = [
  'createCall',
  'findActiveCallBySOS',
  'findActiveGuardians',
  'findSOSById',
];

const makeEndRepository = ({ notFound = false, call = callRecord() } = {}) => {
  const state = { call };
  const updates = [];

  const repository = {
    state,
    updates,
    invoked: [],
    findById: async () => (notFound ? null : state.call),
    endCallAtomically: async (callId, allowedStatuses, update) => {
      if (!allowedStatuses.includes(state.call.status)) return null;
      state.call = { ...state.call, ...update };
      updates.push(update);
      return state.call;
    },
  };

  // Widening the scope of this endpoint must blow up, not silently succeed.
  for (const name of FORBIDDEN_REPOSITORY_METHODS) {
    repository[name] = async () => {
      repository.invoked.push(name);
      throw new Error(`endCall must not call ${name}`);
    };
  }

  return repository;
};

const end = (repository, emit, args = {}) =>
  endCall({
    callId: args.callId ?? CALL_ID,
    userId: args.userId ?? OWNER_ID,
    endReason: args.endReason ?? null,
    repository,
    emit,
  });

test('endCall flips an in-flight call to ENDED with a server timestamp', async () => {
  const repository = makeEndRepository();
  const emit = makeEmit();

  const result = await end(repository, emit.fn, { endReason: 'USER_ENDED' });

  assert.equal(result.ended, true);

  const call = result.call;
  assert.equal(call.status, 'ENDED');
  assert.equal(call.endReason, 'USER_ENDED');
  assert.ok(call.endedAt instanceof Date, 'endedAt is generated by the server');
  assert.ok(call.endedAt.getTime() > new Date('2026-01-01T00:00:00.000Z').getTime());
  assert.equal(call.updatedAt, call.endedAt, 'updatedAt is refreshed with the transition');
  assert.equal(String(call.sosId), SOS_ID, 'sosId is not rewritten');
  assert.equal(String(call.userId), OWNER_ID, 'the participants are not rewritten');
  assert.deepEqual(
    call.participants.map((p) => p.identity),
    ['user:' + OWNER_ID, 'user:' + GUARDIAN_ID],
    'participants stay exactly as they were created'
  );

  assert.deepEqual(
    Object.keys(repository.updates[0]).sort(),
    ['endReason', 'endedAt', 'status', 'updatedAt'],
    'the update only carries backend-generated fields'
  );
  assert.equal(repository.updates[0].status, 'ENDED');
});

test('endCall lets the assigned guardian end the call', async () => {
  const repository = makeEndRepository();
  const emit = makeEmit();

  const result = await end(repository, emit.fn, { userId: GUARDIAN_ID, endReason: 'GUARDIAN_ENDED' });

  assert.equal(result.ended, true);
  assert.equal(result.call.status, 'ENDED');
  assert.equal(result.call.endReason, 'GUARDIAN_ENDED');
  assert.deepEqual(
    emit.calls[0].payload.endedBy,
    { userId: GUARDIAN_ID, role: 'GUARDIAN' },
    'the guardian is the one who ended it, with their stored role'
  );
});

test('endCall refuses a user who is not a participant', async () => {
  for (const stranger of [STRANGER_ID, new mongoose.Types.ObjectId().toString()]) {
    const repository = makeEndRepository();
    const emit = makeEmit();

    await assert.rejects(
      () => end(repository, emit.fn, { userId: stranger }),
      (err) => err.statusCode === 403 && err.code === 'CALL_NOT_AUTHORIZED'
    );

    assert.equal(repository.updates.length, 0, 'nothing is written');
    assert.equal(emit.calls.length, 0, 'nobody is notified');
    assert.equal(repository.state.call.status, 'CONNECTED', 'the call is untouched');
  }
});

test('endCall returns 404 when the call does not exist', async () => {
  const repository = makeEndRepository({ notFound: true });
  const emit = makeEmit();

  await assert.rejects(
    () => end(repository, emit.fn),
    (err) => err.statusCode === 404 && err.code === 'CALL_NOT_FOUND'
  );

  assert.equal(repository.updates.length, 0);
  assert.equal(emit.calls.length, 0);
});

test('endCall ends every in-flight state', async () => {
  for (const status of ['CREATED', 'OUTGOING', 'RINGING', 'ACCEPTED', 'CONNECTED']) {
    const repository = makeEndRepository({ call: callRecord({ status }) });
    const emit = makeEmit();

    const result = await end(repository, emit.fn, { endReason: 'TIMEOUT' });

    assert.equal(result.ended, true, status);
    assert.equal(result.call.status, 'ENDED', status);
    assert.equal(emit.calls.length, 2, status + ' notifies both participants');
  }
});

test('endCall treats a replay on an ENDED call as idempotent', async () => {
  const originalEnd = new Date('2026-02-01T10:00:00.000Z');
  const repository = makeEndRepository({
    call: callRecord({ status: 'ENDED', endedAt: originalEnd, endReason: 'TIMEOUT' }),
  });
  const emit = makeEmit();

  const result = await end(repository, emit.fn, { endReason: 'USER_ENDED' });

  assert.equal(result.ended, false, 'no second transition');
  assert.equal(result.call.status, 'ENDED');
  assert.equal(result.call.endReason, 'TIMEOUT', 'the original outcome is preserved');
  assert.equal(result.call.endedAt.getTime(), originalEnd.getTime(), 'endedAt is preserved');
  assert.equal(repository.updates.length, 0, 'no additional state change');
  assert.equal(emit.calls.length, 0, 'nobody is notified twice');
});

test('endCall refuses other terminal states with 409', async () => {
  for (const status of ['FAILED', 'CANCELLED', 'REJECTED']) {
    const repository = makeEndRepository({ call: callRecord({ status }) });
    const emit = makeEmit();

    await assert.rejects(
      () => end(repository, emit.fn, { endReason: 'USER_ENDED' }),
      (err) => err.statusCode === 409 && err.code === 'CALL_ALREADY_TERMINAL',
      status
    );

    assert.equal(repository.updates.length, 0, status);
    assert.equal(repository.state.call.status, status, status + ' is preserved');
    assert.equal(emit.calls.length, 0, status);
  }
});

test('endCall reports the winner when a concurrent end already flipped the state', async () => {
  let reads = 0;
  const repository = {
    updates: [],
    invoked: [],
    findById: async () => {
      reads += 1;
      return reads === 1
        ? callRecord({ status: 'RINGING' })
        : callRecord({ status: 'ENDED', endedAt: new Date('2026-03-01T00:00:00.000Z') });
    },
    endCallAtomically: async () => null,
  };
  const emit = makeEmit();

  const result = await end(repository, emit.fn, { endReason: 'USER_ENDED' });

  assert.equal(result.ended, false, 'the losing request is idempotent');
  assert.equal(result.call.status, 'ENDED');
  assert.equal(emit.calls.length, 0, 'only the winner notifies the participants');
});

test('endCall maps a race that lands in another terminal state to 409', async () => {
  let reads = 0;
  const repository = {
    updates: [],
    findById: async () => {
      reads += 1;
      return reads === 1 ? callRecord({ status: 'CONNECTED' }) : callRecord({ status: 'FAILED' });
    },
    endCallAtomically: async () => null,
  };
  const emit = makeEmit();

  await assert.rejects(
    () => end(repository, emit.fn),
    (err) => err.statusCode === 409 && err.code === 'CALL_ALREADY_TERMINAL'
  );

  assert.equal(emit.calls.length, 0);
});

test('endCall emits call:ended to both participants only after the database update', async () => {
  const order = [];
  const repository = makeEndRepository();
  const originalEndCallAtomically = repository.endCallAtomically;

  repository.endCallAtomically = async (...args) => {
    order.push('db');
    return originalEndCallAtomically(...args);
  };

  const emit = {
    calls: [],
    fn: (userId, event, payload) => {
      order.push(event);
      emit.calls.push({ userId: String(userId), event, payload });
      return true;
    },
  };

  const result = await end(repository, emit.fn, { endReason: 'USER_ENDED' });

  assert.equal(result.ended, true);
  assert.deepEqual(order, ['db', 'call:ended', 'call:ended'], 'DB first, sockets second');
  assert.deepEqual(
    emit.calls.map((e) => e.userId).sort(),
    [GUARDIAN_ID, OWNER_ID].sort(),
    'exactly the two participants'
  );
  assert.equal(new Set(emit.calls.map((e) => e.userId)).size, 2, 'no duplicate recipients');

  for (const { event, payload } of emit.calls) {
    assert.equal(event, 'call:ended');
    assert.deepEqual(
      Object.keys(payload).sort(),
      ['callId', 'endReason', 'endedAt', 'endedBy', 'sosId', 'status', 'type'],
      'exactly the recommended payload, nothing else'
    );
    assert.equal(payload.callId, CALL_ID);
    assert.equal(payload.sosId, SOS_ID);
    assert.equal(payload.status, 'ENDED');
    assert.equal(payload.type, 'BROWSER_TO_BROWSER');
    assert.deepEqual(payload.endedBy, { userId: OWNER_ID, role: 'USER' });
    assert.equal(payload.endReason, 'USER_ENDED');
    assert.equal(payload.endedAt, result.call.endedAt.toISOString(), 'server time is sent');
  }

  const raw = JSON.stringify(emit.calls);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes('roomName'), 'the payload carries no connection details');
  assert.ok(!raw.includes('token'), 'no access token');
  assert.ok(!raw.includes('stack'), 'no internal error details');
});

test('endCall still succeeds when the notification channel fails', async () => {
  const repository = makeEndRepository();

  const result = await end(repository, () => {
    throw new Error('socket down');
  }, { endReason: 'USER_ENDED' });

  assert.equal(result.ended, true);
  assert.equal(result.call.status, 'ENDED');
});

test('endCall stores no reason when the client sends none', async () => {
  const repository = makeEndRepository();
  const emit = makeEmit();

  const result = await end(repository, emit.fn);

  assert.equal(result.ended, true);
  assert.equal(result.call.endReason, null, 'no reason is invented');
  assert.deepEqual(
    Object.keys(repository.updates[0]).sort(),
    ['endedAt', 'status', 'updatedAt'],
    'endReason is only written when provided'
  );
  assert.equal(emit.calls[0].payload.endReason, null);
});

test('endCall ignores an outcome supplied by the caller', async () => {
  const repository = makeEndRepository();
  const emit = makeEmit();

  const result = await endCall({
    callId: CALL_ID,
    userId: OWNER_ID,
    endReason: 'SYSTEM',
    status: 'CONNECTED',
    endedAt: new Date('2030-01-01T00:00:00.000Z'),
    guardianUserId: STRANGER_ID,
    sosId: new mongoose.Types.ObjectId().toString(),
    repository,
    emit: emit.fn,
  });

  assert.equal(result.call.status, 'ENDED', 'the transition is decided by the backend');
  assert.ok(result.call.endedAt.getFullYear() < 2027, 'the server clock wins');
  assert.equal(String(result.call.guardianUserId), GUARDIAN_ID, 'the guardian is not replaced');
  assert.equal(String(result.call.sosId), SOS_ID, 'the SOS reference is not replaced');
});

test('endCall never touches the SOS and never starts another call', async () => {
  const repository = makeEndRepository();
  const emit = makeEmit();

  const result = await end(repository, emit.fn, { endReason: 'SOS_RESOLVED' });

  assert.equal(result.ended, true);
  assert.deepEqual(
    repository.invoked,
    [],
    'no SOS read/write, no guardian selection, no new call'
  );
  assert.equal(repository.updates.length, 1, 'exactly one write, on the call only');
});

test('endCall propagates database failures to the error middleware', async () => {
  const repository = makeEndRepository();
  repository.findById = async () => {
    throw new Error('db down');
  };

  await assert.rejects(() => end(repository, makeEmit().fn), (err) => err.message === 'db down');
});

test('endCall emits nothing when the transition write fails', async () => {
  const repository = makeEndRepository();
  repository.endCallAtomically = async () => {
    throw new Error('write failed');
  };
  const emit = makeEmit();

  await assert.rejects(
    () => end(repository, emit.fn, { endReason: 'USER_ENDED' }),
    (err) => err.message === 'write failed'
  );

  assert.equal(emit.calls.length, 0, 'no call:ended without a successful write');
  assert.equal(repository.state.call.status, 'CONNECTED', 'the call keeps its state');
  assert.equal(repository.state.call.endedAt, null, 'no phantom endedAt');
});

test('simultaneous end requests from both participants settle on one termination', async () => {
  const repository = makeEndRepository();
  const emit = makeEmit();

  const [ownerEnd, guardianEnd] = await Promise.all([
    end(repository, emit.fn, { userId: OWNER_ID, endReason: 'USER_ENDED' }),
    end(repository, emit.fn, { userId: GUARDIAN_ID, endReason: 'GUARDIAN_ENDED' }),
  ]);

  const winners = [ownerEnd, guardianEnd].filter((r) => r.ended);
  assert.equal(winners.length, 1, 'exactly one request performs the transition');
  assert.equal(repository.updates.length, 1, 'exactly one write');
  assert.equal(repository.state.call.status, 'ENDED');

  const expectedEndedBy = ownerEnd.ended
    ? { userId: OWNER_ID, role: 'USER' }
    : { userId: GUARDIAN_ID, role: 'GUARDIAN' };

  assert.equal(emit.calls.length, 2, 'one notification per participant, no duplicates');
  assert.deepEqual(
    emit.calls.map((e) => e.userId).sort(),
    [GUARDIAN_ID, OWNER_ID].sort()
  );
  for (const { payload } of emit.calls) {
    assert.equal(
      payload.endReason,
      winners[0].call.endReason,
      'the winner’s reason is reported'
    );
    assert.deepEqual(
      payload.endedBy,
      expectedEndedBy,
      'the terminating participant is the one who actually won'
    );
  }
});

test('endCall still finishes a call that connected while the request was in flight', async () => {
  const repository = makeEndRepository({ call: callRecord({ status: 'ACCEPTED' }) });
  const emit = makeEmit();

  const original = repository.endCallAtomically;
  repository.endCallAtomically = async (callId, allowed, update) => {
    // LiveKit's ACCEPTED → CONNECTED lands first, mid-request.
    repository.state.call = {
      ...repository.state.call,
      status: 'CONNECTED',
      connectedAt: new Date(),
    };
    return original(callId, allowed, update);
  };

  const result = await end(repository, emit.fn, { endReason: 'USER_ENDED' });

  assert.equal(result.ended, true, 'CONNECTED is endable, so the end still wins');
  assert.equal(result.call.status, 'ENDED');
  assert.equal(emit.calls.length, 2, 'both participants hear the final termination once');
  assert.equal(repository.state.call.endedAt instanceof Date, true);
});

test('endCall never reports an endedBy the backend did not derive', async () => {
  const repository = makeEndRepository();
  const emit = makeEmit();

  await endCall({
    callId: CALL_ID,
    userId: GUARDIAN_ID,
    endReason: 'GUARDIAN_ENDED',
    endedBy: { userId: STRANGER_ID, role: 'ADMIN' },
    repository,
    emit: emit.fn,
  });

  for (const { payload } of emit.calls) {
    assert.deepEqual(
      payload.endedBy,
      { userId: GUARDIAN_ID, role: 'GUARDIAN' },
      'the authenticated terminator wins over anything the body claimed'
    );
  }
});

// ---------------------------------------------------------------------------
// POST /api/v1/calls/:id/accept — acceptCall
// ---------------------------------------------------------------------------

const ringingCall = (overrides = {}) => callRecord({ status: 'RINGING', ...overrides });

const makeAcceptRepository = ({ notFound = false, call = ringingCall() } = {}) => {
  const state = { call };
  const updates = [];

  const repository = {
    state,
    updates,
    invoked: [],
    findById: async () => (notFound ? null : state.call),
    // Profile lookup for the accepting guardian's display name.
    findUserById: async (id) =>
      ({
        [OWNER_ID]: { _id: OWNER_ID, name: 'Asha' },
        [GUARDIAN_ID]: { _id: GUARDIAN_ID, name: 'Baba' },
      })[String(id)] ?? null,
    // Mirrors the real filter: guardian ownership AND RINGING both have to hold.
    acceptCallAtomically: async (callId, guardianUserId, acceptedAt) => {
      if (String(state.call.guardianUserId) !== String(guardianUserId)) return null;
      if (state.call.status !== 'RINGING') return null;

      state.call = { ...state.call, status: 'ACCEPTED', updatedAt: acceptedAt };
      updates.push({ callId, guardianUserId, acceptedAt });
      return state.call;
    },
  };

  // Acceptance must never widen into SOS reads, guardian selection or new calls.
  for (const name of FORBIDDEN_REPOSITORY_METHODS) {
    repository[name] = async () => {
      repository.invoked.push(name);
      throw new Error(`acceptCall must not call ${name}`);
    };
  }

  return repository;
};

const accept = (repository, emit, args = {}) =>
  acceptCall({
    callId: args.callId ?? CALL_ID,
    userId: args.userId ?? GUARDIAN_ID,
    repository,
    emit,
  });

test('acceptCall flips a RINGING call to ACCEPTED with a server timestamp', async () => {
  const repository = makeAcceptRepository();
  const emit = makeEmit();

  const result = await accept(repository, emit.fn);

  assert.equal(result.accepted, true);

  const call = result.call;
  assert.equal(call.status, 'ACCEPTED');
  assert.ok(call.updatedAt instanceof Date, 'updatedAt is generated by the server');
  assert.ok(call.updatedAt.getTime() > new Date('2026-01-01T00:00:00.000Z').getTime());
  assert.equal(call.connectedAt, null, 'connectivity belongs to the LiveKit stage');
  assert.equal(call.endedAt, null, 'the call is not over');
  assert.equal(call.endReason, null, 'no end reason is invented');
  assert.equal(String(call.sosId), SOS_ID, 'sosId is not rewritten');
  assert.equal(String(call.guardianUserId), GUARDIAN_ID, 'the guardian is not rewritten');
  assert.deepEqual(
    call.participants.map((p) => p.identity),
    ['user:' + OWNER_ID, 'user:' + GUARDIAN_ID],
    'participants stay exactly as they were'
  );

  assert.deepEqual(
    Object.keys(repository.updates[0]).sort(),
    ['acceptedAt', 'callId', 'guardianUserId'],
    'the repository records who accepted and when'
  );
});

test('acceptCall returns 404 when the call does not exist', async () => {
  const repository = makeAcceptRepository({ notFound: true });
  const emit = makeEmit();

  await assert.rejects(
    () => accept(repository, emit.fn),
    (err) => err.statusCode === 404 && err.code === 'CALL_NOT_FOUND'
  );

  assert.equal(repository.updates.length, 0);
  assert.equal(emit.calls.length, 0);
});

test('acceptCall refuses the SOS owner, guardians of other calls and strangers', async () => {
  for (const unauthorized of [OWNER_ID, STRANGER_ID, new mongoose.Types.ObjectId().toString()]) {
    const repository = makeAcceptRepository();
    const emit = makeEmit();

    await assert.rejects(
      () => accept(repository, emit.fn, { userId: unauthorized }),
      (err) => err.statusCode === 403 && err.code === 'CALL_NOT_AUTHORIZED',
      unauthorized
    );

    assert.equal(repository.updates.length, 0, 'nothing is written');
    assert.equal(emit.calls.length, 0, 'nobody is notified');
    assert.equal(repository.state.call.status, 'RINGING', 'the call is untouched');
  }
});

test('acceptCall refuses every state except RINGING with 409', async () => {
  for (const status of [
    'CREATED',
    'OUTGOING',
    'ACCEPTED',
    'CONNECTED',
    'REJECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ]) {
    const repository = makeAcceptRepository({ call: callRecord({ status }) });
    const emit = makeEmit();

    await assert.rejects(
      () => accept(repository, emit.fn),
      (err) => err.statusCode === 409 && err.code === 'CALL_NOT_ACCEPTABLE',
      status
    );

    assert.equal(repository.updates.length, 0, status + ' is not written');
    assert.equal(repository.state.call.status, status, status + ' is preserved');
    assert.equal(emit.calls.length, 0, status + ' notifies nobody');
  }
});

test('acceptCall emits call:accepted to the SOS owner only after the database update', async () => {
  const order = [];
  const repository = makeAcceptRepository();
  const originalAccept = repository.acceptCallAtomically;

  repository.acceptCallAtomically = async (...args) => {
    order.push('db');
    return originalAccept(...args);
  };

  const emit = {
    calls: [],
    fn: (userId, event, payload) => {
      order.push(event);
      emit.calls.push({ userId: String(userId), event, payload });
      return true;
    },
  };

  const result = await accept(repository, emit.fn);

  assert.equal(result.accepted, true);
  assert.deepEqual(order, ['db', 'call:accepted'], 'DB first, sockets second');

  assert.equal(emit.calls.length, 1, 'only the waiting SOS owner is notified');
  assert.deepEqual(
    new Set(emit.calls.map((c) => c.userId)),
    new Set([OWNER_ID]),
    'nobody else — not the guardian, not a stranger — receives the event'
  );
  assert.equal(emit.calls[0].userId, OWNER_ID, 'the guardian already knows they accepted');
  assert.equal(emit.calls[0].event, 'call:accepted');
  assert.equal(emit.calls[0].event, CALL_EVENT.ACCEPTED, 'exactly the documented event name');

  const payload = emit.calls[0].payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['acceptedAt', 'callId', 'guardian', 'sosId', 'status', 'type'],
    'exactly the documented payload, no internal fields'
  );
  assert.equal(payload.callId, CALL_ID);
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.status, 'ACCEPTED');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.deepEqual(
    payload.guardian,
    { userId: GUARDIAN_ID, name: 'Baba' },
    'the accepting guardian, identified from the stored call'
  );
  assert.equal(
    payload.acceptedAt,
    new Date(result.call.updatedAt).toISOString(),
    'the timestamp of the acceptance write itself'
  );

  const raw = JSON.stringify(emit.calls);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes('LIVEKIT'), 'no LiveKit credentials');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('roomName'), 'the payload carries no connection details');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes('identities'), 'no internal document fields');
  assert.ok(!raw.includes('connectedAt'), 'acceptance is not connectivity');
});

test('acceptCall reports the winner when a concurrent accept already flipped the state', async () => {
  let reads = 0;
  const repository = {
    updates: [],
    invoked: [],
    findById: async () => {
      reads += 1;
      return reads === 1 ? ringingCall() : ringingCall({ status: 'ACCEPTED' });
    },
    // The conditional update lost the race: somebody else accepted first.
    acceptCallAtomically: async () => null,
  };
  const emit = makeEmit();

  await assert.rejects(
    () => accept(repository, emit.fn),
    (err) => err.statusCode === 409 && err.code === 'CALL_NOT_ACCEPTABLE'
  );

  assert.equal(repository.updates.length, 0, 'the loser performs no write');
  assert.equal(emit.calls.length, 0, 'only the winner notifies the owner');
});

test('acceptCall still succeeds when the notification channel fails', async () => {
  const repository = makeAcceptRepository();

  const result = await accept(repository, () => {
    throw new Error('socket down');
  });

  assert.equal(result.accepted, true);
  assert.equal(result.call.status, 'ACCEPTED');
});

test('acceptCall ignores an acceptance supplied by the caller', async () => {
  const repository = makeAcceptRepository();
  const emit = makeEmit();

  const result = await acceptCall({
    callId: CALL_ID,
    userId: GUARDIAN_ID,
    status: 'CONNECTED',
    guardianUserId: STRANGER_ID,
    sosId: new mongoose.Types.ObjectId().toString(),
    roomName: 'attacker-room',
    connectedAt: new Date('2030-01-01T00:00:00.000Z'),
    token: 'stolen',
    repository,
    emit: emit.fn,
  });

  assert.equal(result.call.status, 'ACCEPTED', 'the transition is decided by the backend');
  assert.equal(String(result.call.guardianUserId), GUARDIAN_ID, 'the guardian is not replaced');
  assert.equal(String(result.call.sosId), SOS_ID, 'the SOS reference is not replaced');
  assert.equal(result.call.connectedAt, null, 'no connectivity timestamp is invented');
  assert.ok(!('token' in result.call), 'no token material on the record');
});

test('acceptCall never touches the SOS and never starts another call', async () => {
  const repository = makeAcceptRepository();
  const emit = makeEmit();

  const result = await accept(repository, emit.fn);

  assert.equal(result.accepted, true);
  assert.deepEqual(
    repository.invoked,
    [],
    'no SOS read/write, no guardian selection, no new call'
  );
  assert.equal(repository.updates.length, 1, 'exactly one write, on the call only');
});

test('acceptCall propagates database failures to the error middleware', async () => {
  const repository = makeAcceptRepository();
  repository.findById = async () => {
    throw new Error('db down');
  };

  await assert.rejects(() => accept(repository, makeEmit().fn), (err) => err.message === 'db down');
});

// ---------------------------------------------------------------------------
// POST /api/v1/calls/:id/reject — rejectCall
// ---------------------------------------------------------------------------

const makeRejectRepository = ({ notFound = false, call = ringingCall() } = {}) => {
  const state = { call };
  const updates = [];

  const repository = {
    state,
    updates,
    invoked: [],
    findById: async () => (notFound ? null : state.call),
    // Profile lookup for the declining guardian's display name.
    findUserById: async (id) =>
      ({
        [OWNER_ID]: { _id: OWNER_ID, name: 'Asha' },
        [GUARDIAN_ID]: { _id: GUARDIAN_ID, name: 'Baba' },
      })[String(id)] ?? null,
    // Mirrors the real filter: guardian ownership AND RINGING both have to hold.
    rejectCallAtomically: async (callId, guardianUserId, rejectedAt) => {
      if (String(state.call.guardianUserId) !== String(guardianUserId)) return null;
      if (state.call.status !== 'RINGING') return null;

      state.call = {
        ...state.call,
        status: 'REJECTED',
        endReason: 'GUARDIAN_REJECTED',
        endedAt: rejectedAt,
        updatedAt: rejectedAt,
      };
      updates.push({ callId, guardianUserId, rejectedAt });
      return state.call;
    },
  };

  // Declining must never widen into SOS writes, guardian selection or new calls.
  for (const name of FORBIDDEN_REPOSITORY_METHODS) {
    repository[name] = async () => {
      repository.invoked.push(name);
      throw new Error(`rejectCall must not call ${name}`);
    };
  }

  return repository;
};

const reject = (repository, emit, args = {}) =>
  rejectCall({
    callId: args.callId ?? CALL_ID,
    userId: args.userId ?? GUARDIAN_ID,
    repository,
    emit,
  });

test('rejectCall flips a RINGING call to REJECTED and records why it ended', async () => {
  const repository = makeRejectRepository();
  const emit = makeEmit();

  const result = await reject(repository, emit.fn);

  assert.equal(result.rejected, true);

  const call = result.call;
  assert.equal(call.status, 'REJECTED');
  assert.equal(call.endReason, 'GUARDIAN_REJECTED', 'the controlled reason is stored');
  assert.ok(call.endedAt instanceof Date, 'endedAt is generated by the server');
  assert.ok(call.updatedAt instanceof Date, 'updatedAt is refreshed');
  assert.equal(call.updatedAt.getTime(), call.endedAt.getTime(), 'one timestamp for the flip');
  assert.ok(call.endedAt.getTime() > new Date('2026-01-01T00:00:00.000Z').getTime());
  assert.equal(call.connectedAt, null, 'media never started');
  assert.equal(String(call.sosId), SOS_ID, 'sosId is not rewritten');
  assert.equal(String(call.guardianUserId), GUARDIAN_ID, 'the guardian is not rewritten');
  assert.deepEqual(
    call.participants.map((p) => p.identity),
    ['user:' + OWNER_ID, 'user:' + GUARDIAN_ID],
    'participants stay exactly as they were'
  );

  assert.deepEqual(
    Object.keys(repository.updates[0]).sort(),
    ['callId', 'guardianUserId', 'rejectedAt'],
    'the repository records who declined and when'
  );
});

test('rejectCall returns 404 when the call does not exist', async () => {
  const repository = makeRejectRepository({ notFound: true });
  const emit = makeEmit();

  await assert.rejects(
    () => reject(repository, emit.fn),
    (err) => err.statusCode === 404 && err.code === 'CALL_NOT_FOUND'
  );

  assert.equal(repository.updates.length, 0);
  assert.equal(emit.calls.length, 0);
});

test('rejectCall refuses the SOS owner, guardians of other calls and strangers', async () => {
  for (const unauthorized of [OWNER_ID, STRANGER_ID, new mongoose.Types.ObjectId().toString()]) {
    const repository = makeRejectRepository();
    const emit = makeEmit();

    await assert.rejects(
      () => reject(repository, emit.fn, { userId: unauthorized }),
      (err) => err.statusCode === 403 && err.code === 'CALL_NOT_AUTHORIZED',
      unauthorized
    );

    assert.equal(repository.updates.length, 0, 'nothing is written');
    assert.equal(emit.calls.length, 0, 'nobody is notified');
    assert.equal(repository.state.call.status, 'RINGING', 'the call is untouched');
  }
});

test('rejectCall refuses every state except RINGING with 409', async () => {
  for (const status of [
    'CREATED',
    'OUTGOING',
    'ACCEPTED',
    'CONNECTED',
    'REJECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ]) {
    const repository = makeRejectRepository({ call: callRecord({ status }) });
    const emit = makeEmit();

    await assert.rejects(
      () => reject(repository, emit.fn),
      (err) => err.statusCode === 409 && err.code === 'CALL_NOT_REJECTABLE',
      status
    );

    assert.equal(repository.updates.length, 0, status + ' is not written');
    assert.equal(repository.state.call.status, status, status + ' is preserved');
    assert.equal(emit.calls.length, 0, status + ' notifies nobody');
  }
});

test('rejectCall emits call:rejected to the SOS owner only after the database update', async () => {
  const order = [];
  const repository = makeRejectRepository();
  const originalReject = repository.rejectCallAtomically;

  repository.rejectCallAtomically = async (...args) => {
    order.push('db');
    return originalReject(...args);
  };

  const emit = {
    calls: [],
    fn: (userId, event, payload) => {
      order.push(event);
      emit.calls.push({ userId: String(userId), event, payload });
      return true;
    },
  };

  const result = await reject(repository, emit.fn);

  assert.equal(result.rejected, true);
  assert.deepEqual(order, ['db', 'call:rejected'], 'DB first, sockets second');

  assert.equal(emit.calls.length, 1, 'only the waiting SOS owner is notified');
  assert.deepEqual(
    new Set(emit.calls.map((c) => c.userId)),
    new Set([OWNER_ID]),
    'nobody else — not the guardian, not a stranger — receives the event'
  );
  assert.equal(emit.calls[0].userId, OWNER_ID, 'the guardian already knows they declined');
  assert.equal(emit.calls[0].event, 'call:rejected');
  assert.equal(emit.calls[0].event, CALL_EVENT.REJECTED, 'exactly the documented event name');

  const payload = emit.calls[0].payload;
  assert.deepEqual(
    Object.keys(payload).sort(),
    ['callId', 'endReason', 'endedAt', 'guardian', 'sosId', 'status', 'type'],
    'exactly the documented payload, no internal fields'
  );
  assert.equal(payload.callId, CALL_ID);
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.status, 'REJECTED');
  assert.equal(payload.type, 'BROWSER_TO_BROWSER');
  assert.deepEqual(
    payload.guardian,
    { userId: GUARDIAN_ID, name: 'Baba' },
    'the declining guardian, identified from the stored call'
  );
  assert.equal(payload.endReason, 'GUARDIAN_REJECTED', 'the controlled reason the write recorded');
  assert.equal(
    payload.endedAt,
    new Date(result.call.endedAt).toISOString(),
    'the timestamp of the rejection write itself'
  );

  const raw = JSON.stringify(emit.calls);
  assert.ok(!raw.includes('apiSecret'), 'no LiveKit secret');
  assert.ok(!raw.includes('LIVEKIT'), 'no LiveKit credentials');
  assert.ok(!raw.includes('token'), 'no token material');
  assert.ok(!raw.includes('roomName'), 'the payload carries no connection details');
  assert.ok(!raw.includes('password'), 'no credentials');
  assert.ok(!raw.includes('identities'), 'no internal document fields');
  assert.ok(!raw.includes('connectedAt'), 'a rejected call never connected');
});

test('rejectCall reports the winner when a concurrent rejection already flipped the state', async () => {
  let reads = 0;
  const repository = {
    updates: [],
    invoked: [],
    findById: async () => {
      reads += 1;
      return reads === 1 ? ringingCall() : ringingCall({ status: 'REJECTED' });
    },
    // The conditional update lost the race: somebody else rejected first.
    rejectCallAtomically: async () => null,
  };
  const emit = makeEmit();

  await assert.rejects(
    () => reject(repository, emit.fn),
    (err) => err.statusCode === 409 && err.code === 'CALL_NOT_REJECTABLE'
  );

  assert.equal(repository.updates.length, 0, 'the loser performs no write');
  assert.equal(emit.calls.length, 0, 'only the winner notifies the owner');
});

test('a rejected call can never be accepted afterwards', async () => {
  const repository = makeRejectRepository();
  const emit = makeEmit();

  const { call } = await reject(repository, emit.fn);
  assert.equal(call.status, 'REJECTED');

  // Same document, seen by the accept flow: the terminal state must hold.
  const acceptRepository = {
    ...repository,
    acceptCallAtomically: repository.acceptCallAtomically ?? (async () => null),
  };

  await assert.rejects(
    () => accept(acceptRepository, emit.fn),
    (err) => err.statusCode === 409 && err.code === 'CALL_NOT_ACCEPTABLE'
  );

  assert.equal(repository.state.call.status, 'REJECTED', 'REJECTED → ACCEPTED never happens');
  assert.equal(emit.calls.length, 1, 'only the original call:rejected was emitted');
});

test('rejectCall still succeeds when the notification channel fails', async () => {
  const repository = makeRejectRepository();

  const result = await reject(repository, () => {
    throw new Error('socket down');
  });

  assert.equal(result.rejected, true);
  assert.equal(result.call.status, 'REJECTED');
});

test('rejectCall ignores a rejection supplied by the caller', async () => {
  const repository = makeRejectRepository();
  const emit = makeEmit();

  const result = await rejectCall({
    callId: CALL_ID,
    userId: GUARDIAN_ID,
    status: 'ENDED',
    endReason: 'SYSTEM',
    guardianUserId: STRANGER_ID,
    sosId: new mongoose.Types.ObjectId().toString(),
    roomName: 'attacker-room',
    endedAt: new Date('2030-01-01T00:00:00.000Z'),
    token: 'stolen',
    repository,
    emit: emit.fn,
  });

  assert.equal(result.call.status, 'REJECTED', 'the transition is decided by the backend');
  assert.equal(result.call.endReason, 'GUARDIAN_REJECTED', 'the reason is decided by the backend');
  assert.ok(result.call.endedAt.getFullYear() < 2027, 'the server clock wins');
  assert.equal(String(result.call.guardianUserId), GUARDIAN_ID, 'the guardian is not replaced');
  assert.equal(String(result.call.sosId), SOS_ID, 'the SOS reference is not replaced');
});

test('rejectCall never touches the SOS and never starts another call', async () => {
  const repository = makeRejectRepository();
  const emit = makeEmit();

  const result = await reject(repository, emit.fn);

  assert.equal(result.rejected, true);
  assert.deepEqual(
    repository.invoked,
    [],
    'no SOS read/write, no guardian selection, no new call'
  );
  assert.equal(repository.updates.length, 1, 'exactly one write, on the call only');
});

test('rejectCall propagates database failures to the error middleware', async () => {
  const repository = makeRejectRepository();
  repository.findById = async () => {
    throw new Error('db down');
  };

  await assert.rejects(() => reject(repository, makeEmit().fn), (err) => err.message === 'db down');
});
