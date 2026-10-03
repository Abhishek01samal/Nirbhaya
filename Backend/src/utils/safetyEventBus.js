import { EventEmitter } from "node:events";
import logger from "./logger.js";

/**
 * Safety event bus - THE integration point between this backend's detection
 * modules and Person 1's SOS module.
 *
 * This backend only DETECTS safety conditions (OFF_ROUTE, LONG_STOP, ...).
 * It never escalates. Person 1 decides what happens next:
 *
 *   import { onSafetyEvent } from "../utils/safetyEventBus.js";
 *   onSafetyEvent((event) => sosService.handleDetection(event));
 *
 * Event payload:
 * {
 *   type: "OFF_ROUTE" | "LONG_STOP" | "GEOFENCE_BREACH" | ...,
 *   userId,
 *   safetySessionId | null,
 *   rideId | null,
 *   location: { lat, lng },
 *   metadata: { ... },
 *   timestamp: ISO string,
 *   source: "location" | "ride" | "monitoring"
 * }
 */

const bus = new EventEmitter();
bus.setMaxListeners(50);

const KNOWN_TYPES = new Set(["OFF_ROUTE", "LONG_STOP", "GEOFENCE_BREACH", "ARRIVED", "VOICE_DANGER", "CRIME_AREA_ENTRY"]);

export function emitSafetyEvent(partial) {
  const event = {
    type: String(partial.type ?? "UNKNOWN"),
    userId: partial.userId ?? null,
    safetySessionId: partial.safetySessionId ?? null,
    rideId: partial.rideId ?? null,
    location: partial.location ?? null,
    metadata: partial.metadata ?? {},
    source: partial.source ?? "monitoring",
    timestamp: partial.timestamp instanceof Date ? partial.timestamp : new Date(partial.timestamp ?? Date.now()),
  };

  logger.info("safety-event", `${event.type} user=${event.userId} ride=${event.rideId ?? "-"}`, {
    metadata: event.metadata,
  });

  bus.emit("safety_event", event);
  bus.emit(`safety_event:${event.type}`, event);
  if (!KNOWN_TYPES.has(event.type)) {
    logger.warn("safety-event", `unrecognised type "${event.type}" - Person 1 may not handle it`);
  }
  return event;
}

/** Register a handler for every detection event. Returns an unsubscribe fn. */
export function onSafetyEvent(handler) {
  bus.on("safety_event", handler);
  return () => bus.off("safety_event", handler);
}

/** Register a handler for one event type (e.g. "OFF_ROUTE"). Returns unsubscribe fn. */
export function onSafetyEventType(type, handler) {
  const name = `safety_event:${type}`;
  bus.on(name, handler);
  return () => bus.off(name, handler);
}

export { bus as safetyEventBus };
export default bus;
