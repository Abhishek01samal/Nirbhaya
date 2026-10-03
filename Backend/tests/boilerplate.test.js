import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import express from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';

import app from '../src/app.js';
import { env } from '../src/config/env.js';
import { validateBody } from '../src/middleware/validate.js';
import { requireAuth } from '../src/middleware/auth.js';
import { notFoundHandler, errorHandler } from '../src/middleware/errorHandler.js';

const listen = (server) =>
  new Promise((resolve) => server.listen(0, () => resolve(server.address().port)));

const request = async (port, path, options = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

test('health endpoint returns success envelope', async () => {
  const server = http.createServer(app);
  const port = await listen(server);

  const { status, body } = await request(port, '/health');

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.status === 'ok');

  server.close();
});

test('unknown route returns 404 error envelope', async () => {
  const server = http.createServer(app);
  const port = await listen(server);

  const { status, body } = await request(port, '/api/v1/nope');

  assert.equal(status, 404);
  assert.equal(body.success, false);
  assert.equal(body.error.code, 'NOT_FOUND');

  server.close();
});

test('validation middleware rejects invalid body with 400', async () => {
  const mini = express();
  mini.use(express.json());
  mini.post('/x', validateBody(z.object({ name: z.string().min(1) })), (req, res) => res.json({ ok: true }));
  mini.use(notFoundHandler);
  mini.use(errorHandler);

  const server = http.createServer(mini);
  const port = await listen(server);

  const { status, body } = await request(port, '/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: '' }),
  });

  assert.equal(status, 400);
  assert.equal(body.error.code, 'VALIDATION_ERROR');
  assert.ok(Array.isArray(body.error.details));

  server.close();
});

test('requireAuth rejects missing token and accepts a valid JWT', async () => {
  const mini = express();
  mini.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));
  mini.use(notFoundHandler);
  mini.use(errorHandler);

  const server = http.createServer(mini);
  const port = await listen(server);

  const denied = await request(port, '/me');
  assert.equal(denied.status, 401);
  assert.equal(denied.body.error.code, 'UNAUTHENTICATED');

  const token = jwt.sign({ sub: 'user-123', role: 'USER' }, env.jwtSecret, { expiresIn: '5m' });
  const allowed = await request(port, '/me', { headers: { authorization: `Bearer ${token}` } });

  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body.user, { id: 'user-123', role: 'USER' });

  server.close();
});
