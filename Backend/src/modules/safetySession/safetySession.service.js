import { SafetySession } from "./safetySession.model.js";
import { AppError, notFound, conflict, badRequest } from "../../middleware/error.js";
import logger from "../../utils/logger.js";

/**
 * Start a new safety session for a user. Any session still active is ended
 * first so there is never more than one active session per user.
 */
export async function startSession({ userId, mode, origin, destination, metadata, note }) {
  if (!userId) throw badRequest("userId is required");

  const previous = await SafetySession.findOne({ userId, status: "active" });
  if (previous) {
    previous.status = "ended";
    previous.endedAt = new Date();
    await previous.save();
    logger.info("safetySession", `closed session ${previous._id} for user ${userId}`);
  }

  const session = await SafetySession.create({
    userId: String(userId),
    mode: mode ?? "static",
    origin: origin ?? undefined,
    destination: destination ?? undefined,
    metadata: metadata ?? {},
    note: note ?? "",
    startedAt: new Date(),
  });

  logger.info("safetySession", `started ${session._id} mode=${session.mode} user=${userId}`);
  return session;
}

export async function getActiveSession(userId) {
  if (!userId) throw badRequest("userId is required");
  return SafetySession.findOne({ userId: String(userId), status: "active" }).sort({
    startedAt: -1,
  });
}

export async function getSessionById(sessionId) {
  const session = await SafetySession.findById(sessionId);
  if (!session) throw notFound("Safety session not found");
  return session;
}

export async function listSessions(userId, { limit = 20, status } = {}) {
  const filter = { userId: String(userId) };
  if (status) filter.status = status;
  return SafetySession.find(filter).sort({ startedAt: -1 }).limit(Math.min(limit, 100));
}

/** End a session. Idempotent: ending an already-ended session succeeds. */
export async function endSession(sessionId, { status = "ended", reason } = {}) {
  if (!["ended", "cancelled"].includes(status)) {
    throw badRequest('status must be "ended" or "cancelled"');
  }

  const session = await SafetySession.findById(sessionId);
  if (!session) throw notFound("Safety session not found");

  if (session.status !== "active") {
    return session; // idempotent
  }

  session.status = status;
  session.endedAt = new Date();
  if (reason) session.metadata = { ...session.metadata, endReason: reason };
  await session.save();

  logger.info("safetySession", `ended ${session._id} status=${status} user=${session.userId}`);
  return session;
}

export async function endActiveSessionForUser(userId, reason) {
  const session = await SafetySession.findOne({ userId: String(userId), status: "active" });
  if (!session) return null;
  return endSession(session._id, { status: "ended", reason });
}

/** Called by the location pipeline on every ping (throttled writes only). */
export async function updateLastLocation(sessionId, point) {
  if (!sessionId) return null;
  try {
    return await SafetySession.updateOne(
      { _id: sessionId, status: "active" },
      {
        $set: {
          lastLocation: {
            lat: point.lat,
            lng: point.lng,
            accuracy: point.accuracy ?? null,
            speed: point.speed ?? null,
            recordedAt: point.recordedAt ?? new Date(),
          },
        },
      }
    );
  } catch (err) {
    logger.warn("safetySession", `lastLocation update failed for ${sessionId}: ${err.message}`);
    return null;
  }
}

export async function attachRide(sessionId, rideId) {
  const session = await SafetySession.findById(sessionId);
  if (!session) throw notFound("Safety session not found");
  if (!session.rideRefs.some((id) => String(id) === String(rideId))) {
    session.rideRefs.push(rideId);
    await session.save();
  }
  return session;
}

export async function countSessionEvents(sessionId) {
  const session = await SafetySession.findById(sessionId).select("eventCount");
  return session?.eventCount ?? 0;
}

export async function incrementSessionEvents(sessionId) {
  if (!sessionId) return;
  try {
    await SafetySession.updateOne({ _id: sessionId }, { $inc: { eventCount: 1 } });
  } catch (err) {
    logger.warn("safetySession", `eventCount increment failed: ${err.message}`);
  }
}

export { AppError, conflict };
