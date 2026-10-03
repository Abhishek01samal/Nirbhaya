import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSOS,
  getActiveSOS,
  getSOSById,
  confirmSOS,
  cancelSOS,
  acknowledgeSOS,
  resolveSOS,
  getSOSHistory,
} from '../src/modules/sos/sos.service.js';

const USER_ID = '64b0f0f0f0f0f0f0f0f0f0f1';

const makeRepository = ({ existing = null } = {}) => {
  const calls = { find: [], create: [] };

  return {
    calls,
    findUnresolvedSOS: async (args) => {
      calls.find.push(args);
      return existing;
    },
    createSOS: async (data) => {
      calls.create.push(data);
      return { _id: '64b0f0f0f0f0f0f0f0f0f0aa', createdAt: new Date(), updatedAt: new Date(), ...data };
    },
  };
};

const makeDependencies = ({ session = null, settings = null } = {}) => ({
  findSafetySessionById: async () => session,
  getUserEmergencySettings: async () => settings,
});

test('creates an SOS in VERIFYING state with a 10s default timeout', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies();

  const before = Date.now();
  const result = await createSOS({ userId: USER_ID, payload: { triggerType: 'MANUAL' }, repository, dependencies });
  const after = Date.now();

  assert.equal(result.created, true);

  const created = repository.calls.create[0];
  assert.equal(created.status, 'VERIFYING');
  assert.equal(created.userId, USER_ID);
  assert.equal(created.safetySessionId, null);
  assert.equal(created.triggerType, 'MANUAL');

  const expiresAt = created.verification.expiresAt.getTime();
  assert.ok(expiresAt >= before + 10000, 'expiry should be at least now + 10s');
  assert.ok(expiresAt <= after + 10000, 'expiry should be at most now + 10s');
  assert.equal(created.verification.userResponse, null);
  assert.equal(created.verification.respondedAt, null);

  assert.equal(created.escalation.currentLevel, 0);
  assert.deepEqual(created.escalation.levels, []);
});

test('uses emergencySettings.sosTimeoutSeconds when configured', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies({ settings: { sosTimeoutSeconds: 25 } });

  await createSOS({ userId: USER_ID, payload: { triggerType: 'MANUAL' }, repository, dependencies });

  const expiresAt = repository.calls.create[0].verification.expiresAt.getTime();
  assert.ok(expiresAt >= Date.now() + 24000 && expiresAt <= Date.now() + 26000);
});

test('ignores an invalid configured timeout and falls back to default', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies({ settings: { sosTimeoutSeconds: 0 } });

  await createSOS({ userId: USER_ID, payload: { triggerType: 'MANUAL' }, repository, dependencies });

  const expiresAt = repository.calls.create[0].verification.expiresAt.getTime();
  assert.ok(expiresAt >= Date.now() + 9000 && expiresAt <= Date.now() + 11000);
});

test('rejects a safety session that does not exist', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies({ session: null });

  await assert.rejects(
    () =>
      createSOS({
        userId: USER_ID,
        payload: { triggerType: 'MANUAL', safetySessionId: '64b0f0f0f0f0f0f0f0f0f0f0' },
        repository,
        dependencies,
      }),
    (err) => err.statusCode === 404 && err.code === 'SAFETY_SESSION_NOT_FOUND'
  );

  assert.equal(repository.calls.create.length, 0);
});

test('rejects a safety session owned by another user', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies({ session: { userId: '64b0f0f0f0f0f0f0f0f0f0f2' } });

  await assert.rejects(
    () =>
      createSOS({
        userId: USER_ID,
        payload: { triggerType: 'MANUAL', safetySessionId: '64b0f0f0f0f0f0f0f0f0f0f0' },
        repository,
        dependencies,
      }),
    (err) => err.statusCode === 403 && err.code === 'SAFETY_SESSION_FORBIDDEN'
  );

  assert.equal(repository.calls.create.length, 0);
});

test('returns the existing SOS instead of creating a duplicate', async () => {
  const existing = { _id: 'existing-id', status: 'ACTIVE' };
  const repository = makeRepository({ existing });
  const dependencies = makeDependencies();

  const result = await createSOS({ userId: USER_ID, payload: { triggerType: 'MANUAL' }, repository, dependencies });

  assert.equal(result.created, false);
  assert.equal(result.sos, existing);
  assert.equal(repository.calls.create.length, 0);
});

test('scopes the duplicate lookup to the supplied safety session', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies({ session: { userId: USER_ID } });

  await createSOS({
    userId: USER_ID,
    payload: { triggerType: 'MANUAL', safetySessionId: '64b0f0f0f0f0f0f0f0f0f0f0' },
    repository,
    dependencies,
  });

  assert.deepEqual(repository.calls.find[0].safetySessionIds, [
    '64b0f0f0f0f0f0f0f0f0f0f0',
    null,
  ]);
});

test('never trusts userId or expiresAt from the payload', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies();

  await createSOS({
    userId: USER_ID,
    payload: {
      triggerType: 'MANUAL',
      userId: '64b0f0f0f0f0f0f0f0f0f0f2',
      verification: { expiresAt: '2099-01-01T00:00:00.000Z' },
    },
    repository,
    dependencies,
  });

  const created = repository.calls.create[0];
  assert.equal(created.userId, USER_ID);
  assert.notEqual(created.verification.expiresAt.toISOString(), '2099-01-01T00:00:00.000Z');
});

test('stores no location when none is supplied', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies();

  await createSOS({ userId: USER_ID, payload: { triggerType: 'MANUAL' }, repository, dependencies });

  assert.equal(repository.calls.create[0].location, null);
});

test('stores supplied location', async () => {
  const repository = makeRepository();
  const dependencies = makeDependencies();

  await createSOS({
    userId: USER_ID,
    payload: {
      triggerType: 'OFF_ROUTE',
      triggerData: { riskLevel: 'HIGH', confidence: 0.9, reason: 'left route' },
      location: { lat: 19.31, lng: 84.79, address: 'Cuttack' },
    },
    repository,
    dependencies,
  });

  assert.deepEqual(repository.calls.create[0].location, {
    lat: 19.31,
    lng: 84.79,
    address: 'Cuttack',
  });
  assert.equal(repository.calls.create[0].triggerData.riskLevel, 'HIGH');
});

const makeActiveRepository = (sos = null) => {
  const calls = [];
  return {
    calls,
    findActiveByUserId: async (userId) => {
      calls.push(userId);
      return sos;
    },
  };
};

test('getActiveSOS returns the unresolved SOS', async () => {
  const sos = { _id: 'id-1', status: 'ACTIVE' };
  const repository = makeActiveRepository(sos);

  const result = await getActiveSOS({ userId: USER_ID, repository });

  assert.equal(result.active, true);
  assert.equal(result.sos, sos);
  assert.deepEqual(repository.calls, [USER_ID]);
});

test('getActiveSOS returns active:false when the user has no unresolved SOS', async () => {
  const repository = makeActiveRepository(null);

  const result = await getActiveSOS({ userId: USER_ID, repository });

  assert.deepEqual(result, { active: false, sos: null });
});

test('getActiveSOS never modifies the SOS', async () => {
  const sos = { _id: 'id-1', status: 'VERIFYING' };
  const repository = {
    findActiveByUserId: async () => sos,
  };

  const result = await getActiveSOS({ userId: USER_ID, repository });

  assert.equal(result.sos, sos);
  assert.equal(result.sos.status, 'VERIFYING');
});

test('getActiveSOS propagates database failures to the error middleware', async () => {
  const repository = {
    findActiveByUserId: async () => {
      throw new Error('connection down');
    },
  };

  await assert.rejects(
    () => getActiveSOS({ userId: USER_ID, repository }),
    (err) => err.message === 'connection down'
  );
});

const makeFindByIdRepository = (result = null) => {
  const calls = [];
  return {
    calls,
    findByIdAndUserId: async (sosId, userId) => {
      calls.push([sosId, userId]);
      return result;
    },
  };
};

test('getSOSById returns the owned SOS regardless of status', async () => {
  const sos = { _id: 'id-1', status: 'RESOLVED' };
  const repository = makeFindByIdRepository(sos);

  const result = await getSOSById({ sosId: 'id-1', userId: USER_ID, repository });

  assert.equal(result, sos);
  assert.deepEqual(repository.calls, [['id-1', USER_ID]]);
});

test('getSOSById throws the standard not-found error when the lookup returns null', async () => {
  const repository = makeFindByIdRepository(null);

  await assert.rejects(
    () => getSOSById({ sosId: '64b0f0f0f0f0f0f0f0f0f0f0', userId: USER_ID, repository }),
    (err) =>
      err.statusCode === 404 &&
      err.code === 'SOS_NOT_FOUND' &&
      err.message === 'SOS event not found'
  );
});

test('getSOSById scopes the database lookup to sosId AND userId', async () => {
  const repository = makeFindByIdRepository({ _id: 'id-1' });

  await getSOSById({ sosId: 'requested-id', userId: USER_ID, repository });

  assert.deepEqual(repository.calls[0], ['requested-id', USER_ID]);
});

test('getSOSById does not modify the returned SOS', async () => {
  const sos = { _id: 'id-1', status: 'VERIFYING', updatedAt: new Date() };
  const repository = makeFindByIdRepository(sos);

  const result = await getSOSById({ sosId: 'id-1', userId: USER_ID, repository });

  assert.equal(result, sos);
  assert.equal(result.status, 'VERIFYING');
});

test('getSOSById propagates database failures to the error middleware', async () => {
  const repository = {
    findByIdAndUserId: async () => {
      throw new Error('connection down');
    },
  };

  await assert.rejects(
    () => getSOSById({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.message === 'connection down'
  );
});

const makeConfirmRepository = ({ updated = null, current = null } = {}) => {
  const calls = { confirm: [], read: [] };
  return {
    calls,
    confirmAndActivate: async (args) => {
      calls.confirm.push(args);
      return updated;
    },
    findByIdAndUserId: async (sosId, userId) => {
      calls.read.push([sosId, userId]);
      return current;
    },
  };
};

test('confirmSOS performs a single atomic transition and returns the updated SOS', async () => {
  const updated = { _id: 'id-1', status: 'ACTIVE', verification: { userResponse: 'CONFIRMED' } };
  const repository = makeConfirmRepository({ updated });

  const result = await confirmSOS({ sosId: 'id-1', userId: USER_ID, repository });

  assert.equal(result, updated);
  assert.equal(repository.calls.confirm.length, 1);
  assert.equal(repository.calls.confirm[0].sosId, 'id-1');
  assert.equal(repository.calls.confirm[0].userId, USER_ID);
  assert.ok(repository.calls.confirm[0].respondedAt instanceof Date);
  assert.equal(repository.calls.read.length, 0, 'no re-read needed when the transition wins');
});

test('confirmSOS throws 404 when the SOS does not exist', async () => {
  const repository = makeConfirmRepository({ updated: null, current: null });

  await assert.rejects(
    () => confirmSOS({ sosId: 'missing', userId: USER_ID, repository }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );
  assert.equal(repository.calls.confirm.length, 1);
});

test('confirmSOS throws the identical 404 for a foreign SOS', async () => {
  const repository = makeConfirmRepository({ updated: null, current: null });

  const err = await confirmSOS({ sosId: 'foreign', userId: USER_ID, repository }).catch((e) => e);

  assert.equal(err.statusCode, 404);
  assert.equal(err.code, 'SOS_NOT_FOUND');
  assert.equal(err.message, 'SOS event not found');
});

test('confirmSOS refuses a SOS that is no longer VERIFYING', async () => {
  const repository = makeConfirmRepository({
    updated: null,
    current: { _id: 'id-1', status: 'ACTIVE' },
  });

  await assert.rejects(
    () => confirmSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_NOT_VERIFYING'
  );
});

test('confirmSOS refuses an expired verification window', async () => {
  const repository = makeConfirmRepository({
    updated: null,
    current: {
      _id: 'id-1',
      status: 'VERIFYING',
      verification: { expiresAt: new Date(Date.now() - 1000) },
    },
  });

  await assert.rejects(
    () => confirmSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_VERIFICATION_EXPIRED'
  );
});

const makeCancelRepository = ({ updated = null, current = null } = {}) => {
  const calls = { cancel: [], read: [] };
  return {
    calls,
    cancelAndRecord: async (args) => {
      calls.cancel.push(args);
      return updated;
    },
    findByIdAndUserId: async (sosId, userId) => {
      calls.read.push([sosId, userId]);
      return current;
    },
  };
};

test('cancelSOS performs a single atomic transition and returns the updated SOS', async () => {
  const updated = { _id: 'id-1', status: 'CANCELLED', verification: { userResponse: 'CANCELLED' } };
  const repository = makeCancelRepository({ updated });

  const result = await cancelSOS({ sosId: 'id-1', userId: USER_ID, repository });

  assert.equal(result, updated);
  assert.equal(repository.calls.cancel.length, 1);
  assert.equal(repository.calls.cancel[0].sosId, 'id-1');
  assert.equal(repository.calls.cancel[0].userId, USER_ID);
  assert.ok(repository.calls.cancel[0].respondedAt instanceof Date);
  assert.equal(repository.calls.read.length, 0, 'no re-read needed when the transition wins');
});

test('cancelSOS throws 404 when the SOS does not exist', async () => {
  const repository = makeCancelRepository({ updated: null, current: null });

  await assert.rejects(
    () => cancelSOS({ sosId: 'missing', userId: USER_ID, repository }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );
});

test('cancelSOS throws the identical 404 for a foreign SOS', async () => {
  const repository = makeCancelRepository({ updated: null, current: null });

  const err = await cancelSOS({ sosId: 'foreign', userId: USER_ID, repository }).catch((e) => e);

  assert.equal(err.statusCode, 404);
  assert.equal(err.code, 'SOS_NOT_FOUND');
  assert.equal(err.message, 'SOS event not found');
});

test('cancelSOS refuses a SOS that is no longer VERIFYING', async () => {
  const repository = makeCancelRepository({
    updated: null,
    current: { _id: 'id-1', status: 'ACTIVE' },
  });

  await assert.rejects(
    () => cancelSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) =>
      err.statusCode === 409 &&
      err.code === 'SOS_NOT_VERIFYING' &&
      err.message === 'Cancellation is only allowed while an SOS is VERIFYING (current: ACTIVE)'
  );
});

test('cancelSOS refuses an expired verification window', async () => {
  const repository = makeCancelRepository({
    updated: null,
    current: {
      _id: 'id-1',
      status: 'VERIFYING',
      verification: { expiresAt: new Date(Date.now() - 1000) },
    },
  });

  await assert.rejects(
    () => cancelSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_VERIFICATION_EXPIRED'
  );
});

test('confirmSOS still reports its own conflict code after the shared error refactor', async () => {
  const repository = makeConfirmRepository({
    updated: null,
    current: { _id: 'id-1', status: 'ACTIVE' },
  });

  await assert.rejects(
    () => confirmSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) =>
      err.code === 'SOS_NOT_VERIFYING' &&
      err.message === 'Confirmation is only allowed while an SOS is VERIFYING (current: ACTIVE)'
  );
});

const makeAckRepository = ({ found = [], updated = null } = {}) => {
  const queue = [...found];
  const calls = { find: [], ack: [] };
  return {
    calls,
    findById: async (sosId) => {
      calls.find.push(sosId);
      return queue.length ? queue.shift() : null;
    },
    acknowledgeByRecipient: async (args) => {
      calls.ack.push(args);
      return updated;
    },
  };
};

const activeSosWithLevels = (levels, currentLevel = 0) => ({
  _id: 'id-1',
  status: 'ACTIVE',
  escalation: { currentLevel, levels },
});

test('acknowledgeSOS acknowledges the recipient level atomically', async () => {
  const sos = activeSosWithLevels([
    { type: 'GUARDIAN', status: 'PENDING', targetId: USER_ID },
    { type: 'NEARBY_RESPONDER', status: 'NOTIFIED', targetId: 'someone-else' },
  ]);
  const updated = { ...sos, status: 'ACKNOWLEDGED' };
  const repository = makeAckRepository({ found: [sos], updated });

  const result = await acknowledgeSOS({ sosId: 'id-1', userId: USER_ID, repository });

  assert.equal(result, updated);
  assert.equal(repository.calls.ack.length, 1);
  assert.equal(repository.calls.ack[0].sosId, 'id-1');
  assert.equal(repository.calls.ack[0].levelIndex, 0);
  assert.ok(repository.calls.ack[0].respondedAt instanceof Date);
});

test('acknowledgeSOS picks the level that targets the requester, not the current level', async () => {
  const sos = activeSosWithLevels(
    [
      { type: 'GUARDIAN', status: 'NOTIFIED', targetId: 'someone-else' },
      { type: 'NEARBY_RESPONDER', status: 'NOTIFIED', targetId: USER_ID },
    ],
    0
  );
  const repository = makeAckRepository({ found: [sos], updated: { status: 'ACKNOWLEDGED' } });

  await acknowledgeSOS({ sosId: 'id-1', userId: USER_ID, repository });

  assert.equal(repository.calls.ack[0].levelIndex, 1);
});

test('acknowledgeSOS throws 404 when the SOS does not exist', async () => {
  const repository = makeAckRepository({ found: [] });

  await assert.rejects(
    () => acknowledgeSOS({ sosId: 'missing', userId: USER_ID, repository }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );
  assert.equal(repository.calls.ack.length, 0);
});

test('acknowledgeSOS refuses a VERIFYING SOS', async () => {
  const repository = makeAckRepository({
    found: [{ _id: 'id-1', status: 'VERIFYING', escalation: { currentLevel: 0, levels: [] } }],
  });

  await assert.rejects(
    () => acknowledgeSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACKNOWLEDGEABLE'
  );
  assert.equal(repository.calls.ack.length, 0);
});

test('acknowledgeSOS refuses an already ACKNOWLEDGED SOS', async () => {
  const repository = makeAckRepository({
    found: [{ _id: 'id-1', status: 'ACKNOWLEDGED', escalation: { currentLevel: 0, levels: [] } }],
  });

  await assert.rejects(
    () => acknowledgeSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_ACKNOWLEDGED'
  );
});

test('acknowledgeSOS forbids a requester who is not an escalation target', async () => {
  const repository = makeAckRepository({
    found: [
      activeSosWithLevels([{ type: 'GUARDIAN', status: 'PENDING', targetId: 'someone-else' }]),
    ],
  });

  await assert.rejects(
    () => acknowledgeSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RECIPIENT_NOT_AUTHORIZED'
  );
  assert.equal(repository.calls.ack.length, 0);
});

test('acknowledgeSOS refuses when this recipient already acknowledged', async () => {
  const repository = makeAckRepository({
    found: [
      activeSosWithLevels([
        { type: 'GUARDIAN', status: 'ACKNOWLEDGED', targetId: USER_ID, respondedAt: new Date() },
      ]),
    ],
  });

  await assert.rejects(
    () => acknowledgeSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_ACKNOWLEDGED'
  );
  assert.equal(repository.calls.ack.length, 0, 'authorization/state checked before writing');
});

test('acknowledgeSOS maps a lost concurrent race to a conflict', async () => {
  const sos = activeSosWithLevels([{ type: 'GUARDIAN', status: 'PENDING', targetId: USER_ID }]);
  const repository = makeAckRepository({
    found: [sos, { _id: 'id-1', status: 'ACKNOWLEDGED', escalation: sos.escalation }],
    updated: null,
  });

  await assert.rejects(
    () => acknowledgeSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_ACKNOWLEDGED'
  );
});

const makeResolveRepository = ({ found = [], updated = null } = {}) => {
  const queue = [...found];
  const calls = { find: [], resolve: [] };
  return {
    calls,
    findById: async (sosId) => {
      calls.find.push(sosId);
      return queue.length ? queue.shift() : null;
    },
    resolveById: async (args) => {
      calls.resolve.push(args);
      return updated;
    },
  };
};

const acknowledgedSos = (ownerId, levels = [], status = 'ACKNOWLEDGED') => ({
  _id: 'id-1',
  userId: ownerId,
  status,
  escalation: { currentLevel: 0, levels },
});

test('resolveSOS lets the owner resolve and passes an owner scope', async () => {
  const sos = acknowledgedSos(USER_ID);
  const updated = { ...sos, status: 'RESOLVED' };
  const repository = makeResolveRepository({ found: [sos], updated });

  const result = await resolveSOS({ sosId: 'id-1', userId: USER_ID, repository });

  assert.equal(result, updated);
  assert.equal(repository.calls.resolve.length, 1);
  assert.deepEqual(repository.calls.resolve[0].sosId, 'id-1');
  assert.equal(repository.calls.resolve[0].asOwner, true);
  assert.ok(repository.calls.resolve[0].resolvedAt instanceof Date);
});

test('resolveSOS lets the acknowledging recipient resolve with a level scope', async () => {
  const sos = acknowledgedSos('owner-id', [
    { type: 'GUARDIAN', status: 'ACKNOWLEDGED', targetId: USER_ID },
  ]);
  const repository = makeResolveRepository({ found: [sos], updated: { status: 'RESOLVED' } });

  await resolveSOS({ sosId: 'id-1', userId: USER_ID, repository });

  assert.equal(repository.calls.resolve[0].asOwner, false);
  assert.equal(repository.calls.resolve[0].levelIndex, 0);
});

test('resolveSOS throws 404 when the SOS does not exist', async () => {
  const repository = makeResolveRepository({ found: [] });

  await assert.rejects(
    () => resolveSOS({ sosId: 'missing', userId: USER_ID, repository }),
    (err) => err.statusCode === 404 && err.code === 'SOS_NOT_FOUND'
  );
  assert.equal(repository.calls.resolve.length, 0);
});

test('resolveSOS forbids a user who is neither owner nor acknowledging recipient', async () => {
  const repository = makeResolveRepository({
    found: [
      acknowledgedSos('owner-id', [
        { type: 'GUARDIAN', status: 'ACKNOWLEDGED', targetId: 'someone-else' },
      ]),
    ],
  });

  await assert.rejects(
    () => resolveSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RESOLVE_NOT_AUTHORIZED'
  );
  assert.equal(repository.calls.resolve.length, 0);
});

test('resolveSOS forbids a recipient that has not acknowledged', async () => {
  const repository = makeResolveRepository({
    found: [
      acknowledgedSos('owner-id', [
        { type: 'GUARDIAN', status: 'NOTIFIED', targetId: USER_ID },
      ]),
    ],
  });

  await assert.rejects(
    () => resolveSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RESOLVE_NOT_AUTHORIZED'
  );
});

test('resolveSOS checks authorization before state', async () => {
  const repository = makeResolveRepository({
    found: [acknowledgedSos('owner-id', [], 'ACTIVE')],
  });

  await assert.rejects(
    () => resolveSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 403 && err.code === 'SOS_RESOLVE_NOT_AUTHORIZED'
  );
});

test('resolveSOS refuses a SOS that is not ACKNOWLEDGED', async () => {
  const repository = makeResolveRepository({
    found: [acknowledgedSos(USER_ID, [], 'ACTIVE')],
  });

  await assert.rejects(
    () => resolveSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_NOT_ACKNOWLEDGED'
  );
  assert.equal(repository.calls.resolve.length, 0);
});

test('resolveSOS refuses an already RESOLVED SOS', async () => {
  const repository = makeResolveRepository({
    found: [acknowledgedSos(USER_ID, [], 'RESOLVED')],
  });

  await assert.rejects(
    () => resolveSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_RESOLVED'
  );
});

test('resolveSOS maps a lost concurrent race to already-resolved', async () => {
  const repository = makeResolveRepository({
    found: [acknowledgedSos(USER_ID), acknowledgedSos(USER_ID, [], 'RESOLVED')],
    updated: null,
  });

  await assert.rejects(
    () => resolveSOS({ sosId: 'id-1', userId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'SOS_ALREADY_RESOLVED'
  );
});

const makeHistoryRepository = ({ items = [], total = 0 } = {}) => {
  const calls = { find: [], count: [] };
  return {
    calls,
    findHistoryByUserId: async (args) => {
      calls.find.push(args);
      return items;
    },
    countHistoryByUserId: async (args) => {
      calls.count.push(args);
      return total;
    },
  };
};

test('getSOSHistory computes skip, total and totalPages', async () => {
  const items = [{ _id: 'a' }, { _id: 'b' }];
  const repository = makeHistoryRepository({ items, total: 45 });

  const result = await getSOSHistory({ userId: USER_ID, page: 3, limit: 20, repository });

  assert.deepEqual(result.items, items);
  assert.deepEqual(result.pagination, { page: 3, limit: 20, total: 45, totalPages: 3 });
  assert.deepEqual(repository.calls.find[0], { userId: USER_ID, skip: 40, limit: 20 });
  assert.deepEqual(repository.calls.count[0], { userId: USER_ID });
});

test('getSOSHistory is read-only (repository only exposes query methods)', async () => {
  const repository = makeHistoryRepository({ items: [], total: 0 });

  await getSOSHistory({ userId: USER_ID, page: 1, limit: 20, repository });

  const methods = Object.keys(repository).filter((key) => key !== 'calls');
  assert.ok(methods.includes('findHistoryByUserId'));
  assert.ok(methods.includes('countHistoryByUserId'));
  assert.equal(methods.length, 2, 'no mutating repository methods are used');
});

test('getSOSHistory returns an empty page instead of throwing', async () => {
  const repository = makeHistoryRepository({ items: [], total: 0 });

  const result = await getSOSHistory({ userId: USER_ID, page: 1, limit: 20, repository });

  assert.deepEqual(result.items, []);
  assert.deepEqual(result.pagination, { page: 1, limit: 20, total: 0, totalPages: 0 });
});

test('getSOSHistory propagates database failures to the error middleware', async () => {
  const repository = {
    findHistoryByUserId: async () => {
      throw new Error('db down');
    },
    countHistoryByUserId: async () => 0,
  };

  await assert.rejects(
    () => getSOSHistory({ userId: USER_ID, page: 1, limit: 20, repository }),
    (err) => err.message === 'db down'
  );
});
