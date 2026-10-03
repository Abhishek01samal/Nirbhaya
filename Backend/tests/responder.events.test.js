import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import {
  startResponderEscalation,
  acknowledgeEscalation,
  runResponderTimeout,
} from '../src/modules/sos/escalation.service.js';
import {
  SOS_EVENT,
  SOS_LIFECYCLE_EVENT,
  RESPONDER_SOS_EVENT,
} from '../src/modules/sos/sos.events.js';
import { filterEligibleResponders } from '../src/modules/responders/responder.service.js';

/**
 * Nearby Responder Socket.IO event system: responder:sos-notification,
 * responder:sos-acknowledged and responder:sos-expired — the responder
 * channel around the EXISTING escalation state machine (never a second
 * state machine).
 *
 * Every test drives the real service functions with recording fakes and
 * asserts the contract: written first / emitted second, private responder or
 * owner rooms only (never a broadcast), exact payload key sets, one event
 * per logical transition (duplicates stay silent), and the expiry continuing
 * into the existing police escalation service. Authorization cases (not
 * notified / impersonation / wrong level), the ack-vs-timeout DB races and
 * the endpoint-level idempotency live in responder.acknowledge.test.js,
 * responder.notify.test.js and escalation.acknowledge.test.js — those
 * existing suites are updated for the second emission and stay authoritative
 * for the state machine itself.
 */

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0e1';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0e4';
const RESPONDER_1 = 'responder-001';
const RESPONDER_2 = 'responder-002';

const guardianLevel = () => ({
  type: 'GUARDIAN',
  status: 'TIMEOUT',
  targetId: '64b0f0f0f0f0f0f0f0f0f0e2',
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
} = {}) => ({
  _id: SOS_ID,
  userId: OWNER_ID,
  status,
  location: { lat: 19.31, lng: 84.79 },
  escalation: { currentLevel, levels },
});

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

const profiles = {
  findUserById: async (userId) =>
    String(userId) === OWNER_ID ? { _id: userId, name: 'Ansuman' } : null,
};

const relationships = { findRelationship: async () => null };

/** findById cursor for start flows (classify read, then the still-valid gate). */
const makeStartRepository = ({ finds, sequence = [], onStart = null }) => {
  const calls = { start: [] };
  let cursor = 0;
  return {
    calls,
    findById: async () => {
      sequence.push('read');
      const index = Math.min(cursor, finds.length - 1);
      cursor += 1;
      return finds[index] ?? null;
    },
    startResponderEscalation: async ({ level }) => {
      calls.start.push(level);
      sequence.push('write');
      if (onStart) return onStart(level);
      return sosDoc({ currentLevel: 1, levels: [guardianLevel(), level] });
    },
  };
};

/** Stateful ack fake mirroring the PENDING -> ACKNOWLEDGED filter. */
const makeAckRepository = (doc, sequence = []) => {
  const state = { doc };
  const calls = { ack: [] };
  return {
    state,
    calls,
    findById: async () => state.doc,
    acknowledgeEscalationLevel: async ({ levelIndex, respondedAt, target }) => {
      calls.ack.push({ levelIndex, respondedAt, target });
      const levels = state.doc.escalation.levels;
      const level = levels[levelIndex];
      const open =
        state.doc &&
        ['ACTIVE', 'ESCALATING'].includes(state.doc.status) &&
        level?.type === 'NEARBY_RESPONDER' &&
        level?.status === 'PENDING' &&
        (level.notifiedResponders ?? []).map(String).includes(String(target));
      if (!open) return null;

      sequence.push('write');
      state.doc = {
        ...state.doc,
        status: 'ACKNOWLEDGED',
        escalation: {
          currentLevel: levelIndex,
          levels: levels.map((entry, index) =>
            index === levelIndex
              ? { ...entry, status: 'ACKNOWLEDGED', respondedAt, targetId: target }
              : { ...entry }
          ),
        },
      };
      return state.doc;
    },
  };
};

/** Stateful timeout fake mirroring the PENDING -> TIMEOUT conditional write. */
const makeTimeoutRepository = ({ doc, sequence = [] }) => {
  const state = { doc };
  const calls = { timeout: [] };
  return {
    state,
    calls,
    sequence,
    findById: async () => state.doc,
    timeoutResponderEscalation: async () => {
      calls.timeout.push(state.doc?._id);
      const level = state.doc?.escalation?.levels?.[1];
      const open =
        state.doc &&
        ['ACTIVE', 'ESCALATING'].includes(state.doc.status) &&
        level?.type === 'NEARBY_RESPONDER' &&
        level?.status === 'PENDING';
      if (!open) return null;

      sequence.push('timeout');
      state.doc = {
        ...state.doc,
        escalation: {
          ...state.doc.escalation,
          levels: state.doc.escalation.levels.map((entry, index) =>
            index === 1 ? { ...entry, status: 'TIMEOUT' } : { ...entry }
          ),
        },
      };
      return state.doc;
    },
  };
};

const ackArgs = (overrides = {}) => ({
  sosId: SOS_ID,
  userId: RESPONDER_1,
  level: 'NEARBY_RESPONDER',
  responderId: RESPONDER_1,
  profiles,
  relationships,
  cancelTimeout: () => {},
  ...overrides,
});

// ---------- notification (§3-§7, test #1-#6, #21, #22, #27, #29) ----------

test('responder:sos-notification goes to each selected responder private room after the write', async () => {
  const sequence = [];
  const eligible = filterEligibleResponders();
  const level = responderLevel({ notifiedResponders: eligible.map((r) => r.id) });
  const repository = makeStartRepository({
    finds: [sosDoc(), sosDoc({ currentLevel: 1, levels: [guardianLevel(), level] })],
    sequence,
  });
  const emit = makeEmit(sequence);
  const schedule = makeSchedule(sequence);

  // The DEFAULT hardcoded responder dataset is used — no lookup API, no
  // geospatial discovery, no injected list (§2, #23-#26).
  await startResponderEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository,
    profiles,
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    timeoutMs: 30000,
  });

  // #27: validate -> persist -> arm -> re-read -> emit, never the other way.
  assert.deepEqual(sequence.filter((step) => step !== 'emit'), [
    'read',
    'write',
    'schedule',
    'read',
  ]);
  const writeIndex = sequence.indexOf('write');
  assert.ok(sequence.indexOf('emit') > writeIndex, 'the database write precedes every emit');
  assert.ok(sequence.indexOf('emit') > sequence.lastIndexOf('read'), 'gate re-read comes first');

  // #6/#3: the notified responders are persisted on the level first.
  const written = repository.calls.start[0];
  assert.deepEqual(
    written.notifiedResponders,
    eligible.map((r) => r.id),
    'every eligible hardcoded responder is recorded (§6)'
  );
  assert.equal(written.status, 'PENDING', 'notification state is PENDING, never acknowledged');

  // One sos:escalating (owner), then the detailed channel, then the
  // responder channel — same recipients, never a broadcast (§5, #5, #29).
  assert.deepEqual(emit.events(), [
    SOS_LIFECYCLE_EVENT.ESCALATING,
    SOS_EVENT.RESPONDER_NOTIFY,
    SOS_EVENT.RESPONDER_NOTIFY,
    RESPONDER_SOS_EVENT.NOTIFICATION,
    RESPONDER_SOS_EVENT.NOTIFICATION,
  ]);
  const notifications = emit.calls.filter(
    (call) => call.event === RESPONDER_SOS_EVENT.NOTIFICATION
  );
  assert.deepEqual(
    notifications.map((call) => call.userId).sort(),
    eligible.map((r) => r.id).sort(),
    'only the responders actually selected by the escalation service'
  );
  for (const call of notifications) {
    assert.ok(call.userId !== OWNER_ID, 'the owner never receives the responder notification');
    assert.ok(!call.userId.includes('*'), 'never a broadcast');
  }

  // §4 payload contract, exact keys, prototype labels only.
  const payload = notifications[0].payload;
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
  assert.equal(payload.radiusKm, 2, 'the 2 km business-rule label, never a measured distance');
  assert.deepEqual(payload.user, { userId: OWNER_ID, name: 'Ansuman' });
  assert.deepEqual(payload.location, { lat: 19.31, lng: 84.79 });
  assert.equal(typeof payload.expiresAt, 'string');
  for (const forbidden of ['distance', 'password', 'token', 'jwt', 'secret']) {
    assert.ok(!(forbidden in payload), `payload must not carry ${forbidden}`);
  }

  assert.equal(schedule.calls.length, 1, 'the write winner arms exactly one response timer');
  assert.equal(schedule.calls[0].ms, 30000);
});

test('duplicate escalation requests never duplicate responder:sos-notification (§21)', async () => {
  // (a) concurrent write loser: the state changed under the request, the
  // atomic write fails and nobody is notified — neither channel.
  const winner = sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] });
  const loserRepository = makeStartRepository({
    finds: [sosDoc(), winner],
    onStart: () => null,
  });
  const loserEmit = makeEmit();
  const loserSchedule = makeSchedule();

  const replay = await startResponderEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository: loserRepository,
    profiles,
    emit: loserEmit.fn,
    scheduleTimeout: loserSchedule.fn,
  });

  assert.equal(replay.status, 'PENDING', 'the winner state is replayed');
  assert.equal(loserEmit.calls.length, 0, 'the loser never notifies (#22)');
  assert.equal(loserSchedule.calls.length, 0, 'the loser never arms a timer');

  // (b) repeated API call: the level already exists, an idempotent replay
  // returns it without a second write and without a second notification batch.
  const replayRepository = makeStartRepository({
    finds: [winner],
    onStart: () => {
      throw new Error('a replay must never write');
    },
  });
  const replayEmit = makeEmit();

  const again = await startResponderEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    repository: replayRepository,
    profiles,
    emit: replayEmit.fn,
    scheduleTimeout: makeSchedule().fn,
  });

  assert.equal(again.status, 'PENDING');
  assert.equal(replayRepository.calls.start.length, 0, 'no duplicate level');
  assert.equal(replayEmit.calls.length, 0, 'no duplicate notification event (#6)');
});

// ---------- acknowledgement (§8-§12, test #7, #11-#14, #20, #27) ----------

test('responder:sos-acknowledged reaches the owner room after the write and resolves nothing', async () => {
  const sequence = [];
  const repository = makeAckRepository(
    sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] }),
    sequence
  );
  const emit = makeEmit(sequence);
  const cancels = [];
  const cancelTimeout = (sosId) => {
    cancels.push(sosId);
    sequence.push('cancel');
    return true;
  };

  const result = await acknowledgeEscalation(
    ackArgs({ repository, emit: emit.fn, cancelTimeout })
  );

  assert.equal(result.status, 'ACKNOWLEDGED');

  // #27: the atomic write always precedes cancellation and notification.
  assert.deepEqual(sequence, ['write', 'cancel', 'emit', 'emit']);

  // §10-§11: the owner's private room hears the detailed event and the
  // responder channel with the same payload — nobody else (never a
  // broadcast, never the responder).
  assert.deepEqual(emit.events(), [
    SOS_EVENT.RESPONDER_ACKNOWLEDGED,
    RESPONDER_SOS_EVENT.ACKNOWLEDGED,
  ]);
  for (const call of emit.calls) {
    assert.equal(call.userId, OWNER_ID, 'owner private room only');
    assert.ok(!call.userId.includes('*'), 'never a broadcast');
  }
  const payload = emit.calls[1].payload;
  assert.deepEqual(emit.calls[0].payload, payload, 'both channels carry the same §11 payload');
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
  assert.deepEqual(payload.responder, { responderId: RESPONDER_1, name: 'Rahul' });
  assert.equal(typeof payload.acknowledgedAt, 'string');

  // §12-§14 / #13: acknowledgement accepts responsibility only — no
  // sos:resolved, no lifecycle events, no police, no state beyond the ack.
  assert.ok(!emit.events().includes('sos:resolved'), 'never resolves the SOS');
  for (const event of emit.events()) {
    assert.ok(
      !Object.values(SOS_LIFECYCLE_EVENT).includes(event),
      'acknowledgement emits no lifecycle event'
    );
  }
  assert.equal(repository.state.doc.status, 'ACKNOWLEDGED', 'the existing ack rule, nothing more');
  assert.equal(repository.state.doc.resolvedAt, undefined, 'the SOS stays unresolved');
  assert.deepEqual(cancels, [SOS_ID], 'the responder response timer is cancelled');

  // §13 / #14: the notified list is history — both responders stay recorded.
  const stored = repository.state.doc.escalation.levels[1];
  assert.deepEqual(
    stored.notifiedResponders.map(String),
    [RESPONDER_1, RESPONDER_2],
    'the other responders are preserved'
  );
  assert.equal(stored.targetId, RESPONDER_1, 'the acknowledging responder is recorded');
});

test('a duplicate acknowledgement produces no duplicate events, writes or timers (#12, #20)', async () => {
  const repository = makeAckRepository(
    sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] })
  );
  const emit = makeEmit();
  const cancels = [];

  await acknowledgeEscalation(
    ackArgs({
      repository,
      emit: emit.fn,
      cancelTimeout: (sosId) => {
        cancels.push(sosId);
        return true;
      },
    })
  );
  assert.equal(emit.calls.length, 2, 'the first valid transition notifies once');

  await assert.rejects(
    () =>
      acknowledgeEscalation(
        ackArgs({
          repository,
          emit: emit.fn,
          cancelTimeout: (sosId) => {
            cancels.push(sosId);
            return true;
          },
        })
      ),
    (err) => err.statusCode === 409,
    'the second acknowledgement is refused idempotently'
  );

  assert.equal(repository.calls.ack.length, 1, 'exactly one write ever');
  assert.equal(emit.calls.length, 2, 'exactly one event pair ever');
  assert.equal(cancels.length, 1, 'the timer registry is not touched twice');
  assert.equal(repository.state.doc.escalation.levels[1].targetId, RESPONDER_1);
});

// ---------- expiry (§15-§19, test #14-#18, #25, #27, #28) ----------

test('responder:sos-expired notifies the level responders, then the existing police escalation continues', async () => {
  const sequence = [];
  const repository = makeTimeoutRepository({
    doc: sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] }),
    sequence,
  });
  const emit = makeEmit(sequence);
  const policeCalls = [];
  const escalatePolice = async (args) => {
    policeCalls.push(args);
    sequence.push('police');
  };

  const fired = await runResponderTimeout({
    sosId: SOS_ID,
    repository,
    emit: emit.fn,
    escalatePolice,
  });

  assert.equal(fired, true);

  // §25 order: the timeout write -> responder:sos-expired (both responders)
  // -> the police escalation step (which owns sos:escalating and
  // sos:police:escalated for the owner).
  assert.deepEqual(sequence, ['timeout', 'emit', 'emit', 'police']);

  assert.deepEqual(emit.events(), [
    RESPONDER_SOS_EVENT.EXPIRED,
    RESPONDER_SOS_EVENT.EXPIRED,
  ]);
  for (const call of emit.calls) {
    assert.ok([RESPONDER_1, RESPONDER_2].includes(call.userId), 'notified responders only');
    assert.ok(call.userId !== OWNER_ID, 'the owner hears the stage move via sos:escalating, not here');
  }

  // §16-§17: persisted status TIMEOUT, reason label, persisted expiresAt.
  const payload = emit.calls[0].payload;
  assert.deepEqual(Object.keys(payload).sort(), ['expiredAt', 'level', 'reason', 'sosId', 'status']);
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.level, 'NEARBY_RESPONDER');
  assert.equal(payload.status, 'TIMEOUT', 'the existing status representation, not EXPIRED');
  assert.equal(payload.reason, 'RESPONDER_TIMEOUT');
  assert.equal(typeof payload.expiredAt, 'string');

  // §19 / #16: the existing police escalation service is invoked directly
  // (no HTTP hop) with the persisted owner identity.
  assert.equal(policeCalls.length, 1, 'one continuation, never a duplicated one');
  assert.equal(policeCalls[0].sosId, SOS_ID);
  assert.equal(policeCalls[0].userId, OWNER_ID);

  assert.equal(repository.state.doc.escalation.levels[1].status, 'TIMEOUT');
  assert.equal(repository.state.doc.status, 'ACTIVE', 'expiry resolves nothing');
});

test('an expired responder level can no longer be acknowledged (#17)', async () => {
  const repository = makeTimeoutRepository({
    doc: sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] }),
  });
  const timeoutEmit = makeEmit();

  await runResponderTimeout({
    sosId: SOS_ID,
    repository,
    emit: timeoutEmit.fn,
    escalatePolice: async () => {},
  });
  assert.equal(timeoutEmit.calls.length, 2, 'seed: the expiry was notified');

  const ackEmit = makeEmit();
  await assert.rejects(
    () => acknowledgeEscalation(ackArgs({ repository, emit: ackEmit.fn })),
    (err) => err.statusCode === 409,
    'a late acknowledgement is refused'
  );

  assert.equal(repository.state.doc.escalation.levels[1].status, 'TIMEOUT', 'unchanged');
  assert.equal(repository.state.doc.escalation.levels[1].targetId, null, 'nothing was written');
  assert.equal(ackEmit.calls.length, 0, 'a refused acknowledgement notifies nobody');
});

test('duplicate timeout handlers duplicate neither the expiry event nor police escalation (#18, #21)', async () => {
  const sequence = [];
  const repository = makeTimeoutRepository({
    doc: sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] }),
    sequence,
  });
  const emit = makeEmit(sequence);
  const policeCalls = [];
  const escalatePolice = async (args) => {
    policeCalls.push(args);
    sequence.push('police');
  };

  assert.equal(
    await runResponderTimeout({ sosId: SOS_ID, repository, emit: emit.fn, escalatePolice }),
    true
  );
  assert.equal(
    await runResponderTimeout({ sosId: SOS_ID, repository, emit: emit.fn, escalatePolice }),
    false,
    'the second handler finds nothing pending'
  );

  assert.deepEqual(sequence, ['timeout', 'emit', 'emit', 'police'], 'exactly one of each');
  assert.equal(emit.calls.length, 2, 'no duplicate responder:sos-expired');
  assert.equal(policeCalls.length, 1, 'no duplicate police escalation');
});

test('a socket failure during the expiry never rolls back the timeout nor skips police (#28)', async () => {
  const repository = makeTimeoutRepository({
    doc: sosDoc({ currentLevel: 1, levels: [guardianLevel(), responderLevel()] }),
  });
  const failingEmit = async (userId, event) => {
    throw new Error(`socket backend down: ${event}`);
  };
  const policeCalls = [];

  const fired = await runResponderTimeout({
    sosId: SOS_ID,
    repository,
    emit: failingEmit,
    escalatePolice: async (args) => {
      policeCalls.push(args);
    },
  });

  assert.equal(fired, true, 'the persisted transition stands on its own');
  assert.equal(repository.state.doc.escalation.levels[1].status, 'TIMEOUT', 'no rollback');
  assert.equal(repository.state.doc.status, 'ACTIVE', 'the database remains authoritative');
  assert.equal(policeCalls.length, 1, 'a socket outage does not block the continuation');
});

// ---------- prototype constraints (§2, test #23-#26) ----------

test('the responder channel adds no geospatial calculation or external responder lookup (#23-#26)', () => {
  const backend = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const files = ['modules/sos/escalation.service.js', 'modules/sos/sos.events.js'];
  const forbidden = [
    '$near',
    '$geonear',
    '2dsphere',
    'haversine',
    'maps.googleapis',
    'directionsapi',
    'geocod',
    'distancekm',
    'googlemaps',
    'axios',
    'fetch(',
    'twilio',
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

  // The hardcoded dataset is the single source of truth for who is notified.
  const eligible = filterEligibleResponders();
  assert.ok(eligible.length >= 2, 'the prototype dataset has eligible responders');
  assert.deepEqual(
    eligible.map((responder) => responder.id),
    [RESPONDER_1, RESPONDER_2],
    'ONLINE sample responders only, from the hardcoded data module'
  );
});
