import { env } from "../../config/env.js";
import { distanceToPolylineMeters } from "../../utils/geo.js";
import { emitSafetyEvent } from "../../utils/safetyEventBus.js";
import { incrementSessionEvents } from "../safetySession/safetySession.service.js";
import logger from "../../utils/logger.js";

/**
 * Route deviation detection.
 *
 * Every active-ride location point is projected onto the planned polyline.
 * A point further than `offRouteThresholdM` metres counts as a deviation;
 * it must happen on `OFF_ROUTE_DEBOUNCE_POINTS` consecutive points before an
 * OFF_ROUTE event is emitted (debounce against GPS jitter), and an
 * OFF_ROUTE_COOLDOWN_S window stops the event repeating every ping.
 *
 * Mutates `ride.monitoring`; caller persists the ride.
 * Returns the emitted event info (or null).
 */
export function checkOffRoute(ride, point) {
  if (!ride || ride.status !== "active") return null;
  const polyline = ride.route?.polyline;
  if (!Array.isArray(polyline) || polyline.length < 2) return null;

  const mon = ride.monitoring;
  const threshold = mon.offRouteThresholdM ?? env.OFF_ROUTE_THRESHOLD_M;
  const debounce = env.OFF_ROUTE_DEBOUNCE_POINTS;
  const cooldownMs = env.OFF_ROUTE_COOLDOWN_S * 1000;

  const distanceM = distanceToPolylineMeters(point, polyline);
  mon.lastRouteDistanceM = Math.round(distanceM);

  if (distanceM <= threshold) {
    mon.offRouteCounter = 0;
    return null;
  }

  mon.offRouteCounter = (mon.offRouteCounter ?? 0) + 1;
  if (mon.offRouteCounter < debounce) {
    logger.debug(
      "routeMonitor",
      `ride ${ride._id} off-route ${Math.round(distanceM)}m (${mon.offRouteCounter}/${debounce})`
    );
    return null;
  }

  if (mon.lastOffRouteAt && Date.now() - new Date(mon.lastOffRouteAt).getTime() < cooldownMs) {
    return null;
  }

  mon.lastOffRouteAt = new Date();
  mon.offRouteCounter = 0;

  const metadata = {
    distanceFromRoute: Math.round(distanceM),
    thresholdM: threshold,
    speed: point.speed ?? null,
    accuracy: point.accuracy ?? null,
  };

  const event = emitSafetyEvent({
    type: "OFF_ROUTE",
    userId: ride.userId,
    safetySessionId: ride.safetySessionId,
    rideId: ride._id,
    location: { lat: point.lat, lng: point.lng },
    metadata,
    source: "monitoring",
  });

  mon.flags.push({
    type: "OFF_ROUTE",
    at: event.timestamp,
    location: { lat: point.lat, lng: point.lng },
    metadata,
  });
  if (mon.flags.length > 50) mon.flags.splice(0, mon.flags.length - 50);

  incrementSessionEvents(ride.safetySessionId);
  return { type: "OFF_ROUTE", event, metadata };
}
