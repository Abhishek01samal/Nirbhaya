import { RESPONDER_STATUS } from './responder.constants.js';

/**
 * Single source of truth for the prototype responder dataset.
 *
 * Consumed by GET /api/v1/responders/nearby and, later, by the escalation
 * service when the guardian level times out — both read THIS list so the
 * sample data is never duplicated.
 *
 * Values are sample/masked: no real person's personal information, no
 * credentials, no internal database fields, and deliberately no
 * latitude/longitude (the prototype performs no geographic calculation).
 *
 * Swap this export for a real repository implementation later without
 * changing the service/controller contract.
 */
export const PROTOTYPE_RESPONDERS = Object.freeze([
  Object.freeze({
    id: 'responder-001',
    name: 'Rahul',
    phone: '+91-98XXXXXX01',
    status: RESPONDER_STATUS.ONLINE,
  }),
  Object.freeze({
    id: 'responder-002',
    name: 'Amit',
    phone: '+91-98XXXXXX02',
    status: RESPONDER_STATUS.ONLINE,
  }),
  Object.freeze({
    id: 'responder-003',
    name: 'Priya',
    phone: '+91-98XXXXXX03',
    status: RESPONDER_STATUS.OFFLINE,
  }),
]);
