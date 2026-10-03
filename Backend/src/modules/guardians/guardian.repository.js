import { Guardian } from './guardian.model.js';
import { GUARDIAN_STATUS } from './guardian.constants.js';

/**
 * Database access only. No business rules (self-check, duplicate policy,
 * status decisions) live here.
 */

export async function findRelationship(userId, guardianUserId) {
  return Guardian.findOne({ userId, guardianUserId }).lean();
}

/**
 * The authenticated user's own guardians (they are the protected user), ordered
 * by escalation priority, then createdAt for a deterministic tie-break.
 * Never filter on guardianUserId here — that would return relationships where
 * the user is somebody else's guardian.
 */
export async function findByUserId(userId) {
  return Guardian.find({ userId }).sort({ priority: 1, createdAt: 1 }).lean();
}

export async function createGuardian(data) {
  return Guardian.create(data);
}

/**
 * Atomic partial update with ownership enforced directly in the filter —
 * a foreign guardian document can never match, and only the explicitly
 * constructed `update` fields are written ($set, never a body spread).
 */
export async function updateByIdAndUserId(guardianId, userId, update) {
  return Guardian.findOneAndUpdate(
    { _id: guardianId, userId },
    { $set: update },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Soft-deactivate: sets status -> BLOCKED with ownership in the filter.
 * Returns the updated document, or null when no relationship matches
 * _id + userId (missing OR foreign � callers must treat them the same).
 */
export async function deactivateByIdAndUserId(guardianId, userId) {
  return Guardian.findOneAndUpdate(
    { _id: guardianId, userId, status: { $ne: GUARDIAN_STATUS.BLOCKED } },
    { $set: { status: GUARDIAN_STATUS.BLOCKED } },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Ownership-scoped read used to tell "already inactive" apart from
 * "missing/foreign" after the conditional update matched nothing.
 */
export async function findByIdAndUserId(guardianId, userId) {
  return Guardian.findOne({ _id: guardianId, userId }).lean();
}

/**
 * Atomic PENDING -> ACTIVE acceptance.
 *
 * Ownership (guardianUserId) AND the source state (PENDING) are inside the
 * filter, so two concurrent accepts cannot both win, and an unscoped follow-up
 * update is never needed. Returns the updated document or null.
 */
export async function acceptByGuardian(guardianId, guardianUserId) {
  return Guardian.findOneAndUpdate(
    { _id: guardianId, guardianUserId, status: GUARDIAN_STATUS.PENDING },
    { $set: { status: GUARDIAN_STATUS.ACTIVE } },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Guardian-scoped read used to tell "not PENDING" (409) apart from
 * "missing / belongs to someone else" (404) after the conditional update
 * matched nothing. Never reads outside the caller's own relationships.
 */
export async function findByGuardianId(guardianId, guardianUserId) {
  return Guardian.findOne({ _id: guardianId, guardianUserId }).lean();
}

/**
 * Atomic PENDING -> REJECTED rejection. Same guarantees as acceptByGuardian:
 * ownership (guardianUserId) and source state (PENDING) are in the filter, so
 * a concurrent accept/reject pair cannot both win. Returns the updated
 * document or null.
 */
export async function rejectByGuardian(guardianId, guardianUserId) {
  return Guardian.findOneAndUpdate(
    { _id: guardianId, guardianUserId, status: GUARDIAN_STATUS.PENDING },
    { $set: { status: GUARDIAN_STATUS.REJECTED } },
    { returnDocument: 'after' }
  ).lean();
}
