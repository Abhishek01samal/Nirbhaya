import test from 'node:test';
import assert from 'node:assert/strict';

import { createGuardian, getGuardians, updateGuardian, removeGuardian, acceptGuardian, rejectGuardian } from '../src/modules/guardians/guardian.service.js';

const USER_ID = '64b0f0f0f0f0f0f0f0f0f0f1';
const GUARDIAN_ID = '64b0f0f0f0f0f0f0f0f0f0f2';

const makeRepository = ({ existing = null, created = null } = {}) => {
  const calls = { find: [], create: [] };
  return {
    calls,
    findRelationship: async (userId, guardianUserId) => {
      calls.find.push({ userId, guardianUserId });
      return existing;
    },
    createGuardian: async (data) => {
      calls.create.push(data);
      return created ?? { _id: 'new-id', ...data };
    },
  };
};

const makeDependencies = (user = { _id: GUARDIAN_ID }) => ({
  findUserById: async () => user,
});

test('createGuardian creates a PENDING relationship for the authenticated user', async () => {
  const repository = makeRepository();
  const result = await createGuardian({
    userId: USER_ID,
    guardianUserId: GUARDIAN_ID,
    relationship: 'Father',
    priority: 1,
    repository,
    dependencies: makeDependencies(),
  });

  assert.equal(repository.calls.create.length, 1);
  assert.deepEqual(repository.calls.create[0], {
    userId: USER_ID,
    guardianUserId: GUARDIAN_ID,
    relationship: 'Father',
    priority: 1,
    status: 'PENDING',
  });
  assert.equal(result.status, 'PENDING');
});

test('createGuardian keeps the relationship direction (owner invites guardian)', async () => {
  const repository = makeRepository();

  await createGuardian({
    userId: USER_ID,
    guardianUserId: GUARDIAN_ID,
    relationship: 'Mother',
    priority: 2,
    repository,
    dependencies: makeDependencies(),
  });

  assert.equal(repository.calls.find[0].userId, USER_ID);
  assert.equal(repository.calls.find[0].guardianUserId, GUARDIAN_ID);
});

test('createGuardian rejects a self-guardian request before any lookup', async () => {
  const repository = makeRepository();

  await assert.rejects(
    () =>
      createGuardian({
        userId: USER_ID,
        guardianUserId: USER_ID,
        relationship: 'Father',
        priority: 1,
        repository,
        dependencies: makeDependencies(),
      }),
    (err) => err.statusCode === 400 && err.code === 'GUARDIAN_SELF_NOT_ALLOWED'
  );

  assert.equal(repository.calls.find.length, 0);
  assert.equal(repository.calls.create.length, 0);
});

test('createGuardian rejects a non-existent target user', async () => {
  const repository = makeRepository();

  await assert.rejects(
    () =>
      createGuardian({
        userId: USER_ID,
        guardianUserId: GUARDIAN_ID,
        relationship: 'Father',
        priority: 1,
        repository,
        dependencies: makeDependencies(null),
      }),
    (err) => err.statusCode === 404 && err.code === 'GUARDIAN_USER_NOT_FOUND'
  );

  assert.equal(repository.calls.create.length, 0);
});

test('createGuardian rejects a duplicate relationship', async () => {
  const repository = makeRepository({ existing: { _id: 'existing-id' } });

  await assert.rejects(
    () =>
      createGuardian({
        userId: USER_ID,
        guardianUserId: GUARDIAN_ID,
        relationship: 'Father',
        priority: 1,
        repository,
        dependencies: makeDependencies(),
      }),
    (err) => err.statusCode === 409 && err.code === 'GUARDIAN_ALREADY_EXISTS'
  );

  assert.equal(repository.calls.create.length, 0);
});

test('createGuardian rejects an invalid priority even if validation is bypassed', async () => {
  for (const priority of [0, -1, 1.5]) {
    const repository = makeRepository();

    await assert.rejects(
      () =>
        createGuardian({
          userId: USER_ID,
          guardianUserId: GUARDIAN_ID,
          relationship: 'Father',
          priority,
          repository,
          dependencies: makeDependencies(),
        }),
      (err) => err.statusCode === 400 && err.code === 'GUARDIAN_INVALID_PRIORITY'
    );

    assert.equal(repository.calls.create.length, 0);
  }
});

test('createGuardian rejects a malformed guardianUserId', async () => {
  const repository = makeRepository();

  await assert.rejects(
    () =>
      createGuardian({
        userId: USER_ID,
        guardianUserId: 'not-an-id',
        relationship: 'Father',
        priority: 1,
        repository,
        dependencies: makeDependencies(),
      }),
    (err) => err.statusCode === 400 && err.code === 'GUARDIAN_INVALID_USER_ID'
  );

  assert.equal(repository.calls.create.length, 0);
});

test('createGuardian propagates database failures to the error middleware', async () => {
  const repository = {
    findRelationship: async () => null,
    createGuardian: async () => {
      throw new Error('db down');
    },
  };

  await assert.rejects(
    () =>
      createGuardian({
        userId: USER_ID,
        guardianUserId: GUARDIAN_ID,
        relationship: 'Father',
        priority: 1,
        repository,
        dependencies: makeDependencies(),
      }),
    (err) => err.message === 'db down'
  );
});

const makeListRepository = (rows = []) => {
  const calls = [];
  return {
    calls,
    findByUserId: async (userId) => {
      calls.push(userId);
      return rows;
    },
  };
};

test('getGuardians queries only by the authenticated user id', async () => {
  const rows = [{ _id: 'g1', priority: 1 }];
  const repository = makeListRepository(rows);

  const result = await getGuardians({ userId: USER_ID, repository });

  assert.deepEqual(result, rows);
  assert.deepEqual(repository.calls, [USER_ID]);
});

test('getGuardians is read-only (query method only)', async () => {
  const repository = makeListRepository([]);

  await getGuardians({ userId: USER_ID, repository });

  assert.deepEqual(Object.keys(repository), ['calls', 'findByUserId']);
});

test('getGuardians returns an empty array instead of throwing', async () => {
  const repository = makeListRepository([]);

  const result = await getGuardians({ userId: USER_ID, repository });

  assert.deepEqual(result, []);
});

test('getGuardians propagates database failures to the error middleware', async () => {
  const repository = {
    findByUserId: async () => {
      throw new Error('db down');
    },
  };

  await assert.rejects(
    () => getGuardians({ userId: USER_ID, repository }),
    (err) => err.message === 'db down'
  );
});

const makeUpdateRepository = (result = null) => {
  const calls = [];
  return {
    calls,
    updateByIdAndUserId: async (guardianId, userId, update) => {
      calls.push({ guardianId, userId, update });
      return result;
    },
  };
};

test('updateGuardian updates only the supplied editable fields', async () => {
  const repository = makeUpdateRepository({ _id: 'g1', priority: 2 });

  const result = await updateGuardian({
    guardianId: 'g1',
    userId: USER_ID,
    data: { priority: 2 },
    repository,
  });

  assert.equal(result.priority, 2);
  assert.deepEqual(repository.calls[0], {
    guardianId: 'g1',
    userId: USER_ID,
    update: { priority: 2 },
  });
});

test('updateGuardian builds the update explicitly (no body spread)', async () => {
  const repository = makeUpdateRepository({ _id: 'g1' });

  await updateGuardian({
    guardianId: 'g1',
    userId: USER_ID,
    data: { relationship: 'Father', priority: 3 },
    repository,
  });

  assert.deepEqual(Object.keys(repository.calls[0].update).sort(), ['priority', 'relationship']);
});

test('updateGuardian enforces ownership through the repository call', async () => {
  const repository = makeUpdateRepository(null);

  await assert.rejects(
    () =>
      updateGuardian({
        guardianId: 'g1',
        userId: USER_ID,
        data: { priority: 2 },
        repository,
      }),
    (err) => err.statusCode === 404 && err.code === 'GUARDIAN_NOT_FOUND'
  );

  assert.equal(repository.calls[0].userId, USER_ID);
});

test('updateGuardian rejects an empty update', async () => {
  const repository = makeUpdateRepository({ _id: 'g1' });

  await assert.rejects(
    () =>
      updateGuardian({ guardianId: 'g1', userId: USER_ID, data: {}, repository }),
    (err) => err.statusCode === 400 && err.code === 'GUARDIAN_EMPTY_UPDATE'
  );

  assert.equal(repository.calls.length, 0);
});

test('updateGuardian rejects invalid priority and relationship', async () => {
  const repository = makeUpdateRepository({ _id: 'g1' });

  await assert.rejects(
    () =>
      updateGuardian({
        guardianId: 'g1',
        userId: USER_ID,
        data: { priority: 1.5 },
        repository,
      }),
    (err) => err.statusCode === 400 && err.code === 'GUARDIAN_INVALID_PRIORITY'
  );

  await assert.rejects(
    () =>
      updateGuardian({
        guardianId: 'g1',
        userId: USER_ID,
        data: { relationship: '   ' },
        repository,
      }),
    (err) => err.statusCode === 400 && err.code === 'GUARDIAN_INVALID_RELATIONSHIP'
  );

  assert.equal(repository.calls.length, 0);
});

test('updateGuardian propagates database failures to the error middleware', async () => {
  const repository = {
    updateByIdAndUserId: async () => {
      throw new Error('db down');
    },
  };

  await assert.rejects(
    () =>
      updateGuardian({
        guardianId: 'g1',
        userId: USER_ID,
        data: { priority: 2 },
        repository,
      }),
    (err) => err.message === 'db down'
  );
});

const makeRemoveRepository = ({ deactivated = null, existing = null } = {}) => {
  const calls = { deactivate: [], findById: [] };
  return {
    calls,
    deactivateByIdAndUserId: async (guardianId, userId) => {
      calls.deactivate.push({ guardianId, userId });
      return deactivated;
    },
    findByIdAndUserId: async (guardianId, userId) => {
      calls.findById.push({ guardianId, userId });
      return existing;
    },
  };
};

test('removeGuardian deactivates the owned relationship to BLOCKED', async () => {
  const deactivated = { _id: 'g1', status: 'BLOCKED' };
  const repository = makeRemoveRepository({ deactivated });

  const result = await removeGuardian({ guardianId: 'g1', userId: USER_ID, repository });

  assert.equal(result.alreadyInactive, false);
  assert.equal(result.guardian, deactivated);
  assert.deepEqual(repository.calls.deactivate[0], { guardianId: 'g1', userId: USER_ID });
  assert.equal(repository.calls.findById.length, 0, 'no extra read when the update matched');
});

test('removeGuardian enforces ownership through the repository filter', async () => {
  const repository = makeRemoveRepository({ deactivated: null, existing: null });

  await assert.rejects(
    () => removeGuardian({ guardianId: 'g1', userId: USER_ID, repository }),
    (err) => err.statusCode === 404 && err.code === 'GUARDIAN_NOT_FOUND'
  );

  assert.equal(repository.calls.deactivate[0].userId, USER_ID);
  assert.equal(repository.calls.findById[0].userId, USER_ID, 'scoped read, not a global one');
});

test('removeGuardian reports an already inactive relationship as success', async () => {
  const existing = { _id: 'g1', status: 'BLOCKED' };
  const repository = makeRemoveRepository({ deactivated: null, existing });

  const result = await removeGuardian({ guardianId: 'g1', userId: USER_ID, repository });

  assert.equal(result.alreadyInactive, true);
  assert.equal(result.guardian, existing);
  assert.equal(repository.calls.deactivate.length, 1);
});

test('removeGuardian propagates database failures to the error middleware', async () => {
  const repository = {
    deactivateByIdAndUserId: async () => {
      throw new Error('db down');
    },
    findByIdAndUserId: async () => null,
  };

  await assert.rejects(
    () => removeGuardian({ guardianId: 'g1', userId: USER_ID, repository }),
    (err) => err.message === 'db down'
  );
});

const makeAcceptRepository = ({ accepted = null, existing = null } = {}) => {
  const calls = { accept: [], find: [] };
  return {
    calls,
    acceptByGuardian: async (guardianId, guardianUserId) => {
      calls.accept.push({ guardianId, guardianUserId });
      return accepted;
    },
    findByGuardianId: async (guardianId, guardianUserId) => {
      calls.find.push({ guardianId, guardianUserId });
      return existing;
    },
  };
};

test('acceptGuardian transitions PENDING -> ACTIVE for the invited guardian', async () => {
  const accepted = { _id: 'g1', status: 'ACTIVE' };
  const repository = makeAcceptRepository({ accepted });

  const result = await acceptGuardian({ guardianId: 'g1', guardianUserId: USER_ID, repository });

  assert.equal(result.guardian, accepted);
  assert.deepEqual(repository.calls.accept[0], { guardianId: 'g1', guardianUserId: USER_ID });
  assert.equal(repository.calls.find.length, 0, 'no extra read when the atomic update won');
});

test('acceptGuardian requires the authenticated user to be the guardian', async () => {
  const repository = makeAcceptRepository({ accepted: null, existing: null });

  await assert.rejects(
    () => acceptGuardian({ guardianId: 'g1', guardianUserId: USER_ID, repository }),
    (err) => err.statusCode === 404 && err.code === 'GUARDIAN_NOT_FOUND'
  );

  assert.equal(repository.calls.accept[0].guardianUserId, USER_ID, 'ownership in the filter');
  assert.equal(repository.calls.find[0].guardianUserId, USER_ID, 'scoped follow-up read');
});

test('acceptGuardian rejects a relationship that is not PENDING', async () => {
  const repository = makeAcceptRepository({
    accepted: null,
    existing: { _id: 'g1', status: 'ACTIVE' },
  });

  await assert.rejects(
    () => acceptGuardian({ guardianId: 'g1', guardianUserId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'GUARDIAN_NOT_PENDING'
  );
});

test('acceptGuardian propagates database failures to the error middleware', async () => {
  const repository = {
    acceptByGuardian: async () => {
      throw new Error('db down');
    },
    findByGuardianId: async () => null,
  };

  await assert.rejects(
    () => acceptGuardian({ guardianId: 'g1', guardianUserId: USER_ID, repository }),
    (err) => err.message === 'db down'
  );
});

const makeRejectRepository = ({ rejected = null, existing = null } = {}) => {
  const calls = { reject: [], find: [] };
  return {
    calls,
    rejectByGuardian: async (guardianId, guardianUserId) => {
      calls.reject.push({ guardianId, guardianUserId });
      return rejected;
    },
    findByGuardianId: async (guardianId, guardianUserId) => {
      calls.find.push({ guardianId, guardianUserId });
      return existing;
    },
  };
};

test('rejectGuardian transitions PENDING -> REJECTED for the invited guardian', async () => {
  const rejected = { _id: 'g1', status: 'REJECTED' };
  const repository = makeRejectRepository({ rejected });

  const result = await rejectGuardian({ guardianId: 'g1', guardianUserId: USER_ID, repository });

  assert.equal(result.guardian, rejected);
  assert.deepEqual(repository.calls.reject[0], { guardianId: 'g1', guardianUserId: USER_ID });
  assert.equal(repository.calls.find.length, 0, 'no extra read when the atomic update won');
});

test('rejectGuardian requires the authenticated user to be the guardian', async () => {
  const repository = makeRejectRepository({ rejected: null, existing: null });

  await assert.rejects(
    () => rejectGuardian({ guardianId: 'g1', guardianUserId: USER_ID, repository }),
    (err) => err.statusCode === 404 && err.code === 'GUARDIAN_NOT_FOUND'
  );

  assert.equal(repository.calls.reject[0].guardianUserId, USER_ID, 'ownership in the filter');
  assert.equal(repository.calls.find[0].guardianUserId, USER_ID, 'scoped follow-up read');
});

test('rejectGuardian rejects a relationship that is not PENDING', async () => {
  const repository = makeRejectRepository({
    rejected: null,
    existing: { _id: 'g1', status: 'BLOCKED' },
  });

  await assert.rejects(
    () => rejectGuardian({ guardianId: 'g1', guardianUserId: USER_ID, repository }),
    (err) => err.statusCode === 409 && err.code === 'GUARDIAN_NOT_PENDING'
  );
});

test('rejectGuardian propagates database failures to the error middleware', async () => {
  const repository = {
    rejectByGuardian: async () => {
      throw new Error('db down');
    },
    findByGuardianId: async () => null,
  };

  await assert.rejects(
    () => rejectGuardian({ guardianId: 'g1', guardianUserId: USER_ID, repository }),
    (err) => err.message === 'db down'
  );
});
