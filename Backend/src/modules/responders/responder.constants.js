/**
 * Prototype nearby-responder rules.
 *
 * The radius is a BUSINESS-RULE LABEL only: the backend never measures a
 * distance, never reads a coordinate and never runs a geospatial query.
 */
export const PROTOTYPE_RESPONDER_RADIUS_KM = 2;

/**
 * Marks the payload as static sample data so no consumer mistakes it for
 * real proximity discovery.
 */
export const RESPONDER_SOURCE = Object.freeze({
  PROTOTYPE_HARDCODED: 'PROTOTYPE_HARDCODED',
});

/**
 * Prototype availability. There is no presence tracking behind these values:
 * they are fields of the static dataset in responder.data.js.
 */
export const RESPONDER_STATUS = Object.freeze({
  ONLINE: 'ONLINE',
  OFFLINE: 'OFFLINE',
});

export const RESPONDER_ELIGIBLE_STATUS = RESPONDER_STATUS.ONLINE;
