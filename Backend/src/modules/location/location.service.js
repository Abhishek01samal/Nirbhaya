import { LocationPoint } from "./location.model.js";
import { updateLastLocation } from "../safetySession/safetySession.service.js";
import { evaluateRidePoint } from "../monitoring/monitoring.service.js";
import { badRequest, notFound } from "../../middleware/error.js";
import logger from "../../utils/logger.js";

/**
 * Persist a single location ping and, when it belongs to an active ride,
 * run the monitoring pipeline (route deviation + prolonged stop).
 *
 * Returns { point, monitors } so callers (HTTP + socket) can report results.
 */
export async function recordPoint({
  userId,
  safetySessionId = null,
  rideId = null,
  lat,
  lng,
  accuracy = null,
  altitude = null,
  speed = null,
  heading = null,
  recordedAt = null,
  source = "http",
}) {
  if (!userId) throw badRequest("userId is required");
  if (typeof lat !== "number" || typeof lng !== "number") {
    throw badRequest("lat and lng must be numbers");
  }

  const point = await LocationPoint.create({
    userId: String(userId),
    safetySessionId: safetySessionId || null,
    rideId: rideId || null,
    lat,
    lng,
    accuracy,
    altitude,
    speed,
    heading,
    recordedAt: recordedAt ? new Date(recordedAt) : new Date(),
    source,
  });

  if (safetySessionId) {
    await updateLastLocation(safetySessionId, point);
  }

  let monitors = null;
  if (rideId) {
    monitors = await evaluateRidePoint({ rideId, point });
  }

  return { point, monitors };
}

/** Latest known point for a user (or null). */
export async function getCurrent(userId) {
  if (!userId) throw badRequest("userId is required");
  return LocationPoint.findOne({ userId: String(userId) }).sort({ recordedAt: -1 });
}

/** History query with time window + hard limit. */
export async function getHistory({ userId, safetySessionId, rideId, from, to, limit = 500 }) {
  const filter = {};
  if (userId) filter.userId = String(userId);
  if (safetySessionId) filter.safetySessionId = safetySessionId;
  if (rideId) filter.rideId = rideId;

  filter.recordedAt = {};
  if (from) filter.recordedAt.$gte = new Date(from);
  if (to) filter.recordedAt.$lte = new Date(to);
  if (Object.keys(filter.recordedAt).length === 0) delete filter.recordedAt;

  if (!filter.userId && !filter.rideId && !filter.safetySessionId) {
    throw badRequest("Provide userId, rideId or safetySessionId");
  }

  return LocationPoint.find(filter)
    .sort({ recordedAt: 1 })
    .limit(Math.min(Number(limit) || 500, 5000))
    .select("-__v");
}

/** Most recent N points for a ride (used by stop detection + trail replay). */
export async function getRecentForRide(rideId, limit = 30) {
  return LocationPoint.find({ rideId })
    .sort({ recordedAt: -1 })
    .limit(limit)
    .select("lat lng speed accuracy recordedAt");
}

/** Current trail of a ride (chronological). */
export async function getRideTrail(rideId, limit = 2000) {
  return LocationPoint.find({ rideId })
    .sort({ recordedAt: 1 })
    .limit(limit)
    .select("lat lng speed accuracy recordedAt");
}

/** Resolve the latest point, 404 when nothing exists yet. */
export async function requireCurrent(userId) {
  const point = await getCurrent(userId);
  if (!point) throw notFound("No location recorded for this user");
  return point;
}
