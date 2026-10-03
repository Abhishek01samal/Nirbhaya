import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { connectDB, disconnectDB } from '../src/config/db.js';
import { Call } from '../src/modules/calling/call.model.js';
import { ringCallAtomically } from '../src/modules/calling/call.repository.js';

const hasDb = Boolean(process.env.MONGODB_URI);
const dbTest = hasDb ? test : test.skip;

const createdCallIds = [];

const seedCall = async (status) => {
  // A fresh sosId per call: the partial unique index only allows one pending
  // call per SOS, so reusing one would make the seeds collide.
  const call = await Call.create({
    sosId: new mongoose.Types.ObjectId(),
    userId: new mongoose.Types.ObjectId(),
    guardianUserId: new mongoose.Types.ObjectId(),
    roomName: 'emergency-call-' + new mongoose.Types.ObjectId().toString(),
    status,
  });

  createdCallIds.push(String(call._id));
  return call;
};

const stored = (id) => Call.findById(id).lean();

before(async () => {
  if (hasDb) await connectDB();
});

after(async () => {
  if (hasDb && mongoose.connection.readyState !== 0) {
    await Call.deleteMany({ _id: { $in: createdCallIds } });
    await disconnectDB();
  }
});

dbTest('OUTGOING → RINGING records the flip and the ringing timestamp in one write', async () => {
  const call = await seedCall('OUTGOING');
  const ringingAt = new Date('2026-09-30T05:40:01.000Z');

  const updated = await ringCallAtomically(call._id, ringingAt);

  assert.equal(updated.status, 'RINGING');
  assert.equal(new Date(updated.ringingAt).getTime(), ringingAt.getTime());
  assert.ok(
    new Date(updated.updatedAt).getTime() >= ringingAt.getTime(),
    'the document is stamped by the same write'
  );

  const persisted = await stored(call._id);
  assert.equal(persisted.status, 'RINGING', 'the flip is durable before anyone is notified');
  assert.equal(persisted.startedAt, null, 'media timestamps stay untouched');
  assert.equal(persisted.roomName, call.roomName, 'only status and timestamps change');
  assert.equal(persisted.guardianUserId.toString(), call.guardianUserId.toString());
});

dbTest('the transition cannot be applied twice', async () => {
  const call = await seedCall('OUTGOING');
  const first = await ringCallAtomically(call._id, new Date('2026-09-30T05:40:00.000Z'));
  const second = await ringCallAtomically(call._id, new Date('2026-09-30T05:41:00.000Z'));

  assert.ok(first, 'the first write wins');
  assert.equal(second, null, 'the loser gets null, never a second transition');

  const persisted = await stored(call._id);
  assert.equal(persisted.status, 'RINGING');
  assert.equal(
    new Date(persisted.ringingAt).getTime(),
    new Date('2026-09-30T05:40:00.000Z').getTime(),
    'the original ringing timestamp is never overwritten'
  );
});

dbTest('concurrent ringing attempts produce exactly one transition', async () => {
  const call = await seedCall('OUTGOING');

  const results = await Promise.all([
    ringCallAtomically(call._id, new Date()),
    ringCallAtomically(call._id, new Date()),
    ringCallAtomically(call._id, new Date()),
  ]);

  assert.equal(results.filter(Boolean).length, 1, 'only one write matches the filter');
  assert.equal((await stored(call._id)).status, 'RINGING');
});

dbTest('a call that is not OUTGOING is never dragged into RINGING', async () => {
  const statuses = [
    'CREATED',
    'RINGING',
    'ACCEPTED',
    'CONNECTED',
    'REJECTED',
    'ENDED',
    'FAILED',
    'CANCELLED',
  ];

  for (const status of statuses) {
    const call = await seedCall(status);

    const result = await ringCallAtomically(call._id, new Date());

    assert.equal(result, null, status);
    const persisted = await stored(call._id);
    assert.equal(persisted.status, status, status + ' stays put');
    assert.equal(persisted.ringingAt, null, status + ' gains no ringing timestamp');
  }
});

dbTest('an unknown call rings nothing', async () => {
  assert.equal(await ringCallAtomically(new mongoose.Types.ObjectId(), new Date()), null);
});
