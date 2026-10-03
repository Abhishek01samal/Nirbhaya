import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import 'dotenv/config';

// Load .env first, then point the suite at the _test database. dotenv never
// overrides existing values and src/config/env.js freezes this on import
// (imported lazily inside `before`), so production data is never touched.
if (process.env.MONGODB_URI && !process.env.MONGODB_URI.includes('_test')) {
  process.env.MONGODB_URI = process.env.MONGODB_URI.replace('/women_safety', '/women_safety_test');
}

let app;
let mongoose;
let connectDB;
let disconnectDB;
let User;

const state = {
  server: null,
  port: null,
  cleanupEmails: [],
  registered: null, // { user, token } of the main test account
};

const req = async (path, { method = 'GET', token, body } = {}) => {
  const res = await fetch(`http://127.0.0.1:${state.port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  return { status: res.status, body: parsed };
};

before(async () => {
  ({ default: app } = await import('../src/app.js'));
  mongoose = (await import('mongoose')).default;
  ({ connectDB, disconnectDB } = await import('../src/config/db.js'));
  ({ User } = await import('../src/modules/users/user.model.js'));

  await connectDB();

  state.server = http.createServer(app);
  state.port = await new Promise((resolve) => {
    state.server.listen(0, () => resolve(state.server.address().port));
  });
});

after(async () => {
  if (state.cleanupEmails.length) {
    await User.deleteMany({ email: { $in: state.cleanupEmails } });
  }
  if (mongoose.connection.readyState !== 0) await disconnectDB();
  if (state.server) await new Promise((resolve) => state.server.close(resolve));
});

const uniqueEmail = (label) => {
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  state.cleanupEmails.push(email);
  return email;
};

const registerAccount = async (overrides = {}) => {
  const payload = {
    name: 'John Doe',
    email: uniqueEmail('register'),
    password: 'password123',
    role: 'USER',
    ...overrides,
  };
  const res = await req('/api/v1/auth/register', { method: 'POST', body: payload });
  return { payload, res };
};

test('1. register creates a user and returns user + token', async () => {
  const { res } = await registerAccount();

  assert.equal(res.status, 201);
  assert.equal(res.body.success, true);
  assert.ok(res.body.data.token, 'token is returned');
  assert.equal(typeof res.body.data.user.id, 'string');
  assert.equal(res.body.data.user.name, 'John Doe');
  assert.equal(res.body.data.user.role, 'USER');
  assert.equal(res.body.data.user.password, undefined);
  assert.ok(!JSON.stringify(res.body).includes('password123'), 'password never echoed');
});

test('2. register with a duplicate email fails', async () => {
  const { payload } = await registerAccount();

  const res = await req('/api/v1/auth/register', {
    method: 'POST',
    body: { ...payload, name: 'Imposter' },
  });

  assert.equal(res.status, 409);
  assert.equal(res.body.success, false);
  assert.ok(['EMAIL_EXISTS', 'DUPLICATE_KEY'].includes(res.body.error.code));
});

test('3. the stored password is a bcrypt hash, not plaintext', async () => {
  const { payload } = await registerAccount();

  const doc = await mongoose.connection
    .collection('users')
    .findOne({ email: payload.email.toLowerCase() });

  assert.ok(doc, 'document exists in MongoDB');
  assert.ok(typeof doc.password === 'string');
  assert.notEqual(doc.password, payload.password);
  assert.match(doc.password, /^\$2[aby]\$\d{2}\$/, 'stored value is a bcrypt hash');
  assert.equal(doc.password.includes(payload.password), false);
});

test('4. login with correct credentials succeeds', async () => {
  const { payload } = await registerAccount();

  const res = await req('/api/v1/auth/login', {
    method: 'POST',
    body: { email: payload.email.toUpperCase(), password: payload.password },
  });

  assert.equal(res.status, 200);
  assert.ok(res.body.data.token);
  assert.equal(res.body.data.user.email, payload.email.toLowerCase());
  assert.equal(res.body.data.user.password, undefined);
});

test('5. login with incorrect credentials fails with one generic error', async () => {
  const { payload } = await registerAccount();

  const wrongPassword = await req('/api/v1/auth/login', {
    method: 'POST',
    body: { email: payload.email, password: 'wrong-password-123' },
  });
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.error.code, 'INVALID_CREDENTIALS');

  const unknownEmail = await req('/api/v1/auth/login', {
    method: 'POST',
    body: { email: uniqueEmail('nobody'), password: payload.password },
  });
  assert.equal(unknownEmail.status, 401);
  assert.equal(unknownEmail.body.error.code, 'INVALID_CREDENTIALS');
  assert.equal(
    unknownEmail.body.error.message,
    wrongPassword.body.error.message,
    'unknown email and wrong password are indistinguishable'
  );
});

test('6. GET /auth/me works with a valid JWT', async () => {
  const { res } = await registerAccount();

  const me = await req('/api/v1/auth/me', { token: res.body.data.token });

  assert.equal(me.status, 200);
  assert.equal(me.body.success, true);
  assert.equal(me.body.data.user.email, res.body.data.user.email);
  assert.equal(me.body.data.user.password, undefined);
  assert.equal(JSON.stringify(me.body).includes('password123'), false);
});

test('7. GET /auth/me fails without a JWT', async () => {
  const res = await req('/api/v1/auth/me');

  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'UNAUTHENTICATED');
});

test('8. GET /auth/me fails with an invalid JWT', async () => {
  const garbage = await req('/api/v1/auth/me', { token: 'not.a.jwt' });
  assert.equal(garbage.status, 401);
  assert.equal(garbage.body.error.code, 'INVALID_TOKEN');

  const tampered = await req('/api/v1/auth/me', {
    token: 'eyJhbGciOiJub25lIn0.eyJ1c2VySWQiOiIxIn0.',
  });
  assert.equal(tampered.status, 401);
  assert.equal(tampered.body.error.code, 'INVALID_TOKEN');
});

test('9. user CRUD returns sanitized users (no password anywhere)', async () => {
  const { res } = await registerAccount({ name: 'Listed User' });
  const token = res.body.data.token;

  const list = await req('/api/v1/users', { token });
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.body.data.users) && list.body.data.users.length > 0);
  for (const user of list.body.data.users) {
    assert.equal(user.password, undefined);
    assert.ok(user.id && user.name && user.email && user.role);
  }

  const single = await req(`/api/v1/users/${res.body.data.user.id}`, { token });
  assert.equal(single.status, 200);
  assert.equal(single.body.data.user.email, res.body.data.user.email);
  assert.equal(single.body.data.user.password, undefined);

  const raw = JSON.stringify(list.body) + JSON.stringify(single.body);
  assert.equal(raw.includes('password123'), false);
  assert.equal(raw.includes('"password"'), false);
});

test('9b. user CRUD requires authentication', async () => {
  assert.equal((await req('/api/v1/users')).status, 401);
  assert.equal((await req('/api/v1/users', { method: 'POST', body: {} })).status, 401);
});

test('10. updating a password stores a new hash and the old password stops working', async () => {
  const { payload, res } = await registerAccount();
  const token = res.body.data.token;
  const userId = res.body.data.user.id;

  const beforeDoc = await mongoose.connection
    .collection('users')
    .findOne({ email: payload.email });
  const newPassword = 'brand-new-pass-456';

  const update = await req(`/api/v1/users/${userId}`, {
    method: 'PUT',
    token,
    body: { password: newPassword },
  });

  assert.equal(update.status, 200);
  assert.equal(update.body.data.user.password, undefined);

  const afterDoc = await mongoose.connection
    .collection('users')
    .findOne({ email: payload.email });
  assert.notEqual(afterDoc.password, newPassword);
  assert.match(afterDoc.password, /^\$2[aby]\$\d{2}\$/);
  assert.notEqual(afterDoc.password, beforeDoc.password);

  const oldLogin = await req('/api/v1/auth/login', {
    method: 'POST',
    body: { email: payload.email, password: payload.password },
  });
  assert.equal(oldLogin.status, 401);

  const newLogin = await req('/api/v1/auth/login', {
    method: 'POST',
    body: { email: payload.email, password: newPassword },
  });
  assert.equal(newLogin.status, 200);
});

test('10b. updating email normalizes + enforces uniqueness, updating name/role works', async () => {
  const { payload, res } = await registerAccount({ name: 'Before Name' });
  const token = res.body.data.token;
  const userId = res.body.data.user.id;

  const renamed = await req(`/api/v1/users/${userId}`, {
    method: 'PUT',
    token,
    body: { name: 'After Name', role: 'GUARDIAN' },
  });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.user.name, 'After Name');
  assert.equal(renamed.body.data.user.role, 'GUARDIAN');

  const duplicate = await req(`/api/v1/users/${userId}`, {
    method: 'PUT',
    token,
    body: { email: payload.email },
  });
  assert.equal(duplicate.status, 200); // same email on same user is a no-op
  assert.equal(duplicate.body.data.user.email, payload.email.toLowerCase());

  const other = await registerAccount();
  const clash = await req(`/api/v1/users/${userId}`, {
    method: 'PUT',
    token,
    body: { email: other.payload.email.toUpperCase() },
  });
  assert.equal(clash.status, 409);
});

test('11. deleting a user works and the account stops authenticating', async () => {
  const { payload, res } = await registerAccount();
  const token = res.body.data.token;
  const userId = res.body.data.user.id;

  const del = await req(`/api/v1/users/${userId}`, { method: 'DELETE', token });
  assert.equal(del.status, 200);
  assert.equal(del.body.success, true);
  assert.equal(del.body.data.deleted, true);

  const getAfter = await req(`/api/v1/users/${userId}`, { token });
  assert.equal(getAfter.status, 404);

  const loginAfter = await req('/api/v1/auth/login', {
    method: 'POST',
    body: { email: payload.email, password: payload.password },
  });
  assert.equal(loginAfter.status, 401);

  const meAfter = await req('/api/v1/auth/me', { token });
  assert.equal(meAfter.status, 404);
});

test('12. an invalid email is rejected', async () => {
  const res = await req('/api/v1/auth/register', {
    method: 'POST',
    body: { name: 'No Mail', email: 'not-an-email', password: 'password123' },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
  assert.equal(res.body.error.details[0].path, 'body.email');

  const create = await req('/api/v1/users', {
    method: 'POST',
    token: (await registerAccount()).res.body.data.token,
    body: { name: 'No Mail', email: 'also-not-an-email', password: 'password123' },
  });
  assert.equal(create.status, 400);
});

test('13. an invalid role is rejected', async () => {
  const register = await req('/api/v1/auth/register', {
    method: 'POST',
    body: { name: 'Role Player', email: uniqueEmail('role'), password: 'password123', role: 'SUPERUSER' },
  });
  assert.equal(register.status, 400);
  assert.equal(register.body.error.code, 'VALIDATION_ERROR');

  const token = (await registerAccount()).res.body.data.token;
  const create = await req('/api/v1/users', {
    method: 'POST',
    token,
    body: { name: 'Role Player', email: uniqueEmail('role2'), password: 'password123', role: 'root' },
  });
  assert.equal(create.status, 400);

  const update = await req('/api/v1/users/507f1f77bcf86cd799439011', {
    method: 'PUT',
    token,
    body: { role: 'hacker' },
  });
  assert.equal(update.status, 400);
});

test('logout returns a success envelope instructing the client to drop the token', async () => {
  const res = await req('/api/v1/auth/logout', { method: 'POST' });

  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.message, 'Logged out successfully');
});

test('short passwords are rejected on register', async () => {
  const res = await req('/api/v1/auth/register', {
    method: 'POST',
    body: { name: 'Shorty', email: uniqueEmail('short'), password: 'abc' },
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'VALIDATION_ERROR');
});
