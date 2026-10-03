import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runGuardianTimeout,
  startGuardianEscalation,
} from '../src/modules/sos/escalation.service.js';
import { SOS_EVENT, SOS_LIFECYCLE_EVENT } from '../src/modules/sos/sos.events.js';

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0c1';
const GUARDIAN_A = '64b0f0f0f0f0f0f0f0f0f0c2';
const GUARDIAN_B = '64b0f0f0f0f0f0f0f0f0f0c3';
const STRANGER_ID = '64b0f0f0f0f0f0f0f0f0f0c4';
const SOS_ID = '64b0f0f0f0f0f0f0f0f0f0c5';

const sosDoc = (overrides = {}) => ({
  _id: SOS_ID,
  userId: OWNER_ID,
  status: 'ACTIVE',
  location: { lat: 19.31, lng: 84.79, address: 'Cuttack, Odisha' },
  escalation: { currentLevel: 0, levels: [] },
  ...overrides,
});

const guardian = (guardianUserId, priority = 1) => ({
  guardianUserId,
  priority,
  status: 'ACTIVE',
});

const guardianLevel = (targetId, status = 'PENDING', extra = {}) => ({
  type: 'GUARDIAN',
  status,
  targetId,
  notifiedAt: new Date(),
  respondedAt: null,
  expiresAt: new Date(Date.now() + 60000),
  ...extra,
});

/**
 * Fake SOS repository. `finds` is a sequence returned by successive findById
 * calls (the last entry repeats); `startResult: null` simulates a lost atomic
 * race; omitting `startResult` derives an updated document from the pushed
 * level (the success path). `sequence` records cross-fake ordering.
 */
const makeRepository = (options = {}) => {
  const { finds = [], sequence = [] } = options;
  const calls = { find: [], start: [], timeout: [] };
  let cursor = 0;

  return {
    calls,
    sequence,
    findById: async (sosId) => {
      calls.find.push(sosId);
      const index = Math.min(cursor, Math.max(finds.length - 1, 0));
      cursor += 1;
      const result = finds.length ? finds[index] : sosDoc();
      return result === undefined ? null : result;
    },
    startGuardianEscalation: async (args) => {
      calls.start.push(args);
      sequence.push('write');
      if (options.startResult !== undefined) return options.startResult;
      return sosDoc({ escalation: { currentLevel: 0, levels: [args.level] } });
    },
    timeoutGuardianEscalation: async (args) => {
      calls.timeout.push(args);
      sequence.push('timeout');
      if (options.timeoutResult !== undefined) return options.timeoutResult;
      return null;
    },
  };
};

const makeGuardianRepository = (list, accounts) => {
  const calls = { guardians: [], users: [] };
  return {
    calls,
    findActiveGuardians: async (userId) => {
      calls.guardians.push(userId);
      return list;
    },
    findUserById: async (userId) => {
      calls.users.push(String(userId));
      return accounts[String(userId)] ?? null;
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

const makeSchedule = () => {
  const calls = [];
  return {
    calls,
    fn: (task, ms) => {
      calls.push({ task, ms });
      return 'timer-handle';
    },
  };
};

const accountsFor = (extra = {}) => ({
  [OWNER_ID]: { _id: OWNER_ID, name: 'Ansuman' },
  [GUARDIAN_A]: { _id: GUARDIAN_A },
  [GUARDIAN_B]: { _id: GUARDIAN_B },
  ...extra,
});

const start = (overrides = {}) =>
  startGuardianEscalation({
    sosId: SOS_ID,
    userId: OWNER_ID,
    timeoutMs: 30000,
    isOnline: () => true,
    ...overrides,
  });

test('starts guardian escalation: summary, write-before-emit, timer registered', async () => {
  const sequence = [];
  const repository = makeRepository({ sequence });
  const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());
  const emit = makeEmit(sequence);
  const schedule = makeSchedule();

  const result = await start({ repository, guardianRepository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.deepEqual(Object.keys(result).sort(), [
    'expiresAt',
    'level',
    'sosId',
    'status',
    'targetId',
  ]);
  assert.equal(result.sosId, SOS_ID);
  assert.equal(result.level, 'GUARDIAN');
  assert.equal(result.status, 'PENDING');
  assert.equal(result.targetId, GUARDIAN_A);
  assert.ok(result.expiresAt instanceof Date, 'expiresAt is the level deadline');

  assert.equal(repository.calls.find.length, 1, 'one ownership read');
  assert.equal(repository.calls.start.length, 1, 'one atomic write');
  assert.deepEqual(
    sequence,
    ['write', 'emit', 'emit'],
    'the level must exist in the database before anyone is notified (guardian, then owner lifecycle)'
  );

  assert.deepEqual(
    guardianRepository.calls.guardians,
    [OWNER_ID],
    "selection reads the owner's guardian list"
  );

  assert.equal(schedule.calls.length, 1, 'one timeout timer');
  assert.equal(schedule.calls[0].ms, 30000, 'timeoutMs drives the timer');

  const level = repository.calls.start[0].level;
  assert.equal(level.type, 'GUARDIAN');
  assert.equal(level.status, 'PENDING');
  assert.equal(String(level.targetId), GUARDIAN_A);
  assert.ok(level.notifiedAt instanceof Date);
  assert.equal(level.respondedAt, null);
  assert.equal(
    level.expiresAt.getTime() - level.notifiedAt.getTime(),
    30000,
    'expiresAt = notifiedAt + timeout'
  );
  assert.equal(repository.calls.start[0].userId, OWNER_ID, 'write is scoped to the owner');
});

test('notification payload is exact and only carries lat/lng location', async () => {
  const repository = makeRepository();
  const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());
  const emit = makeEmit();
  const schedule = makeSchedule();

  await start({ repository, guardianRepository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.equal(emit.calls.length, 2, 'detailed guardian notification + owner lifecycle event');
  const { userId, event, payload } = emit.calls[0];
  assert.equal(userId, GUARDIAN_A, 'sent to the selected guardian only');
  assert.equal(event, SOS_EVENT.GUARDIAN_NOTIFY);
  assert.equal(event, 'sos:guardian:notify');

  assert.deepEqual(Object.keys(payload).sort(), [
    'expiresAt',
    'level',
    'location',
    'sosId',
    'status',
    'user',
  ]);
  assert.equal(payload.sosId, SOS_ID);
  assert.equal(payload.level, 'GUARDIAN');
  assert.equal(payload.status, 'PENDING');
  assert.deepEqual(payload.user, { userId: OWNER_ID, name: 'Ansuman' });
  assert.deepEqual(
    payload.location,
    { lat: 19.31, lng: 84.79 },
    'the free-text address never leaves through this payload'
  );
  assert.equal(payload.expiresAt, new Date(payload.expiresAt).toISOString(), 'ISO timestamp');
  assert.ok(payload.expiresAt);

  const lifecycle = emit.calls[1];
  assert.equal(lifecycle.userId, OWNER_ID, 'sos:guardian-notified goes to the owner room only');
  assert.equal(lifecycle.event, SOS_LIFECYCLE_EVENT.GUARDIAN_NOTIFIED);
  assert.equal(lifecycle.event, 'sos:guardian-notified');
  assert.deepEqual(
    Object.keys(lifecycle.payload).sort(),
    ['expiresAt', 'guardian', 'level', 'notifiedAt', 'sosId', 'status']
  );
  assert.equal(lifecycle.payload.sosId, SOS_ID);
  assert.equal(lifecycle.payload.level, 'GUARDIAN');
  assert.equal(lifecycle.payload.status, 'PENDING');
  assert.equal(lifecycle.payload.guardian.userId, GUARDIAN_A);
});

test('selects the first guardian by repository order (priority rule owner)', async () => {
  const repository = makeRepository();
  const guardianRepository = makeGuardianRepository(
    [guardian(GUARDIAN_B, 2), guardian(GUARDIAN_A, 1)],
    accountsFor()
  );
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await start({ repository, guardianRepository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.equal(result.targetId, GUARDIAN_B, 'repository order wins (priority ASC)');
  assert.equal(String(repository.calls.start[0].level.targetId), GUARDIAN_B);
  assert.deepEqual(guardianRepository.calls.guardians, [OWNER_ID]);
});

test('skips a guardian without an existing account and takes the next', async () => {
  const repository = makeRepository();
  const accounts = accountsFor();
  delete accounts[GUARDIAN_A];
  const guardianRepository = makeGuardianRepository(
    [guardian(GUARDIAN_A), guardian(GUARDIAN_B)],
    accounts
  );
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await start({ repository, guardianRepository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.equal(result.targetId, GUARDIAN_B);
  assert.equal(emit.calls[0].userId, GUARDIAN_B);
  assert.equal(schedule.calls.length, 1);
});

test('skips an offline guardian and takes the next reachable one', async () => {
  const repository = makeRepository();
  const guardianRepository = makeGuardianRepository(
    [guardian(GUARDIAN_A), guardian(GUARDIAN_B)],
    accountsFor()
  );
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await start({
    repository,
    guardianRepository,
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    isOnline: (id) => String(id) !== GUARDIAN_A,
  });

  assert.equal(result.targetId, GUARDIAN_B, 'offline guardian is not chosen');
  assert.equal(emit.calls[0].userId, GUARDIAN_B);
});

test('records a TIMEOUT level when no guardian is reachable: no emit, no timer', async () => {
  const repository = makeRepository();
  const accounts = accountsFor();
  delete accounts[GUARDIAN_A];
  const guardianRepository = makeGuardianRepository(
    [guardian(GUARDIAN_A), guardian(GUARDIAN_B)],
    accounts
  );
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await start({
    repository,
    guardianRepository,
    emit: emit.fn,
    scheduleTimeout: schedule.fn,
    isOnline: () => false,
  });

  assert.equal(result.level, 'GUARDIAN');
  assert.equal(result.status, 'TIMEOUT');
  assert.equal(result.targetId, null);
  assert.equal(result.expiresAt, null);

  assert.equal(repository.calls.start.length, 1, 'the level is still recorded atomically');
  const level = repository.calls.start[0].level;
  assert.equal(level.status, 'TIMEOUT');
  assert.equal(level.targetId, null);
  assert.equal(level.notifiedAt, null);

  assert.equal(emit.calls.length, 0, 'nobody to notify');
  assert.equal(schedule.calls.length, 0, 'a TIMEOUT level must not arm a timer');
});

test('a duplicate start replays the existing PENDING level without side effects', async () => {
  const existing = sosDoc({
    escalation: { currentLevel: 0, levels: [guardianLevel(GUARDIAN_A)] },
  });
  const repository = makeRepository({ finds: [existing] });
  const guardianRepository = makeGuardianRepository([], accountsFor());
  const emit = makeEmit();
  const schedule = makeSchedule();

  const result = await start({ repository, guardianRepository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.equal(result.status, 'PENDING');
  assert.equal(result.targetId, GUARDIAN_A);
  assert.equal(repository.calls.start.length, 0, 'no second write');
  assert.equal(emit.calls.length, 0, 'no re-notification');
  assert.equal(schedule.calls.length, 0, 'no stacked timer');
  assert.equal(repository.calls.find.length, 1);
});

test('a guardian already acknowledged elsewhere is refused with 409', async () => {
  const existing = sosDoc({
    escalation: { currentLevel: 0, levels: [guardianLevel(GUARDIAN_A, 'ACKNOWLEDGED')] },
  });
  const repository = makeRepository({ finds: [existing] });
  const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());

  await assert.rejects(
    () => start({ repository, guardianRepository, emit: makeEmit().fn, scheduleTimeout: makeSchedule().fn }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_ACKNOWLEDGED'
  );
  assert.equal(repository.calls.start.length, 0, 'nothing is written');
});

test('an acknowledged SOS is refused with ESCALATION_ALREADY_ACKNOWLEDGED', async () => {
  const existing = sosDoc({
    status: 'ACKNOWLEDGED',
    escalation: { currentLevel: 0, levels: [guardianLevel(GUARDIAN_A, 'ACKNOWLEDGED')] },
  });
  const repository = makeRepository({ finds: [existing] });
  const guardianRepository = makeGuardianRepository([], accountsFor());

  await assert.rejects(
    () => start({ repository, guardianRepository, emit: makeEmit().fn, scheduleTimeout: makeSchedule().fn }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_ACKNOWLEDGED'
  );
  assert.equal(repository.calls.start.length, 0);
});

test('an already TIMED-OUT guardian level is refused with ESCALATION_ALREADY_PROGRESS', async () => {
  const existing = sosDoc({
    escalation: { currentLevel: 0, levels: [guardianLevel(GUARDIAN_A, 'TIMEOUT')] },
  });
  const repository = makeRepository({ finds: [existing] });
  const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());

  await assert.rejects(
    () => start({ repository, guardianRepository, emit: makeEmit().fn, scheduleTimeout: makeSchedule().fn }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS'
  );
  assert.equal(repository.calls.start.length, 0);
});

test('a responder/police level already present is refused with ESCALATION_ALREADY_PROGRESS', async () => {
  const existing = sosDoc({
    escalation: {
      currentLevel: 1,
      levels: [
        guardianLevel(GUARDIAN_A, 'TIMEOUT'),
        { type: 'NEARBY_RESPONDER', status: 'PENDING', targetId: GUARDIAN_B },
      ],
    },
  });
  const repository = makeRepository({ finds: [existing] });
  const guardianRepository = makeGuardianRepository([], accountsFor());

  await assert.rejects(
    () => start({ repository, guardianRepository, emit: makeEmit().fn, scheduleTimeout: makeSchedule().fn }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_ALREADY_PROGRESS'
  );
  assert.equal(repository.calls.start.length, 0);
});

test('non-ACTIVE SOS states are refused with SOS_NOT_ACTIVE', async () => {
  for (const status of ['VERIFYING', 'CANCELLED', 'ACKNOWLEDGED', 'RESOLVED', 'ESCALATING']) {
    const repository = makeRepository({ finds: [sosDoc({ status })] });
    const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());

    await assert.rejects(
      () => start({ repository, guardianRepository, emit: makeEmit().fn, scheduleTimeout: makeSchedule().fn }),
      (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACTIVE',
      status
    );
    assert.equal(repository.calls.start.length, 0, status);
  }
});

test('missing SOS is 404 and a foreign SOS is 403 — neither writes', async () => {
  const missingRepo = makeRepository({ finds: [null] });
  await assert.rejects(
    () => start({ repository: missingRepo, guardianRepository: makeGuardianRepository([], {}) }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );
  assert.equal(missingRepo.calls.start.length, 0);

  const foreignRepo = makeRepository({ finds: [sosDoc({ userId: STRANGER_ID })] });
  await assert.rejects(
    () => start({ repository: foreignRepo, guardianRepository: makeGuardianRepository([], {}) }),
    (err) => err.statusCode === 403 && err.code === 'SOS_NOT_AUTHORIZED'
  );
  assert.equal(foreignRepo.calls.start.length, 0, 'a foreign caller never starts an escalation');
});

test('a throwing notification still returns the persisted PENDING level', async () => {
  const repository = makeRepository();
  const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());
  const schedule = makeSchedule();

  const result = await start({
    repository,
    guardianRepository,
    emit: async () => {
      throw new Error('socket backend down');
    },
    scheduleTimeout: schedule.fn,
  });

  assert.equal(result.status, 'PENDING');
  assert.equal(result.targetId, GUARDIAN_A);
  assert.equal(repository.calls.start.length, 1, 'the write already happened');
  assert.equal(schedule.calls.length, 1, 'the timer is independent of delivery');
});

test('a lost atomic race replays the winner level instead of failing', async () => {
  const winner = sosDoc({
    escalation: { currentLevel: 0, levels: [guardianLevel(GUARDIAN_A)] },
  });
  const sequence = [];
  const repository = makeRepository({ finds: [sosDoc(), winner], startResult: null, sequence });
  const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());
  const emit = makeEmit(sequence);
  const schedule = makeSchedule();

  const result = await start({ repository, guardianRepository, emit: emit.fn, scheduleTimeout: schedule.fn });

  assert.equal(result.status, 'PENDING');
  assert.equal(result.targetId, GUARDIAN_A);
  assert.equal(repository.calls.find.length, 2, 'initial read + post-race re-read');
  assert.equal(repository.calls.start.length, 1);
  assert.equal(emit.calls.length, 0, 'the winner already notified');
  assert.equal(schedule.calls.length, 0, 'the winner already armed the timer');
});

test('an unexplainable lost race surfaces as ESCALATION_START_CONFLICT', async () => {
  const repository = makeRepository({ finds: [sosDoc(), sosDoc()], startResult: null });
  const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());

  await assert.rejects(
    () => start({ repository, guardianRepository, emit: makeEmit().fn, scheduleTimeout: makeSchedule().fn }),
    (err) => err.statusCode === 409 && err.code === 'ESCALATION_START_CONFLICT'
  );
  assert.equal(repository.calls.start.length, 1, 'exactly one write attempt');
});

test('the real timer path records the guardian TIMEOUT', async () => {
  const repository = makeRepository({ timeoutResult: sosDoc() });
  const guardianRepository = makeGuardianRepository([guardian(GUARDIAN_A)], accountsFor());

  await start({
    repository,
    guardianRepository,
    emit: makeEmit().fn,
    scheduleTimeout: (task, ms) => setTimeout(task, ms),
    timeoutMs: 20,
  });

  await new Promise((resolve) => setTimeout(resolve, 120));

  assert.equal(repository.calls.timeout.length, 1, 'the armed timer fired once');
  assert.equal(repository.calls.timeout[0].sosId, SOS_ID);
});

test('runGuardianTimeout is guarded: changed, no-op and failure paths', async () => {
  const changed = makeRepository({ timeoutResult: sosDoc() });
  assert.equal(await runGuardianTimeout({ sosId: SOS_ID, repository: changed }), true);
  assert.equal(changed.calls.timeout[0].sosId, SOS_ID);

  const noOp = makeRepository({ timeoutResult: null });
  assert.equal(await runGuardianTimeout({ sosId: SOS_ID, repository: noOp }), false);

  const failing = {
    timeoutGuardianEscalation: async () => {
      throw new Error('db unavailable');
    },
  };
  assert.equal(
    await runGuardianTimeout({ sosId: SOS_ID, repository: failing }),
    false,
    'a timer callback never throws'
  );
});
