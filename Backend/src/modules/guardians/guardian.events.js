/**
 * Socket.IO events for the guardian relationship flow.
 *
 * Event names, payloads and best-effort delivery live here so the guardian
 * service stays focused on business rules and never touches `io.to(...)`
 * directly. The database stays the source of truth: these notifications are
 * emitted only AFTER the persisted transition, a dropped socket never rolls
 * it back, and every client can recover through GET /api/v1/guardians.
 *
 * Direction rules (§6): the requested guardian hears `guardian:request`;
 * the original requester hears `guardian:accepted` / `guardian:rejected`.
 * None of these is ever client-authoritative — the client never emits them.
 */

import { safeEmit } from '../calling/call.events.js';
import { GUARDIAN_STATUS } from './guardian.constants.js';

export const GUARDIAN_EVENT = Object.freeze({
  REQUEST: 'guardian:request',
  ACCEPTED: 'guardian:accepted',
  REJECTED: 'guardian:rejected',
});

/**
 * `guardian:request` payload (§3): which request arrived, who sent it, the
 * relationship/priority they chose, and its persisted PENDING status. It
 * never creates the relationship — the POST endpoint already did that.
 */
export const guardianRequestPayload = ({ guardian }) => ({
  guardianRequestId: String(guardian?._id ?? ''),
  userId: guardian?.userId ? String(guardian.userId) : null,
  relationship: guardian?.relationship ?? null,
  priority: guardian?.priority ?? null,
  status: guardian?.status ?? GUARDIAN_STATUS.PENDING,
  message: 'You have received a new guardian request',
});

/**
 * Tells the REQUESTED guardian (guardianUserId's private `user:<id>` room)
 * that a PENDING request is waiting for them. Best effort: withheld without
 * a stored request or recipient; a socket outage never fails the creation.
 *
 * Returns true when the notification was handed to the socket layer.
 */
export const emitGuardianRequest = async ({ guardian, emit }) => {
  if (!guardian?.guardianUserId) return false;
  if (!guardian?._id) return false;

  await safeEmit(emit, String(guardian.guardianUserId), GUARDIAN_EVENT.REQUEST, guardianRequestPayload({ guardian }));

  return true;
};

/**
 * `guardian:accepted` payload (§4): the original requester (userId's room)
 * learns the request is now ACTIVE — the same fields the request carries,
 * plus the accepting guardian's id.
 */
export const guardianAcceptedPayload = ({ guardian }) => ({
  guardianRequestId: String(guardian?._id ?? ''),
  userId: guardian?.userId ? String(guardian.userId) : null,
  guardianUserId: guardian?.guardianUserId ? String(guardian.guardianUserId) : null,
  relationship: guardian?.relationship ?? null,
  priority: guardian?.priority ?? null,
  status: guardian?.status ?? GUARDIAN_STATUS.ACTIVE,
  message: 'Guardian request accepted',
});

/**
 * Tells the ORIGINAL REQUESTER that the requested guardian accepted.
 * Emitted only after the atomic PENDING -> ACTIVE write.
 */
export const emitGuardianAccepted = async ({ guardian, emit }) => {
  if (!guardian?.userId) return false;
  if (!guardian?._id) return false;

  await safeEmit(emit, String(guardian.userId), GUARDIAN_EVENT.ACCEPTED, guardianAcceptedPayload({ guardian }));

  return true;
};

/**
 * `guardian:rejected` payload (§5): the original requester learns the
 * request reached its terminal REJECTED state.
 */
export const guardianRejectedPayload = ({ guardian }) => ({
  guardianRequestId: String(guardian?._id ?? ''),
  userId: guardian?.userId ? String(guardian.userId) : null,
  guardianUserId: guardian?.guardianUserId ? String(guardian.guardianUserId) : null,
  relationship: guardian?.relationship ?? null,
  priority: guardian?.priority ?? null,
  status: guardian?.status ?? GUARDIAN_STATUS.REJECTED,
  message: 'Guardian request rejected',
});

/**
 * Tells the ORIGINAL REQUESTER that the requested guardian rejected.
 * Emitted only after the atomic PENDING -> REJECTED write.
 */
export const emitGuardianRejected = async ({ guardian, emit }) => {
  if (!guardian?.userId) return false;
  if (!guardian?._id) return false;

  await safeEmit(emit, String(guardian.userId), GUARDIAN_EVENT.REJECTED, guardianRejectedPayload({ guardian }));

  return true;
};
