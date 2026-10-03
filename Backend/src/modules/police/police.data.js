/**
 * Single source of truth for the prototype police station.
 *
 * Consumed by the police escalation service only, so the station object is
 * never duplicated inside a controller or a payload builder.
 *
 * Values are sample data: no real station, no credentials, no internal
 * database fields, and deliberately no latitude/longitude (the prototype
 * performs no geographic calculation and never searches for a station).
 *
 * Swap this export for a real integration later without changing the
 * service/controller contract.
 */
export const PROTOTYPE_POLICE_STATION = Object.freeze({
  id: 'police-001',
  name: 'Prototype Police Station',
  phone: '1000000000',
});
