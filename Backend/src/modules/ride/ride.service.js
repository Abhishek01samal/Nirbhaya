import { Ride } from "./ride.model.js";
import * as googleMaps from "../../integrations/googleMaps/googleMaps.js";
import { getActiveSession, attachRide } from "../safetySession/safetySession.service.js";
import { badRequest, notFound } from "../../middleware/error.js";
import { emitToRide, emitToUser } from "../../sockets/socket.js";
import { haversineMeters } from "../../utils/geo.js";
import logger from "../../utils/logger.js";

const OWNER_FIELDS = "userId status safetySessionId provider driver vehicleNumber vehicleModel fareEstimate tripNote screenshot pickup drop route monitoring startedAt stoppedAt createdAt updatedAt";

/** Create a ride from an uploaded screenshot (Cloudinary + OCR results). */
export async function createRideFromUpload({ userId, fileMeta, image, ocr }) {
  return Ride.create({
    userId: String(userId),
    status: "uploaded",
    provider: ocr?.fields?.provider ?? "other",
    driver: {
      name: ocr?.fields?.driverName ?? "",
      phone: ocr?.fields?.driverPhone ?? "",
    },
    vehicleNumber: ocr?.fields?.vehicleNumber ?? "",
    vehicleModel: ocr?.fields?.vehicleModel ?? "",
    fareEstimate: ocr?.fields?.fareEstimate ?? null,
    tripNote: ocr?.fields?.tripNote ?? "",
    screenshot: {
      stored: Boolean(image?.stored),
      url: image?.url ?? "",
      publicId: image?.publicId ?? "",
      originalName: fileMeta?.originalName ?? "",
      sizeBytes: fileMeta?.sizeBytes ?? 0,
      ocrText: (ocr?.text ?? "").slice(0, 20000),
      ocrFields: ocr?.fields ?? {},
      ocrError: ocr?.error ?? "",
    },
  });
}

export async function getRide(rideId) {
  const ride = await Ride.findById(rideId).select(OWNER_FIELDS);
  if (!ride) throw notFound("Ride not found");
  return ride;
}

export async function listRides(userId, { status, limit = 20 } = {}) {
  const filter = { userId: String(userId) };
  if (status) filter.status = status;
  return Ride.find(filter).sort({ createdAt: -1 }).limit(Math.min(limit, 100)).select(OWNER_FIELDS);
}

/**
 * Confirm a ride: apply user corrections, geocode addresses when needed and
 * resolve the planned route. Google Maps failure falls back to a synthetic
 * straight-line route so monitoring still works offline.
 */
export async function confirmRide(rideId, updates = {}) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw notFound("Ride not found");
  if (["active", "completed"].includes(ride.status)) {
    throw badRequest(`Cannot confirm a ${ride.status} ride`);
  }

  if (updates.provider) ride.provider = updates.provider;
  if (updates.driver) {
    ride.driver = { ...ride.driver, ...(updates.driver ?? {}) };
  }
  if (updates.vehicleNumber !== undefined) ride.vehicleNumber = updates.vehicleNumber;
  if (updates.vehicleModel !== undefined) ride.vehicleModel = updates.vehicleModel;
  if (updates.fareEstimate !== undefined) ride.fareEstimate = updates.fareEstimate;
  if (updates.tripNote !== undefined) ride.tripNote = updates.tripNote;

  const pickupInput = updates.pickup ?? ride.pickup;
  const dropInput = updates.drop ?? ride.drop;

  if (pickupInput) {
    const resolved = await resolvePoint(pickupInput, "pickup");
    if (!resolved && updates.pickup) throw unresolvable("pickup");
    ride.pickup = resolved ?? ride.pickup;
  }
  if (dropInput) {
    const resolved = await resolvePoint(dropInput, "drop");
    if (!resolved && updates.drop) throw unresolvable("drop");
    ride.drop = resolved ?? ride.drop;
  }

  if (ride.pickup && ride.drop) {
    ride.route = await resolveRoute(ride.pickup, ride.drop);
  }

  ride.status = "confirmed";
  await ride.save();

  emitToRide(ride._id, "ride:updated", { rideId: ride._id, status: ride.status });
  logger.info("ride", `confirmed ${ride._id} route=${ride.route.source} ${ride.route.distanceM}m`);
  return ride;
}

/** Start monitoring: requires pickup/drop; fetches the route if missing. */
export async function startRide(rideId, { safetySessionId } = {}) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw notFound("Ride not found");
  if (ride.status === "active") return ride;
  if (ride.status === "completed") throw badRequest("Ride already completed");

  if (!ride.pickup || !ride.drop) {
    throw badRequest("Confirm the ride with pickup and drop before starting");
  }

  if (!ride.route || ride.route.source === "none" || ride.route.polyline.length < 2) {
    ride.route = await resolveRoute(ride.pickup, ride.drop);
  }

  ride.status = "active";
  ride.startedAt = new Date();
  ride.stoppedAt = null;
  ride.resetMonitoring();

  const session =
    (safetySessionId ? { _id: safetySessionId } : await getActiveSession(ride.userId)) ?? null;
  if (session?._id) {
    ride.safetySessionId = session._id;
    await attachRide(session._id, ride._id);
  }

  await ride.save();

  emitToRide(ride._id, "ride:started", {
    rideId: ride._id,
    userId: ride.userId,
    startedAt: ride.startedAt,
    route: { distanceM: ride.route.distanceM, durationS: ride.route.durationS },
  });
  emitToUser(ride.userId, "ride:updated", { rideId: ride._id, status: "active" });

  logger.info("ride", `started ${ride._id} session=${ride.safetySessionId ?? "-"}`);
  return ride;
}

export async function stopRide(rideId, { status = "completed", reason } = {}) {
  const ride = await Ride.findById(rideId);
  if (!ride) throw notFound("Ride not found");
  if (ride.status === "completed") return ride; // idempotent
  if (ride.status !== "active") throw badRequest("Ride is not active");

  ride.status = status === "cancelled" ? "cancelled" : "completed";
  ride.stoppedAt = new Date();
  if (reason) ride.tripNote = ride.tripNote ? `${ride.tripNote} | ${reason}` : reason;
  await ride.save();

  emitToRide(ride._id, "ride:updated", {
    rideId: ride._id,
    status: ride.status,
    stoppedAt: ride.stoppedAt,
  });

  logger.info("ride", `stopped ${ride._id} status=${ride.status}`);
  return ride;
}

// ---------------------------------------------------------------- helpers

/** Fill in coordinates from an address when lat/lng are missing. */
async function resolvePoint(point, label) {
  if (!point) return null;
  if (typeof point.lat === "number" && typeof point.lng === "number") return point;
  if (!point.address) return null;

  try {
    const geo = await googleMaps.geocode(point.address);
    if (geo) return { lat: geo.lat, lng: geo.lng, address: geo.formattedAddress };
  } catch (err) {
    logger.warn("ride", `geocode ${label} failed: ${err.message}`);
  }
  return null;
}

function unresolvable(label) {
  return badRequest(
    `Could not resolve ${label} - send lat/lng directly, or check the address (GOOGLE_MAPS_API_KEY may be unset)`
  );
}

/** Google directions, with a synthetic offline fallback. */
async function resolveRoute(origin, destination) {
  try {
    const route = await googleMaps.directions(origin, destination);
    if (route.polyline.length >= 2) return route;
    throw new Error("empty polyline");
  } catch (err) {
    logger.warn("ride", `directions unavailable (${err.message}) - using synthetic route`);
    return googleMaps.syntheticRoute(origin, destination);
  }
}

/** Rough straight-line trip estimate (metres) - used for sanity checks. */
export function estimateDistance(a, b) {
  return haversineMeters(a, b);
}
