import { env } from "../../config/env.js";
import { haversineMeters } from "../../utils/geo.js";
import { emitSafetyEvent } from "../../utils/safetyEventBus.js";
import { incrementSessionEvents } from "../safetySession/safetySession.service.js";
import logger from "../../utils/logger.js";

/**
 * Prolonged-stop detection.
 *
 * Anchor model: the first point of a stop becomes `stopAnchor` with
 * `stopStartedAt`. While consecutive points stay within `stopRadiusM` of the
 * anchor, elapsed time grows; past `stopSeconds` a LONG_STOP event fires once.
 * Any point further than `stopRadiusM` resets the anchor (hysteresis), so a
 * single GPS jump cannot fake movement, and jitter inside the radius cannot
 * reset the timer.
 *
 * After emitting, a cooldown of `stopSeconds` prevents the event repeating
 * every ping while the user remains stopped.
 *
 * Mutates `ride.monitoring`; caller persists the ride.
 * Returns the emitted event info (or null).
 */
export function checkLongStop(ride, point) {
  if (!ride || ride.status !== "active") return null;
  if (!ride.route || ride.route.source === "none") return null; // only monitored trips

  const mon = ride.monitoring;
  const radius = mon.stopRadiusM ?? env.STOP_RADIUS_M;
  const requiredSeconds = mon.stopSeconds ?? env.STOP_SECONDS;
  const now = new Date(point.recordedAt ?? Date.now()).getTime();

  const anchor =
    mon.stopAnchor?.lat != null ? { lat: mon.stopAnchor.lat, lng: mon.stopAnchor.lng } : null;

  if (!anchor) {
    mon.stopAnchor = { lat: point.lat, lng: point.lng };
    mon.stopStartedAt = now;
    mon.longStopEmittedAt = null;
    return null;
  }

  const distanceFromAnchor = haversineMeters(point, anchor);

  if (distanceFromAnchor > radius) {
    // Moved enough to count as travelling again - restart the stop window.
    mon.stopAnchor = { lat: point.lat, lng: point.lng };
    mon.stopStartedAt = now;
    mon.longStopEmittedAt = null;
    return null;
  }

  const startedAt = new Date(mon.stopStartedAt ?? now).getTime();
  const elapsedSeconds = Math.max(0, (now - startedAt) / 1000);

  if (elapsedSeconds < requiredSeconds) return null;

  if (
    mon.longStopEmittedAt &&
    now - new Date(mon.longStopEmittedAt).getTime() < requiredSeconds * 1000
  ) {
    return null;
  }

  mon.longStopEmittedAt = now;

  const metadata = {
    stopDurationSeconds: Math.round(elapsedSeconds),
    stopRadiusM: radius,
    requiredSeconds,
    distanceFromAnchorM: Math.round(distanceFromAnchor),
    speed: point.speed ?? null,
  };

  const event = emitSafetyEvent({
    type: "LONG_STOP",
    userId: ride.userId,
    safetySessionId: ride.safetySessionId,
    rideId: ride._id,
    location: { lat: point.lat, lng: point.lng },
    metadata,
    source: "monitoring",
  });

  mon.flags.push({
    type: "LONG_STOP",
    at: event.timestamp,
    location: { lat: point.lat, lng: point.lng },
    metadata,
  });
  if (mon.flags.length > 50) mon.flags.splice(0, mon.flags.length - 50);

  incrementSessionEvents(ride.safetySessionId);
  logger.info("stopDetector", `ride ${ride._id} LONG_STOP ${Math.round(elapsedSeconds)}s`);
  return { type: "LONG_STOP", event, metadata };
}
