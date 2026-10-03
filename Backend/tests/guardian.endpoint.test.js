import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { connectDB, disconnectDB } from '../src/config/db.js';
import { Guardian } from '../src/modules/guardians/guardian.model.js';
import { SosEvent } from '../src/modules/sos/sos.model.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const createdUserIds = [];
const createdGuardianIds = [];

const sign = (userId) =>
  jwt.sign({ sub: userId, role: 'USER' }, env.jwtSecret, { expiresIn: '5m' });

const newId = () => {
  const id = new mongoose.Types.ObjectId().toString();
  createdUserIds.push(id);
  return id;
};

let server;
let port;

const post = async (path, token, payload) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  });

  return { status: res.status, body: await res.json() };
};

const users = () => mongoose.connection.collection('users');

const seedUser = (userId) =>
  users().insertOne({ _id: new mongoose.Types.ObjectId(String(userId)), email: `${userId}@test.dev` });

const validBody = (guardianUserId, overrides = {}) => ({
  guardianUserId,
  relationship: 'Father',
  priority: 1,
  ...overrides,
});

before(async () => {
  if (hasDb) await connectDB();

  server = http.createServer(app);
  port = await new Promise((resolve) => {
    server.listen(0, () => resolve(server.address().port));
  });
});

after(async () => {
  if (hasDb && mongoose.connection.readyState !== 0) {
    await Guardian.deleteMany({ _id: { $in: createdGuardianIds } });
    await Guardian.deleteMany({ userId: { $in: createdUserIds } });
    await Guardian.deleteMany({ guardianUserId: { $in: createdUserIds } });
    await users().deleteMany({ _id: { $in: createdUserIds.map((id) => new mongoose.Types.ObjectId(id)) } });
    await SosEvent.deleteMany({ userId: { $in: createdUserIds } });
    await disconnectDB();
  }

  if (server) await new Promise((resolve) => server.close(resolve));
});

test('rejects an unauthenticated request', async () => {
  const { status, body } = await post('/api/v1/guardians', null, validBody(newId()));

  assert.equal(status, 401);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects missing guardianUserId with 400', async () => {
  const token = sign(newId());
  const { status, body } = await post('/api/v1/guardians', token, {
    relationship: 'Father',
    priority: 1,
  });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.guardianUserId');
});

test('rejects missing relationship with 400', async () => {
  const token = sign(newId());
  const { status, body } = await post('/api/v1/guardians', token, {
    guardianUserId: new mongoose.Types.ObjectId().toString(),
    priority: 1,
  });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.relationship');
});

test('rejects missing priority with 400', async () => {
  const token = sign(newId());
  const { status, body } = await post('/api/v1/guardians', token, {
    guardianUserId: new mongoose.Types.ObjectId().toString(),
    relationship: 'Father',
  });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.priority');
});

test('rejects zero, negative and non-integer priority with 400', async () => {
  const token = sign(newId());
  const guardianUserId = new mongoose.Types.ObjectId().toString();

  for (const priority of [0, -1, 1.5, 'first', null]) {
    const { status, body } = await post(
      '/api/v1/guardians',
      token,
      validBody(guardianUserId, { priority })
    );

    assert.equal(status, 400, 'priority=' + JSON.stringify(priority));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.details[0].path, 'body.priority');
  }
});

test('rejects an invalid guardian user id with 400', async () => {
  const token = sign(newId());
  const { status, body } = await post('/api/v1/guardians', token, validBody('not-an-id'));

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'body.guardianUserId');
});

dbTest('creates a guardian invitation with status PENDING', async () => {
  const userId = newId();
  const guardianUserId = newId();
  await seedUser(guardianUserId);

  const token = sign(userId);
  const { status, body } = await post('/api/v1/guardians', token, validBody(guardianUserId));

  assert.equal(status, 201);
  assert.equal(body.success, true);

  const guardian = body.data.guardian;
  assert.ok(mongoose.isValidObjectId(guardian.id));
  assert.equal(guardian.userId, userId, 'userId comes from authentication');
  assert.equal(guardian.guardianUserId, guardianUserId, 'guardianUserId is stored as given');
  assert.equal(guardian.relationship, 'Father');
  assert.equal(guardian.priority, 1);
  assert.equal(guardian.status, 'PENDING');
  assert.ok(guardian.createdAt);
  assert.ok(guardian.updatedAt);

  createdGuardianIds.push(guardian.id);

  const doc = await Guardian.findById(guardian.id).lean();
  assert.equal(String(doc.userId), userId);
  assert.equal(String(doc.guardianUserId), guardianUserId);
  assert.equal(doc.relationship, 'Father');
  assert.equal(doc.priority, 1);
  assert.equal(doc.status, 'PENDING');
});

dbTest('ignores userId supplied in the request body', async () => {
  const userId = newId();
  const guardianUserId = newId();
  await seedUser(guardianUserId);

  const token = sign(userId);
  const { status, body } = await post('/api/v1/guardians', token, {
    ...validBody(guardianUserId),
    userId: newId(),
    status: 'ACTIVE',
  });

  assert.equal(status, 201);
  assert.equal(body.data.guardian.userId, userId, 'body userId is never trusted');
  assert.equal(body.data.guardian.status, 'PENDING', 'body status is never trusted');

  createdGuardianIds.push(body.data.guardian.id);
});

dbTest('stores relationship and priority correctly', async () => {
  const userId = newId();
  const guardianUserId = newId();
  await seedUser(guardianUserId);

  const { status, body } = await post(
    '/api/v1/guardians',
    sign(userId),
    validBody(guardianUserId, { relationship: 'Best Friend', priority: 3 })
  );

  assert.equal(status, 201);
  assert.equal(body.data.guardian.relationship, 'Best Friend');
  assert.equal(body.data.guardian.priority, 3);

  createdGuardianIds.push(body.data.guardian.id);
});

dbTest('rejects a self-guardian request', async () => {
  const userId = newId();
  await seedUser(userId);

  const { status, body } = await post('/api/v1/guardians', sign(userId), validBody(userId));

  assert.equal(status, 400);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'GUARDIAN_SELF_NOT_ALLOWED');

  const count = await Guardian.countDocuments({ userId, guardianUserId: userId });
  assert.equal(count, 0, 'no self relationship is created');
});

dbTest('rejects a non-existent target user', async () => {
  const userId = newId();
  const missingUserId = new mongoose.Types.ObjectId().toString();

  const { status, body } = await post(
    '/api/v1/guardians',
    sign(userId),
    validBody(missingUserId)
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'GUARDIAN_USER_NOT_FOUND');

  const count = await Guardian.countDocuments({ userId });
  assert.equal(count, 0);
});

dbTest('rejects a duplicate guardian relationship', async () => {
  const userId = newId();
  const guardianUserId = newId();
  await seedUser(guardianUserId);

  const token = sign(userId);
  const first = await post('/api/v1/guardians', token, validBody(guardianUserId));
  assert.equal(first.status, 201);
  createdGuardianIds.push(first.body.data.guardian.id);

  const second = await post(
    '/api/v1/guardians',
    token,
    validBody(guardianUserId, { relationship: 'Uncle', priority: 2 })
  );

  assert.equal(second.status, 409);
  assert.equal(second.body.error.code, 'GUARDIAN_ALREADY_EXISTS');

  const count = await Guardian.countDocuments({ userId, guardianUserId });
  assert.equal(count, 1, 'exactly one relationship exists');
});

dbTest('rejects a duplicate even when the existing relationship is not PENDING', async () => {
  const userId = newId();
  const guardianUserId = newId();
  await seedUser(guardianUserId);

  const existing = await Guardian.create({
    userId,
    guardianUserId,
    relationship: 'Mother',
    priority: 1,
    status: 'REJECTED',
  });
  createdGuardianIds.push(String(existing._id));

  const { status, body } = await post(
    '/api/v1/guardians',
    sign(userId),
    validBody(guardianUserId)
  );

  assert.equal(status, 409);
  assert.equal(body.error.code, 'GUARDIAN_ALREADY_EXISTS');
});

dbTest('the duplicate check is scoped to the inviting user', async () => {
  const userA = newId();
  const userB = newId();
  const guardianUserId = newId();
  await seedUser(guardianUserId);

  const a = await post('/api/v1/guardians', sign(userA), validBody(guardianUserId));
  assert.equal(a.status, 201);
  createdGuardianIds.push(a.body.data.guardian.id);

  const b = await post('/api/v1/guardians', sign(userB), validBody(guardianUserId));
  assert.equal(b.status, 201, 'another user may invite the same guardian');
  createdGuardianIds.push(b.body.data.guardian.id);
});

dbTest('does not create SOS or modify unrelated data', async () => {
  const userId = newId();
  const guardianUserId = newId();
  await seedUser(guardianUserId);

  const sosBefore = await SosEvent.countDocuments({ userId });
  const guardianBefore = await Guardian.countDocuments({ userId });

  const { status } = await post('/api/v1/guardians', sign(userId), validBody(guardianUserId));
  assert.equal(status, 201);

  const sosAfter = await SosEvent.countDocuments({ userId });
  const guardianAfter = await Guardian.countDocuments({ userId });

  assert.equal(sosAfter, sosBefore, 'no SOS document is created or removed');
  assert.equal(guardianAfter, guardianBefore + 1, 'only the guardian document was added');
});

dbTest('database failure is handled by the central error middleware', async () => {
  const userId = newId();
  const guardianUserId = new mongoose.Types.ObjectId().toString();

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await post(
      '/api/v1/guardians',
      sign(userId),
      validBody(guardianUserId)
    );

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------- GET /api/v1/guardians ----------

const get = async (path, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

const seedGuardian = (userId, guardianUserId, overrides = {}) =>
  Guardian.create({
    userId,
    guardianUserId,
    relationship: 'Friend',
    priority: 1,
    status: 'PENDING',
    ...overrides,
  });

const track = (guardian) => {
  createdGuardianIds.push(String(guardian._id));
  return guardian;
};

test('rejects an unauthenticated guardians list request', async () => {
  const { status, body } = await get('/api/v1/guardians', null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

dbTest('returns the authenticated user guardians', async () => {
  const userId = newId();
  const guardianUserId = newId();
  await seedGuardian(userId, guardianUserId, { relationship: 'Father', priority: 1 });

  const { status, body } = await get('/api/v1/guardians', sign(userId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.guardians.length, 1);

  const item = body.data.guardians[0];
  assert.ok(mongoose.isValidObjectId(item.id));
  assert.equal(item.guardianUserId, guardianUserId);
  assert.equal(item.relationship, 'Father');
  assert.equal(item.priority, 1);
  assert.equal(item.status, 'PENDING');
  assert.equal(typeof item.createdAt, 'string');
  assert.equal(typeof item.updatedAt, 'string');
});

dbTest('returns only the authenticated user guardians', async () => {
  const userA = newId();
  const userB = newId();
  const guardianForA = newId();
  const guardianForB = newId();
  await seedGuardian(userA, guardianForA, { relationship: 'Father' });
  await seedGuardian(userB, guardianForB, { relationship: 'Mother' });

  const { status, body } = await get('/api/v1/guardians', sign(userA));

  assert.equal(status, 200);
  assert.equal(body.data.guardians.length, 1);
  assert.equal(body.data.guardians[0].guardianUserId, guardianForA);
  assert.notEqual(body.data.guardians[0].guardianUserId, guardianForB);
});

dbTest('ignores a userId query parameter', async () => {
  const userA = newId();
  const userB = newId();
  await seedGuardian(userA, newId());
  const bGuardian = await track(await seedGuardian(userB, newId()));

  const { status, body } = await get('/api/v1/guardians?userId=' + userB, sign(userA));

  assert.equal(status, 200);
  assert.equal(body.data.guardians.length, 1);
  assert.notEqual(body.data.guardians[0].id, String(bGuardian._id));
});

dbTest('returns guardians sorted by priority ascending', async () => {
  const userId = newId();
  await seedGuardian(userId, newId(), { relationship: 'Brother', priority: 3 });
  await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1 });
  await seedGuardian(userId, newId(), { relationship: 'Mother', priority: 2 });

  const { status, body } = await get('/api/v1/guardians', sign(userId));

  assert.equal(status, 200);
  assert.deepEqual(
    body.data.guardians.map((g) => g.relationship),
    ['Father', 'Mother', 'Brother']
  );
  assert.deepEqual(
    body.data.guardians.map((g) => g.priority),
    [1, 2, 3]
  );
});

dbTest('orders same-priority guardians deterministically by createdAt', async () => {
  const userId = newId();
  const first = await track(
    await seedGuardian(userId, newId(), { relationship: 'Alpha', priority: 2 })
  );
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = await track(
    await seedGuardian(userId, newId(), { relationship: 'Beta', priority: 2 })
  );

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { status, body } = await get('/api/v1/guardians', sign(userId));

    assert.equal(status, 200);
    assert.deepEqual(
      body.data.guardians.map((g) => g.id),
      [String(first._id), String(second._id)],
      'stable order across repeated reads'
    );
  }
});

dbTest('returns guardians of every status unfiltered', async () => {
  const userId = newId();
  const statuses = ['PENDING', 'ACTIVE', 'REJECTED', 'BLOCKED'];

  for (const [i, status] of statuses.entries()) {
    await seedGuardian(userId, newId(), { status, priority: i + 1 });
  }

  const { status, body } = await get('/api/v1/guardians', sign(userId));

  assert.equal(status, 200);
  assert.equal(body.data.guardians.length, 4);
  assert.deepEqual(
    body.data.guardians.map((g) => g.status),
    statuses,
    'stored statuses are returned unchanged and unfiltered'
  );
});

dbTest('returns an empty array when the user has no guardians', async () => {
  const userId = newId();

  const { status, body } = await get('/api/v1/guardians', sign(userId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.deepEqual(body.data.guardians, []);
});

dbTest('does not expose sensitive user fields', async () => {
  const userId = newId();
  const guardianUserId = newId();
  await seedUser(guardianUserId);
  await users().updateOne(
    { _id: new mongoose.Types.ObjectId(guardianUserId) },
    { $set: { passwordHash: 'super-secret-hash', apiKey: 'sk-live-secret' } }
  );
  await seedGuardian(userId, guardianUserId, { relationship: 'Father' });

  const { status, body } = await get('/api/v1/guardians', sign(userId));

  assert.equal(status, 200);

  const raw = JSON.stringify(body);
  assert.ok(!raw.includes('super-secret-hash'), 'no password hash leaks');
  assert.ok(!raw.includes('sk-live-secret'), 'no auth secrets leak');
  assert.ok(!raw.includes('passwordHash'));
  assert.ok(!raw.includes('"email"'));

  const item = body.data.guardians[0];
  assert.deepEqual(
    Object.keys(item).sort(),
    ['createdAt', 'guardianUserId', 'id', 'priority', 'relationship', 'status', 'updatedAt'],
    'only the documented guardian fields are returned'
  );
});

dbTest('does not modify any guardian or SOS document', async () => {
  const userId = newId();
  await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1 });
  await seedGuardian(userId, newId(), { relationship: 'Mother', priority: 2, status: 'BLOCKED' });

  const guardiansBefore = await Guardian.find({ userId }).lean();
  const sosBefore = await SosEvent.countDocuments({ userId });

  const { status, body } = await get('/api/v1/guardians', sign(userId));
  assert.equal(status, 200);
  assert.equal(body.data.guardians.length, 2);

  const guardiansAfter = await Guardian.find({ userId }).lean();
  const sosAfter = await SosEvent.countDocuments({ userId });

  assert.deepEqual(guardiansAfter, guardiansBefore, 'guardian documents are untouched');
  assert.equal(sosAfter, sosBefore, 'no SOS document changes');
});

dbTest('guardians list database failure is handled by the central error middleware', async () => {
  const token = sign(newId());

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await get('/api/v1/guardians', token);

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
    assert.ok(!JSON.stringify(body).includes('ECONNREFUSED'), 'raw db errors are not exposed');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------- PATCH /api/v1/guardians/:id ----------

const patch = async (path, token, payload) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(payload ?? {}),
  });

  return { status: res.status, body: await res.json() };
};

const patchGuardian = (id, token, payload) => patch('/api/v1/guardians/' + id, token, payload);

test('rejects an unauthenticated update request', async () => {
  const { status, body } = await patchGuardian(
    new mongoose.Types.ObjectId().toString(),
    null,
    { priority: 2 }
  );

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid guardian id with 400', async () => {
  const token = sign(newId());
  const { status, body } = await patchGuardian('not-an-id', token, { priority: 2 });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

test('rejects an empty request body', async () => {
  const token = sign(newId());
  const { status, body } = await patchGuardian(new mongoose.Types.ObjectId().toString(), token, {});

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
});

test('rejects invalid priority values with 400', async () => {
  const token = sign(newId());
  const id = new mongoose.Types.ObjectId().toString();

  for (const priority of [0, -1, 1.5, 'first', null]) {
    const { status, body } = await patchGuardian(id, token, { priority });

    assert.equal(status, 400, 'priority=' + JSON.stringify(priority));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.details[0].path, 'body.priority');
  }
});

test('rejects an empty relationship with 400', async () => {
  const token = sign(newId());
  const id = new mongoose.Types.ObjectId().toString();

  for (const relationship of ['', '   ']) {
    const { status, body } = await patchGuardian(id, token, { relationship });

    assert.equal(status, 400, 'relationship=' + JSON.stringify(relationship));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
    assert.equal(body.error.details[0].path, 'body.relationship');
  }
});

test('rejects protected fields with 400 instead of modifying them', async () => {
  const token = sign(newId());
  const id = new mongoose.Types.ObjectId().toString();

  for (const payload of [
    { userId: new mongoose.Types.ObjectId().toString() },
    { guardianUserId: new mongoose.Types.ObjectId().toString() },
    { status: 'ACTIVE' },
    { createdAt: new Date().toISOString() },
  ]) {
    const { status, body } = await patchGuardian(id, token, payload);

    assert.equal(status, 400, JSON.stringify(payload));
    assert.equal(body.error.code, 'VALIDATION_ERROR');
  }
});

dbTest('owner updates relationship only', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1, status: 'PENDING' })
  );

  const { status, body } = await patchGuardian(
    String(guardian._id),
    sign(userId),
    { relationship: '  Mother  ' }
  );

  assert.equal(status, 200);
  assert.equal(body.success, true);

  const updated = body.data.guardian;
  assert.equal(updated.id, String(guardian._id));
  assert.equal(updated.relationship, 'Mother', 'value is trimmed');
  assert.equal(updated.priority, 1, 'priority untouched');
  assert.equal(updated.status, 'PENDING');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.relationship, 'Mother');
  assert.equal(doc.priority, 1);
});

dbTest('owner updates priority only', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1 })
  );

  const { status, body } = await patchGuardian(
    String(guardian._id),
    sign(userId),
    { priority: 2 }
  );

  assert.equal(status, 200);
  assert.equal(body.data.guardian.priority, 2);
  assert.equal(body.data.guardian.relationship, 'Father', 'relationship untouched');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.priority, 2);
  assert.equal(doc.relationship, 'Father');
});

dbTest('owner updates both fields at once', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1, status: 'ACTIVE' })
  );

  const { status, body } = await patchGuardian(
    String(guardian._id),
    sign(userId),
    { relationship: 'Brother', priority: 3 }
  );

  assert.equal(status, 200);
  assert.equal(body.data.guardian.relationship, 'Brother');
  assert.equal(body.data.guardian.priority, 3);
  assert.equal(body.data.guardian.status, 'ACTIVE', 'status preserved');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.relationship, 'Brother');
  assert.equal(doc.priority, 3);
  assert.equal(doc.status, 'ACTIVE');
  assert.equal(String(doc.guardianUserId), String(guardian.guardianUserId));
  assert.ok(new Date(doc.updatedAt).getTime() >= new Date(guardian.updatedAt).getTime());
});

dbTest('status is never changed by a PATCH', async () => {
  const userId = newId();

  for (const status of ['PENDING', 'ACTIVE', 'REJECTED', 'BLOCKED']) {
    const guardian = await track(
      await seedGuardian(userId, newId(), { relationship: 'Friend', priority: 1, status })
    );

    const { status: httpStatus, body } = await patchGuardian(
      String(guardian._id),
      sign(userId),
      { relationship: 'Close Friend' }
    );

    assert.equal(httpStatus, 200, status);
    assert.equal(body.data.guardian.status, status, 'response status preserved');

    const doc = await Guardian.findById(guardian._id).lean();
    assert.equal(doc.status, status, 'db status preserved');
  }
});

dbTest('userId and guardianUserId cannot be changed', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1 })
  );
  const before = await Guardian.findById(guardian._id).lean();

  await patchGuardian(String(guardian._id), sign(userId), {
    userId: newId(),
    guardianUserId: newId(),
  });

  const after = await Guardian.findById(guardian._id).lean();
  assert.equal(String(after.userId), String(before.userId));
  assert.equal(String(after.guardianUserId), String(before.guardianUserId));
});

dbTest('createdAt cannot be changed', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1 })
  );
  const before = await Guardian.findById(guardian._id).lean();

  const rejected = await patchGuardian(String(guardian._id), sign(userId), {
    priority: 5,
    createdAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
  });

  assert.equal(rejected.status, 400, 'the protected field rejects the whole payload');

  const after = await Guardian.findById(guardian._id).lean();
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
  assert.equal(after.priority, 1, 'no editable field is applied either');
});

dbTest('returns not found for a non-existent guardian', async () => {
  const userId = newId();

  const { status, body } = await patchGuardian(
    new mongoose.Types.ObjectId().toString(),
    sign(userId),
    { priority: 2 }
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');
});

dbTest('another user cannot update the relationship', async () => {
  const owner = newId();
  const stranger = newId();
  const guardian = await track(
    await seedGuardian(owner, newId(), { relationship: 'Father', priority: 1 })
  );

  const { status, body } = await patchGuardian(
    String(guardian._id),
    sign(stranger),
    { relationship: 'Hacked', priority: 9 }
  );

  assert.equal(status, 404, 'foreign id looks identical to a missing id');
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');
  assert.equal(body.data, undefined);

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.relationship, 'Father');
  assert.equal(doc.priority, 1);
});

dbTest('does not modify SOS or unrelated records', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1 })
  );
  const otherGuardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Mother', priority: 2 })
  );

  const sosBefore = await SosEvent.countDocuments({ userId });
  const otherBefore = await Guardian.findById(otherGuardian._id).lean();

  const { status } = await patchGuardian(
    String(guardian._id),
    sign(userId),
    { relationship: 'Uncle', priority: 4 }
  );
  assert.equal(status, 200);

  const sosAfter = await SosEvent.countDocuments({ userId });
  const otherAfter = await Guardian.findById(otherGuardian._id).lean();

  assert.equal(sosAfter, sosBefore, 'no SOS document changes');
  assert.deepEqual(otherAfter, otherBefore, 'other guardian documents untouched');
});

dbTest('guardian PATCH database failure is handled by the central error middleware', async () => {
  const userId = newId();
  const guardian = await track(await seedGuardian(userId, newId()));

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await patchGuardian(
      String(guardian._id),
      sign(userId),
      { priority: 2 }
    );

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------- DELETE /api/v1/guardians/:id ----------

const del = async (path, token) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'DELETE',
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json() };
};

const deleteGuardian = (id, token) => del('/api/v1/guardians/' + id, token);

test('rejects an unauthenticated delete request', async () => {
  const { status, body } = await deleteGuardian(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid guardian id with 400', async () => {
  const token = sign(newId());
  const { status, body } = await deleteGuardian('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('owner removes their guardian (soft delete to BLOCKED)', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), {
      relationship: 'Father',
      priority: 1,
      status: 'ACTIVE',
    })
  );

  const { status, body } = await deleteGuardian(String(guardian._id), sign(userId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.guardian.status, 'BLOCKED');
  assert.equal(body.data.guardian.id, String(guardian._id));

  const doc = await Guardian.findById(guardian._id).lean();
  assert.ok(doc, 'document is preserved, not physically deleted');
  assert.equal(doc.status, 'BLOCKED');
  assert.equal(doc.relationship, 'Father');
  assert.equal(doc.priority, 1);
  assert.equal(String(doc.guardianUserId), String(guardian.guardianUserId));
  assert.equal(String(doc.userId), userId);
  assert.equal(doc.createdAt.getTime(), guardian.createdAt.getTime());
});

dbTest('returns not found for a non-existent guardian', async () => {
  const userId = newId();

  const { status, body } = await deleteGuardian(
    new mongoose.Types.ObjectId().toString(),
    sign(userId)
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');
});

dbTest('another user cannot remove the relationship', async () => {
  const owner = newId();
  const stranger = newId();
  const guardian = await track(
    await seedGuardian(owner, newId(), { relationship: 'Father', priority: 1, status: 'ACTIVE' })
  );

  const { status, body } = await deleteGuardian(String(guardian._id), sign(stranger));

  assert.equal(status, 404, 'foreign id looks identical to a missing id');
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');
  assert.equal(body.data, undefined);

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, 'ACTIVE', 'relationship is untouched');
});

dbTest('deleting an already inactive relationship is safe and idempotent', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Friend', priority: 2, status: 'BLOCKED' })
  );

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { status, body } = await deleteGuardian(String(guardian._id), sign(userId));

    assert.equal(status, 200, 'controlled success, not an error');
    assert.equal(body.success, true);
    assert.equal(body.data.guardian.status, 'BLOCKED');
  }

  const count = await Guardian.countDocuments({ _id: guardian._id });
  assert.equal(count, 1, 'still exactly one document');
});

dbTest('only the status field changes on delete', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Mother', priority: 3, status: 'ACTIVE' })
  );
  const before = await Guardian.findById(guardian._id).lean();

  const { status } = await deleteGuardian(String(guardian._id), sign(userId));
  assert.equal(status, 200);

  const after = await Guardian.findById(guardian._id).lean();
  assert.equal(after.status, 'BLOCKED');
  assert.equal(after.relationship, before.relationship);
  assert.equal(after.priority, before.priority);
  assert.equal(String(after.userId), String(before.userId));
  assert.equal(String(after.guardianUserId), String(before.guardianUserId));
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
  assert.ok(new Date(after.updatedAt).getTime() >= new Date(before.updatedAt).getTime());
});

dbTest('does not modify user accounts, other guardians, or SOS records', async () => {
  const userId = newId();
  const guardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Father', priority: 1, status: 'ACTIVE' })
  );
  const otherGuardian = await track(
    await seedGuardian(userId, newId(), { relationship: 'Mother', priority: 2, status: 'PENDING' })
  );

  const targetUserBefore = await users().findOne({ _id: new mongoose.Types.ObjectId(String(guardian.guardianUserId)) });
  const otherBefore = await Guardian.findById(otherGuardian._id).lean();
  const sosBefore = await SosEvent.countDocuments({ userId });

  const { status } = await deleteGuardian(String(guardian._id), sign(userId));
  assert.equal(status, 200);

  const targetUserAfter = await users().findOne({ _id: new mongoose.Types.ObjectId(String(guardian.guardianUserId)) });
  const otherAfter = await Guardian.findById(otherGuardian._id).lean();

  assert.deepEqual(targetUserAfter, targetUserBefore, 'guardian user account untouched');
  assert.deepEqual(otherAfter, otherBefore, 'other guardian documents untouched');
  assert.equal(await SosEvent.countDocuments({ userId }), sosBefore, 'no SOS changes');
});

dbTest('guardian DELETE database failure is handled by the central error middleware', async () => {
  const userId = newId();
  const guardian = await track(await seedGuardian(userId, newId()));

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await deleteGuardian(String(guardian._id), sign(userId));

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------- POST /api/v1/guardians/:id/accept ----------

const accept = async (id, token) => post('/api/v1/guardians/' + id + '/accept', token, {});

test('rejects an unauthenticated accept request', async () => {
  const { status, body } = await accept(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid guardian id on accept with 400', async () => {
  const token = sign(newId());
  const { status, body } = await accept('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('the invited guardian accepts a pending request', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, {
      relationship: 'Father',
      priority: 1,
      status: 'PENDING',
    })
  );

  const { status, body } = await accept(String(guardian._id), sign(guardianId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.guardian.status, 'ACTIVE');
  assert.equal(body.data.guardian.id, String(guardian._id));

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, 'ACTIVE');
});

dbTest('returns not found for a non-existent relationship', async () => {
  const userId = newId();

  const { status, body } = await accept(
    new mongoose.Types.ObjectId().toString(),
    sign(userId)
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');
});

dbTest('the protected user cannot accept their own outgoing request', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { relationship: 'Father', status: 'PENDING' })
  );

  const { status, body } = await accept(String(guardian._id), sign(ownerId));

  assert.equal(status, 404, 'owner looks identical to a stranger (no probing)');
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, 'PENDING', 'status is unchanged');
});

dbTest('a different user cannot accept the guardian request', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const strangerId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { relationship: 'Father', status: 'PENDING' })
  );

  const { status, body } = await accept(String(guardian._id), sign(strangerId));

  assert.equal(status, 404);
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, 'PENDING');
});

const assertConflictOnAccept = async (existingStatus) => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { relationship: 'Father', status: existingStatus })
  );

  const { status, body } = await accept(String(guardian._id), sign(guardianId));

  assert.equal(status, 409, existingStatus);
  assert.equal(body.error.code, 'GUARDIAN_NOT_PENDING');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, existingStatus, 'status is unchanged');
};

dbTest('an ACTIVE relationship cannot be accepted again', async () => {
  await assertConflictOnAccept('ACTIVE');
});

dbTest('a REJECTED relationship cannot be accepted', async () => {
  await assertConflictOnAccept('REJECTED');
});

dbTest('a BLOCKED relationship cannot be accepted', async () => {
  await assertConflictOnAccept('BLOCKED');
});

dbTest('acceptance changes only status and updatedAt', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, {
      relationship: 'Mother',
      priority: 3,
      status: 'PENDING',
    })
  );
  const before = await Guardian.findById(guardian._id).lean();

  const { status, body } = await accept(String(guardian._id), sign(guardianId));
  assert.equal(status, 200);

  const after = await Guardian.findById(guardian._id).lean();

  assert.equal(after.status, 'ACTIVE');
  assert.equal(body.data.guardian.status, 'ACTIVE');

  assert.equal(String(after.userId), String(before.userId), 'userId unchanged');
  assert.equal(String(after.guardianUserId), String(before.guardianUserId), 'guardianUserId unchanged');
  assert.equal(after.relationship, before.relationship);
  assert.equal(after.priority, before.priority);
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
  assert.ok(
    new Date(after.updatedAt).getTime() > new Date(before.updatedAt).getTime(),
    'updatedAt advances'
  );

  const keysChanged = ['status', 'updatedAt'].filter(
    (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])
  );
  assert.deepEqual(keysChanged.sort(), ['status', 'updatedAt']);
});

dbTest('concurrent acceptance attempts cannot both succeed', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { relationship: 'Father', status: 'PENDING' })
  );
  const token = sign(guardianId);

  const [first, second] = await Promise.all([
    accept(String(guardian._id), token),
    accept(String(guardian._id), token),
  ]);

  assert.deepEqual([first.status, second.status].sort(), [200, 409]);

  const loser = first.status === 409 ? first : second;
  assert.equal(loser.body.error.code, 'GUARDIAN_NOT_PENDING');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, 'ACTIVE', 'transitioned exactly once');
});

dbTest('accept database failure is handled by the central error middleware', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { status: 'PENDING' })
  );

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await accept(String(guardian._id), sign(guardianId));

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});

// ---------- POST /api/v1/guardians/:id/reject ----------

const reject = async (id, token) => post('/api/v1/guardians/' + id + '/reject', token, {});

test('rejects an unauthenticated reject request', async () => {
  const { status, body } = await reject(new mongoose.Types.ObjectId().toString(), null);

  assert.equal(status, 401);
  assert.equal(body.error.code, 'UNAUTHENTICATED');
});

test('rejects an invalid guardian id on reject with 400', async () => {
  const token = sign(newId());
  const { status, body } = await reject('not-an-id', token);

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.equal(body.error.details[0].path, 'params.id');
});

dbTest('the invited guardian rejects a pending request', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, {
      relationship: 'Father',
      priority: 1,
      status: 'PENDING',
    })
  );

  const { status, body } = await reject(String(guardian._id), sign(guardianId));

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.guardian.status, 'REJECTED');
  assert.equal(body.data.guardian.id, String(guardian._id));

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, 'REJECTED');
});

dbTest('returns not found for a non-existent relationship on reject', async () => {
  const userId = newId();

  const { status, body } = await reject(
    new mongoose.Types.ObjectId().toString(),
    sign(userId)
  );

  assert.equal(status, 404);
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');
});

dbTest('the protected user cannot reject their own outgoing request', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { relationship: 'Father', status: 'PENDING' })
  );

  const { status, body } = await reject(String(guardian._id), sign(ownerId));

  assert.equal(status, 404, 'owner looks identical to a stranger (no probing)');
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, 'PENDING', 'status is unchanged');
});

dbTest('a different user cannot reject the guardian request', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const strangerId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { relationship: 'Father', status: 'PENDING' })
  );

  const { status, body } = await reject(String(guardian._id), sign(strangerId));

  assert.equal(status, 404);
  assert.equal(body.error.code, 'GUARDIAN_NOT_FOUND');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, 'PENDING');
});

const assertConflictOnReject = async (existingStatus) => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { relationship: 'Father', status: existingStatus })
  );

  const { status, body } = await reject(String(guardian._id), sign(guardianId));

  assert.equal(status, 409, existingStatus);
  assert.equal(body.error.code, 'GUARDIAN_NOT_PENDING');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.equal(doc.status, existingStatus, 'status is unchanged');
};

dbTest('an ACTIVE relationship cannot be rejected', async () => {
  await assertConflictOnReject('ACTIVE');
});

dbTest('a REJECTED relationship cannot be rejected again', async () => {
  await assertConflictOnReject('REJECTED');
});

dbTest('a BLOCKED relationship cannot be rejected', async () => {
  await assertConflictOnReject('BLOCKED');
});

dbTest('rejection changes only status and updatedAt', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, {
      relationship: 'Mother',
      priority: 3,
      status: 'PENDING',
    })
  );
  const before = await Guardian.findById(guardian._id).lean();

  const { status, body } = await reject(String(guardian._id), sign(guardianId));
  assert.equal(status, 200);

  const after = await Guardian.findById(guardian._id).lean();

  assert.equal(after.status, 'REJECTED');
  assert.equal(body.data.guardian.status, 'REJECTED');

  assert.equal(String(after.userId), String(before.userId), 'userId unchanged');
  assert.equal(String(after.guardianUserId), String(before.guardianUserId), 'guardianUserId unchanged');
  assert.equal(after.relationship, before.relationship);
  assert.equal(after.priority, before.priority);
  assert.equal(after.createdAt.getTime(), before.createdAt.getTime());
  assert.ok(
    new Date(after.updatedAt).getTime() > new Date(before.updatedAt).getTime(),
    'updatedAt advances'
  );

  const keysChanged = ['status', 'updatedAt'].filter(
    (key) => JSON.stringify(after[key]) !== JSON.stringify(before[key])
  );
  assert.deepEqual(keysChanged.sort(), ['status', 'updatedAt']);
});

dbTest('concurrent accept and reject cannot both transition the same pending relationship', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { relationship: 'Father', status: 'PENDING' })
  );
  const token = sign(guardianId);

  const [acceptRes, rejectRes] = await Promise.all([
    accept(String(guardian._id), token),
    reject(String(guardian._id), token),
  ]);

  const statuses = [acceptRes.status, rejectRes.status];
  assert.deepEqual(statuses.sort(), [200, 409], 'exactly one transition wins');

  const loser = acceptRes.status === 409 ? acceptRes : rejectRes;
  assert.equal(loser.body.error.code, 'GUARDIAN_NOT_PENDING');

  const doc = await Guardian.findById(guardian._id).lean();
  assert.ok(
    doc.status === 'ACTIVE' || doc.status === 'REJECTED',
    'ends in exactly one committed terminal state'
  );

  const winner = acceptRes.status === 200 ? 'ACTIVE' : 'REJECTED';
  assert.equal(doc.status, winner, 'the winning transition is the one persisted');
});

dbTest('reject database failure is handled by the central error middleware', async () => {
  const ownerId = newId();
  const guardianId = newId();
  const guardian = await track(
    await seedGuardian(ownerId, guardianId, { status: 'PENDING' })
  );

  await mongoose.disconnect();
  mongoose.set('bufferTimeoutMS', 50);

  try {
    const { status, body } = await reject(String(guardian._id), sign(guardianId));

    assert.equal(status, 500);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INTERNAL_ERROR');
  } finally {
    mongoose.set('bufferTimeoutMS', 10000);
    await connectDB();
  }
});
