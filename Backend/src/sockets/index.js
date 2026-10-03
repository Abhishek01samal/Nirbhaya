import { Server } from 'socket.io';
import { env } from '../config/env.js';
import { setupSocketAuth, emitToUser, userRoom } from './authSocket.js';
import { setSharedIO, attachRealtimeHandlers } from './socket.js';

let io = null;

export function initSockets(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: env.socketCorsOrigin === '*' ? '*' : env.socketCorsOrigin.split(',').map((o) => o.trim()),
      credentials: true,
    },
  });

  setupSocketAuth(io);
  setSharedIO(io);
  attachRealtimeHandlers(io);

  console.log('[socket] initialized');
  return io;
}

export function getIO() {
  if (!io) {
    throw new Error('Socket.IO has not been initialized yet');
  }
  return io;
}

/**
 * Person 1 real-time emission helper.
 * Emits to the authenticated `user:<id>` room only.
 *
 * Known SOS events:
 *   sos:verification-required | sos:confirmed | sos:cancelled | sos:timeout
 *   sos:activated | sos:guardian-notified | sos:guardian-acknowledged
 *   sos:escalating | sos:resolved                             (lifecycle)
 *   sos:guardian:notify                                    (escalation start)
 *   sos:responder:notify                                   (responder escalation start)
 *   sos:police:escalated                                   (police escalation start)
 *   sos:guardian:acknowledged | sos:responder:acknowledged (escalation ack)
 *   responder:sos-notification                              (responder channel)
 *   responder:sos-acknowledged | responder:sos-expired      (responder channel)
 * Call events:
 *   call:outgoing | call:ringing   (emitted when a call is started)
 *   call:accepted | call:rejected | call:ended
 * Event names, payloads and best-effort delivery:
 *   modules/calling/call.events.js | modules/sos/sos.events.js
 */
export function emitToUserRoom(userId, event, payload) {
  // Never throws when sockets are not initialized (e.g. HTTP-only tests):
  // notifications are best effort and must not fail an otherwise valid request.
  if (!io || !userId) return false;
  return emitToUser(io, userId, event, payload);
}

/**
 * Presence probe: is `userId`'s browser currently connected?
 *
 * The only presence signal this backend has is Socket.IO room membership —
 * there is no presence system. When sockets are not initialized at all
 * (HTTP-only process/tests) there is no signal either, so it answers `true`:
 * "unknown is not offline". Consumers use this to pick a reachable
 * notification target; the actual notification stays best effort.
 */
export function isUserOnline(userId) {
  if (!userId) return false;
  if (!io) return true;
  return io.sockets.adapter.rooms.has(userRoom(userId));
}
