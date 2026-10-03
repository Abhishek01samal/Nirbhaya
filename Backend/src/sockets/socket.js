import { Server } from "socket.io";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import logger from "../utils/logger.js";
import registerLocationSocket from "./location.socket.js";
import { registerRideSocket, attachSafetyEventBridge } from "./ride.socket.js";

let io = null;

/**
 * Attach Socket.IO to the HTTP server.
 * Auth: Authorization via handshake `auth: { token }` (JWT, Person 3),
 * or `auth: { userId }` in development only.
 */
export function initializeSocket(server) {
  io = new Server(server, {
    cors: {
      origin: env.corsOrigin === "*" ? true : env.corsOrigin.split(",").map((s) => s.trim()),
      methods: ["GET", "POST"],
    },
    maxHttpBufferSize: 1e6, // 1 MB - location pings are small
  });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (token) {
        const decoded = jwt.verify(token, env.jwtSecret);
        const id = decoded.sub ?? decoded.userId ?? decoded.id;
        if (!id) return next(new Error("Token missing user id"));
        socket.data.user = { ...decoded, id, userId: String(id) };
        return next();
      }

      const devUserId = socket.handshake.auth?.userId ?? socket.handshake.query?.userId;
      if (devUserId && !env.isProduction) {
        socket.data.user = { id: String(devUserId), userId: String(devUserId), dev: true };
        return next();
      }
      return next(new Error("Authentication required"));
    } catch {
      return next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.data.user.userId;
    socket.join(`user:${userId}`);
    logger.info("socket", `connected ${socket.id} user=${userId}`);

    registerLocationSocket(io, socket);
    registerRideSocket(io, socket);

    socket.on("disconnect", (reason) => {
      logger.debug("socket", `disconnected ${socket.id} (${reason})`);
    });
  });

  attachSafetyEventBridge(io);

  logger.info("socket", "initialized");
  return io;
}

export function getIO() {
  if (!io) throw new Error("Socket.IO not initialized - call initializeSocket(server) first");
  return io;
}

/** Bind the shared io instance owned by sockets/index.js so Person 2 emit helpers work. */
export function setSharedIO(instance) {
  io = instance;
}

/** Register Person 2 per-connection handlers + safety-event bridge on an existing io. */
export function attachRealtimeHandlers(ioInstance) {
  ioInstance.on("connection", (socket) => {
    registerLocationSocket(ioInstance, socket);
    registerRideSocket(ioInstance, socket);
  });
  attachSafetyEventBridge(ioInstance);
}

export function tryGetIO() {
  return io;
}

/** Broadcast helpers - safe no-ops when the socket layer is not running. */
export function emitToUser(userId, event, payload) {
  if (io && userId) io.to(`user:${userId}`).emit(event, payload);
}

export function emitToRide(rideId, event, payload) {
  if (io && rideId) io.to(`ride:${rideId}`).emit(event, payload);
}

export function emitToSession(sessionId, event, payload) {
  if (io && sessionId) io.to(`session:${sessionId}`).emit(event, payload);
}

export function emitToRoom(room, event, payload) {
  if (io) io.to(room).emit(event, payload);
}

export default initializeSocket;
