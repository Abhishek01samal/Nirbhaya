import { ApiError } from '../../utils/ApiError.js';
import * as guardianRepository from './guardian.repository.js';
import * as guardianDependencies from './guardian.dependencies.js';
import { GUARDIAN_STATUS } from './guardian.constants.js';
import { emitToUserRoom } from '../../sockets/index.js';
import { emitGuardianRequest, emitGuardianAccepted, emitGuardianRejected } from './guardian.events.js';

const isValidId = (value) => /^[0-9a-fA-F]{24}$/.test(String(value));

/**
 * Creates a PENDING guardian invitation: `userId` (protected) invites
 * `guardianUserId` (protector).
 *
 * Checks in order: self-guardian → target exists → duplicate → priority →
 * create. Only then, with the PENDING record persisted, the requested
 * guardian is notified through `guardian:request` — database first, socket
 * second (§3, §7). Socket delivery is best effort: a socket outage never
 * rolls back the created request.
 */
export async function createGuardian({
  userId,
  guardianUserId,
  relationship,
  priority,
  repository = guardianRepository,
  dependencies = guardianDependencies,
  emit = emitToUserRoom,
}) {
  if (!isValidId(guardianUserId)) {
    throw ApiError.badRequest('GUARDIAN_INVALID_USER_ID', 'guardianUserId must be a valid id');
  }

  if (String(userId) === String(guardianUserId)) {
    throw ApiError.badRequest('GUARDIAN_SELF_NOT_ALLOWED', 'A user cannot be their own guardian');
  }

  const targetUser = await dependencies.findUserById(guardianUserId);

  if (!targetUser) {
    throw ApiError.notFound('GUARDIAN_USER_NOT_FOUND', 'Target user not found');
  }

  const existing = await repository.findRelationship(userId, guardianUserId);

  if (existing) {
    throw ApiError.conflict(
      'GUARDIAN_ALREADY_EXISTS',
      'A guardian relationship with this user already exists'
    );
  }

  if (!Number.isInteger(priority) || priority < 1) {
    throw ApiError.badRequest('GUARDIAN_INVALID_PRIORITY', 'priority must be a positive integer');
  }

  const guardian = await repository.createGuardian({
    userId,
    guardianUserId,
    relationship,
    priority,
    status: GUARDIAN_STATUS.PENDING,
  });

  await emitGuardianRequest({ guardian, emit });

  return guardian;
}

/**
 * Read-only: the authenticated user's guardian relationships, ordered by
 * priority ASC (createdAt ASC tie-break). Never accepts another user's id and
 * never modifies records or statuses.
 */
export async function getGuardians({ userId, repository = guardianRepository }) {
  return repository.findByUserId(userId);
}

/**
 * Partial update of the editable fields (relationship, priority) on the
 * caller's own guardian relationship.
 *
 * The update object is constructed explicitly from the two allowed fields �
 * never spread from the client body � so userId/guardianUserId/status/createdAt
 * can never be written. Ownership is enforced inside the repository filter, and
 * missing vs foreign ids both surface as the same 404 (no cross-user probing).
 */
export async function updateGuardian({
  guardianId,
  userId,
  data,
  repository = guardianRepository,
}) {
  const update = {};

  if (data.relationship !== undefined) {
    const relationship = String(data.relationship).trim();

    if (!relationship) {
      throw ApiError.badRequest('GUARDIAN_INVALID_RELATIONSHIP', 'relationship must be a non-empty string');
    }

    update.relationship = relationship;
  }

  if (data.priority !== undefined) {
    if (!Number.isInteger(data.priority) || data.priority < 1) {
      throw ApiError.badRequest('GUARDIAN_INVALID_PRIORITY', 'priority must be a positive integer');
    }

    update.priority = data.priority;
  }

  if (Object.keys(update).length === 0) {
    throw ApiError.badRequest(
      'GUARDIAN_EMPTY_UPDATE',
      'Provide at least one of: relationship, priority'
    );
  }

  const updated = await repository.updateByIdAndUserId(guardianId, userId, update);

  if (!updated) {
    throw ApiError.notFound('GUARDIAN_NOT_FOUND', 'Guardian relationship not found');
  }

  return updated;
}

/**
 * Soft-deletes the caller's guardian relationship by setting status -> BLOCKED
 * (an existing inactive status; the document and its history are preserved).
 *
 * Ownership lives inside the repository filter, so a missing id and a foreign
 * id are indistinguishable (both 404). Already-BLOCKED relationships return a
 * controlled success instead of an error (idempotent). No user account, SOS,
 * notification or socket side effects.
 */
export async function removeGuardian({ guardianId, userId, repository = guardianRepository }) {
  const deactivated = await repository.deactivateByIdAndUserId(guardianId, userId);

  if (deactivated) {
    return { guardian: deactivated, alreadyInactive: false };
  }

  const existing = await repository.findByIdAndUserId(guardianId, userId);

  if (!existing) {
    throw ApiError.notFound('GUARDIAN_NOT_FOUND', 'Guardian relationship not found');
  }

  return { guardian: existing, alreadyInactive: true };
}

/**
 * Accepts a PENDING guardian invitation: only the invited guardian
 * (guardianUserId === authenticatedUserId) may do it, so the protected user
 * can never accept on their behalf.
 *
 * The transition is atomic (PENDING is part of the repository filter), so a
 * concurrent duplicate accept gets a controlled 409 instead of double-firing.
 * Missing, foreign and protected-user ids are all indistinguishable (404).
 * Only AFTER the database reports ACTIVE is the requester told through
 * `guardian:accepted` — never on a 404/409 path, and the emit itself can
 * never roll the transition back (§4, §7, §15).
 */
export async function acceptGuardian({ guardianId, guardianUserId, repository = guardianRepository, emit = emitToUserRoom }) {
  const accepted = await repository.acceptByGuardian(guardianId, guardianUserId);

  if (accepted) {
    await emitGuardianAccepted({ guardian: accepted, emit });

    return { guardian: accepted };
  }

  const existing = await repository.findByGuardianId(guardianId, guardianUserId);

  if (!existing) {
    throw ApiError.notFound('GUARDIAN_NOT_FOUND', 'Guardian relationship not found');
  }

  throw ApiError.conflict(
    'GUARDIAN_NOT_PENDING',
    `Only a PENDING guardian request can be accepted (current: ${existing.status})`
  );
}

/**
 * Rejects a PENDING guardian invitation: only the invited guardian
 * (guardianUserId === authenticatedUserId) may do it, so the protected user
 * can never reject on their behalf.
 *
 * Atomic PENDING -> REJECTED (PENDING is part of the repository filter), so a
 * racing accept/reject on the same relationship yields exactly one success and
 * one controlled 409. Missing, foreign and protected-user ids are
 * indistinguishable (404). Only AFTER the database reports REJECTED is the
 * requester told through `guardian:rejected` (§5, §7, §15).
 */
export async function rejectGuardian({ guardianId, guardianUserId, repository = guardianRepository, emit = emitToUserRoom }) {
  const rejected = await repository.rejectByGuardian(guardianId, guardianUserId);

  if (rejected) {
    await emitGuardianRejected({ guardian: rejected, emit });

    return { guardian: rejected };
  }

  const existing = await repository.findByGuardianId(guardianId, guardianUserId);

  if (!existing) {
    throw ApiError.notFound('GUARDIAN_NOT_FOUND', 'Guardian relationship not found');
  }

  throw ApiError.conflict(
    'GUARDIAN_NOT_PENDING',
    `Only a PENDING guardian request can be rejected (current: ${existing.status})`
  );
}
