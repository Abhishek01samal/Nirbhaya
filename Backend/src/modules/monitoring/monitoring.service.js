import { Ride } from "../ride/ride.model.js";
import { checkOffRoute } from "./routeMonitor.service.js";
import { checkLongStop } from "./stopDetector.service.js";
import logger from "../../utils/logger.js";

/**
 * Monitoring facade - one entry point per location point.
 *
 * Loads the ride once, runs the detectors, persists any state change and
 * returns what fired. Detection only: events go to the safetyEventBus for
 * Person 1's SOS module, and (via socket/ride.socket.js) to connected clients.
 */
export async function evaluateRidePoint({ rideId, point }) {
  const ride = await Ride.findById(rideId);
  if (!ride) {
    // Deleted ride - never fail the location ping over it.
    logger.warn("monitoring", `ride ${rideId} not found - skipping monitoring`);
    return null;
  }
  if (ride.status !== "active") return null;

  const offRoute = checkOffRoute(ride, point);
  const longStop = checkLongStop(ride, point);

  if (offRoute || longStop) {
    try {
      await ride.save();
    } catch (err) {
      logger.error("monitoring", `failed to persist ride ${rideId}: ${err.message}`);
    }
  } else if (ride.isModified()) {
    // Persist cheap counters (lastRouteDistanceM, stopAnchor, ...)
    await ride.save().catch((err) =>
      logger.warn("monitoring", `state save failed for ${rideId}: ${err.message}`)
    );
  }

  if (!offRoute && !longStop) return null;
  return {
    offRoute: offRoute ?? null,
    longStop: longStop ?? null,
  };
}

export { checkOffRoute, checkLongStop };
