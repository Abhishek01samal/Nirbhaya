import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { env } from '../src/config/env.js';
import { setupSocketAuth, userRoom, emitToUser } from '../src/sockets/authSocket.js';
import { emitToUserRoom, getIO } from '../src/sockets/index.js';

const OWNER_ID = '64b0f0f0f0f0f0f0f0f0f0a1';
const ATTACKER_ID = '64b0f0f0f0f0f0f0f0f0f0a3';

const tokenFor = (payload, options) =>
  jwt.sign(payload, env.jwtSecret, { expiresIn: '5m', ...options });

const fakeIO = () => {
  const state = { middleware: null, connection: null };
  return {
    state,
    io: {
      use: (fn) => {
        state.middleware = fn;
      },
      on: (event, fn) => {
        if (event === 'connection') state.connection = fn;
      },
    },
  };
};

const fakeSocket = (handshake = {}) => {
  const socket = {
    handshake,
    joined: [],
    left: [],
    handlers: {},
    join(room) {
      this.joined.push(room);
    },
    leave(room) {
      this.left.push(room);
    },
    on(event, fn) {
      this.handlers[event] = fn;
    },
  };
  return socket;
};

test('the private room convention is one room per authenticated user', () => {
  assert.equal(userRoom(OWNER_ID), `user:${OWNER_ID}`);
});

test('emitToUser delivers into exactly that one room and nowhere else', () => {
  const targeted = [];
  const delivered = [];
  const io = {
    to: (room) => {
      targeted.push(room);
      return {
        emit: (event, payload) => {
          delivered.push({ event, payload });
          return true;
        },
      };
    },
  };

  const ok = emitToUser(io, OWNER_ID, 'call:outgoing', { callId: 'call-1' });

  assert.equal(ok, true);
  assert.deepEqual(targeted, [`user:${OWNER_ID}`], 'a single private room — never broadcast()');
  assert.deepEqual(delivered, [{ event: 'call:outgoing', payload: { callId: 'call-1' } }]);
});

test('emitToUser refuses to emit without a target or a server', () => {
  const io = { to: () => ({ emit: () => true }) };

  assert.equal(emitToUser(io, '', 'call:outgoing', {}), false);
  assert.equal(emitToUser(io, null, 'call:outgoing', {}), false);
  assert.equal(emitToUser(null, OWNER_ID, 'call:outgoing', {}), false);
});

test('emission is a no-op while Socket.IO is unavailable, never a failure', () => {
  assert.throws(() => getIO(), /Socket.IO has not been initialized/, 'server socket layer is not up in this process');
  assert.equal(
    emitToUserRoom(OWNER_ID, 'call:outgoing', { callId: 'call-1' }),
    false,
    'HTTP requests survive a down or not-yet-started socket layer'
  );
  assert.equal(emitToUserRoom(null, 'call:outgoing', {}), false);
});

test('socket auth derives identity from the JWT, never from client params', () => {
  const { io, state } = fakeIO();
  setupSocketAuth(io);

  const socket = fakeSocket({
    auth: { token: tokenFor({ sub: OWNER_ID, role: 'USER' }) },
    // A client trying to claim somebody else's room.
    query: { userId: ATTACKER_ID, room: userRoom(ATTACKER_ID) },
  });

  let authError = 'not-called';
  state.middleware(socket, (err) => {
    authError = err;
  });

  assert.equal(authError, undefined, 'the valid token authenticates the socket');
  assert.equal(socket.userId, OWNER_ID, 'the claim comes from the token, not the query');
  assert.equal(socket.userRole, 'USER');

  state.connection(socket);

  assert.deepEqual(socket.joined, [userRoom(OWNER_ID)], 'one server-derived room');
  assert.equal(socket.joined.includes(userRoom(ATTACKER_ID)), false, 'the attacker room is never joined');
  assert.equal(socket.joined.length, 1, 'a socket is never in two users private rooms at once');
});

test('socket auth rejects unauthenticated or forged connections', () => {
  const { io, state } = fakeIO();
  setupSocketAuth(io);

  const attempt = (handshake) => {
    const socket = fakeSocket(handshake);
    let result = 'not-called';
    state.middleware(socket, (err) => {
      result = err;
    });
    return { socket, error: result };
  };

  const missing = attempt({});
  assert.equal(missing.error.message, 'UNAUTHENTICATED: missing token');

  const forged = attempt({ auth: { token: jwt.sign({ sub: ATTACKER_ID }, 'wrong-secret') } });
  assert.equal(forged.error.message, 'INVALID_TOKEN: invalid or expired token');

  const anonymous = attempt({ auth: { token: tokenFor({}) } });
  assert.equal(anonymous.error.message, 'INVALID_TOKEN: missing subject');

  for (const rejected of [missing, forged, anonymous]) {
    assert.equal(rejected.socket.userId, undefined, 'a rejected handshake never gains an identity');
    assert.equal(rejected.socket.userRole, undefined);
    assert.deepEqual(rejected.socket.joined, [], 'no room is joined without a verified identity');
  }
});
