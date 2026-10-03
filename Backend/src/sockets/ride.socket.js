import { onSafetyEvent } from "../utils/safetyEventBus.js";
import logger from "../utils/logger.js";

const TYPE_TO_EVENT = {
  OFF_ROUTE: "ride:offRoute",
  LONG_STOP: "ride:longStop",
  GEOFENCE_BREACH: "ride:geofenceBreach",
  ARRIVED: "ride:arrived",
};

/**
 * Bridge: monitoring detection events → Socket.IO clients.
 *
 * Registered ONCE per server (from initializeSocket). Every safety event is
 * also available server-side via safetyEventBus for Person 1's SOS module -
 * this bridge only fans out to connected clients.
 */
export function attachSafetyEventBridge(io) {
  onSafetyEvent((event) => {
    try {
      const payload = {
        type: event.type,
        userId: event.userId,
        safetySessionId: event.safetySessionId,
        rideId: event.rideId,
        location: event.location,
        metadata: event.metadata,
        timestamp: event.timestamp,
      };

      const eventName = TYPE_TO_EVENT[event.type] ?? "ride:event";

      if (event.rideId) io.to(`ride:${event.rideId}`).emit(eventName, payload);
      if (event.userId) io.to(`user:${event.userId}`).emit(eventName, payload);
      if (event.userId) io.to(`user:${event.userId}`).emit("safety:event", payload);
      if (event.safetySessionId) io.to(`session:${event.safetySessionId}`).emit(eventName, payload);
    } catch (err) {
      logger.warn("socket:ride", `safety bridge failed: ${err.message}`);
    }
  });

  logger.info("socket:ride", "safety event bridge attached");
}

/**
 * Per-connection ride handlers.
 *
 * client → server:
 *   ride:subscribe   { rideId }   join the ride's room
 *   ride:unsubscribe { rideId }   leave the ride's room
 *
 * server → client: ride:started / ride:updated (from HTTP flows),
 *                  ride:offRoute / ride:longStop (from the bridge above).
 */
export function registerRideSocket(io, socket) {
  socket.on("ride:subscribe", (payload = {}, ack) => {
    try {
      if (!payload.rideId) {
        ack?.({ ok: false, error: "rideId required" });
        return;
      }
      socket.join(`ride:${payload.rideId}`);
      ack?.({ ok: true, room: `ride:${payload.rideId}` });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });

  socket.on("ride:unsubscribe", (payload = {}, ack) => {
    if (payload.rideId) socket.leave(`ride:${payload.rideId}`);
    ack?.({ ok: true });
  });
}

export default registerRideSocket;
