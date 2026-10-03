/**
 * Prototype police escalation rules.
 *
 * The prototype escalates to ONE server-side hardcoded station: there is no
 * police API, no dispatch integration, no geospatial search and no client
 * selection behind these values. The source marker keeps that explicit for
 * every consumer so the state can never be mistaken for a real notification.
 */
export const POLICE_SOURCE = Object.freeze({
  PROTOTYPE_HARDCODED: 'PROTOTYPE_HARDCODED',
});
