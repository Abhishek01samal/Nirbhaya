import * as locationService from "../modules/location/location.service.js";
import logger from "../utils/logger.js";

/**
 * Real-time location channel.
 *
 * client → server:
 *   location:subscribe { safetySessionId?, rideId? }   join broadcast rooms
 *   location:update   { lat, lng, accuracy?, speed?, heading?, recordedAt?,
 *                       safetySessionId?, rideId? }    save ping + run monitoring
 *   location:current  { userId? }                      latest known point
 *
 * server → client:
 *   location:update   (to the user's other devices / guardians in the room)
 */
export default function registerLocationSocket(io, socket) {
  const userId = socket.data.user.userId;

  socket.on("location:subscribe", (payload = {}, ack) => {
    const joined = [];
    try {
      if (payload.safetySessionId) {
        socket.join(`session:${payload.safetySessionId}`);
        joined.push(`session:${payload.safetySessionId}`);
      }
      if (payload.rideId) {
        socket.join(`ride:${payload.rideId}`);
        joined.push(`ride:${payload.rideId}`);
      }
      ack?.({ ok: true, joined });
    } catch (err) {
      logger.warn("socket:location", `subscribe failed: ${err.message}`);
      ack?.({ ok: false, error: err.message });
    }
  });

  socket.on("location:update", async (payload = {}, ack) => {
    try {
      if (typeof payload.lat !== "number" || typeof payload.lng !== "number") {
        ack?.({ ok: false, error: "lat and lng are required numbers" });
        return;
      }

      const { point, monitors } = await locationService.recordPoint({
        lat: payload.lat,
        lng: payload.lng,
        accuracy: payload.accuracy,
        altitude: payload.altitude,
        speed: payload.speed,
        heading: payload.heading,
        recordedAt: payload.recordedAt,
        safetySessionId: payload.safetySessionId,
        rideId: payload.rideId,
        userId,
        source: "socket",
      });

      const broadcast = {
        userId,
        id: point._id,
        lat: point.lat,
        lng: point.lng,
        accuracy: point.accuracy,
        speed: point.speed,
        heading: point.heading,
        recordedAt: point.recordedAt,
        rideId: point.rideId,
        safetySessionId: point.safetySessionId,
      };

      socket.to(`user:${userId}`).emit("location:update", broadcast);
      if (point.safetySessionId) {
        socket.to(`session:${point.safetySessionId}`).emit("location:update", broadcast);
      }

      ack?.({ ok: true, id: point._id, recordedAt: point.recordedAt, monitors });
    } catch (err) {
      logger.warn("socket:location", `update failed: ${err.message}`);
      ack?.({ ok: false, error: err.message });
    }
  });

  socket.on("location:current", async (payload = {}, ack) => {
    try {
      const targetUserId = payload.userId ?? userId;
      const point = await locationService.getCurrent(targetUserId);
      ack?.({ ok: true, data: point });
    } catch (err) {
      ack?.({ ok: false, error: err.message });
    }
  });
}
