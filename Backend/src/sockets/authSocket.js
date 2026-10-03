import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

/**
 * Socket.IO authentication.
 * Identity is ALWAYS derived from the verified JWT, never from client query params.
 */
export function setupSocketAuth(io) {
  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;

      if (!token) {
        return next(new Error('UNAUTHENTICATED: missing token'));
      }

      const payload = jwt.verify(token, env.jwtSecret);
      const userId = payload.sub || payload.id;

      if (!userId) {
        return next(new Error('INVALID_TOKEN: missing subject'));
      }

      socket.userId = String(userId);
      socket.userRole = payload.role || 'USER';
      socket.data.user = { id: String(userId), userId: String(userId), role: socket.userRole };
      return next();
    } catch (err) {
      return next(new Error('INVALID_TOKEN: invalid or expired token'));
    }
  });

  io.on('connection', (socket) => {
    // Server-derived room name — never trust a client-provided userId.
    socket.join(userRoom(socket.userId));

    socket.on('disconnect', () => {
      socket.leave(userRoom(socket.userId));
    });
  });
}

export const userRoom = (userId) => `user:${userId}`;

export function emitToUser(io, userId, event, payload) {
  if (!io || !userId) return false;
  return io.to(userRoom(userId)).emit(event, payload);
}
