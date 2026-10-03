import { ApiError } from '../../utils/ApiError.js';
import { PROTOTYPE_RESPONDERS } from './responder.data.js';
import {
  PROTOTYPE_RESPONDER_RADIUS_KM,
  RESPONDER_ELIGIBLE_STATUS,
  RESPONDER_SOURCE,
} from './responder.constants.js';

/**
 * Prototype responder service — the ONE entry point to the hardcoded
 * responder dataset.
 *
 *   route -> controller -> this service -> responder.data.js
 *
 * The later POST /api/v1/sos/:id/responders/notify flow must call this same
 * service instead of re-declaring the sample list, so the dataset has a
 * single source of truth.
 *
 * Intentionally simple (§4/§14): no coordinates in, no distance out, no
 * ranking, no database, no presence tracking. `RESPONDER_ELIGIBLE_STATUS`
 * is a field comparison against the static data, not a live availability
 * check.
 */

/**
 * Validates the dataset shape and returns the prototype-eligible responders
 * (status === ONLINE). Throws the project's standard 500 ApiError when the
 * dataset is unexpectedly missing or malformed so the centralized error
 * handler can answer without leaking internals.
 */
export const filterEligibleResponders = (responders = PROTOTYPE_RESPONDERS) => {
  if (!Array.isArray(responders) || responders.length === 0) {
    throw ApiError.internal('RESPONDER_DATASET_UNAVAILABLE', 'Prototype responder dataset is unavailable');
  }

  const eligible = responders.filter((responder) => responder?.status === RESPONDER_ELIGIBLE_STATUS);

  console.log(
    `[responders] prototype dataset loaded: ${responders.length} total, ${eligible.length} eligible`
  );

  return eligible;
};

/**
 * Full GET /api/v1/responders/nearby payload.
 *
 * `radiusKm` is the hardcoded 2 km business-rule label — it does NOT mean a
 * distance was measured. `source` states plainly that the list is static.
 */
export const getNearbyResponders = () => ({
  radiusKm: PROTOTYPE_RESPONDER_RADIUS_KM,
  source: RESPONDER_SOURCE.PROTOTYPE_HARDCODED,
  responders: filterEligibleResponders(),
});

/**
 * Display name of a prototype responder, or null when the id is not part of
 * the hardcoded dataset. Used for notification payloads: the identity of a
 * prototype responder comes from HERE, while "was this responder notified"
 * is always answered by the persisted SOS escalation state — never by this
 * dataset alone.
 */
export const findResponderName = (responderId) => {
  const id = responderId === undefined || responderId === null ? null : String(responderId);
  const match = id ? PROTOTYPE_RESPONDERS.find((responder) => responder.id === id) : null;

  return match?.name ?? null;
};
