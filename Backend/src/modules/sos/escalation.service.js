import { ApiError } from '../../utils/ApiError.js';
import { env } from '../../config/env.js';
import * as sosRepository from './sos.repository.js';
import * as callRepository from '../calling/call.repository.js';
import * as relationshipRepository from '../guardians/guardian.repository.js';
import { GUARDIAN_STATUS } from '../guardians/guardian.constants.js';
import { emitToUserRoom, isUserOnline } from '../../sockets/index.js';
import { filterEligibleResponders, findResponderName } from '../responders/responder.service.js';
import { PROTOTYPE_RESPONDER_RADIUS_KM } from '../responders/responder.constants.js';
import { getPrototypePoliceStation } from '../police/police.service.js';
import {
  emitGuardianNotify,
  emitGuardianAcknowledged,
  emitResponderNotify,
  emitResponderAcknowledged,
  emitResponderSosNotification,
  emitResponderSosAcknowledged,
  emitResponderSosExpired,
  emitPoliceEscalated,
  emitLifecycleGuardianNotified,
  emitLifecycleGuardianAcknowledged,
  emitLifecycleEscalating,
} from './sos.events.js';
import {
  ESCALATION_LEVEL_STATUS,
  ESCALATION_LEVEL_TYPE,
  ESCALATION_REASONS,
  SOS_STATUS,
} from './sos.constants.js';

/**
 * Guardian escalation for an ACTIVE SOS.
 *
 * Rules implemented here (prototype scope, guardian level only):
 *   - only the owner may start it, only while the SOS is ACTIVE;
 *   - the first reachable guardian (priority ASC, createdAt ASC tie-break,
 *     existing account, currently online) becomes the level target;
 *   - the level is written atomically, so concurrent starts produce exactly
 *     one PENDING level — the loser replays the winner's state;
 *   - the guardian is notified best effort AFTER the write, and a timer flips
 *     the level to TIMEOUT if nobody acknowledges in time;
 *   - an escalation that already progressed (TIMEOUT, responder/police) or an
 *     already acknowledged SOS is refused with 409.
 *
 * The SOS status itself never changes here (§4): escalation levels describe
 * progress, status is owned by the existing SOS state machine.
 */

const toSummary = (sos, level) => ({
  sosId: String(sos._id),
  level: level?.type ?? null,
  status: level?.status ?? null,
  targetId: level?.targetId ? String(level.targetId) : null,
  expiresAt: level?.expiresAt ?? null,
});

const acknowledgedError = () =>
  ApiError.conflict(
    'ESCALATION_ALREADY_ACKNOWLEDGED',
    'This SOS has already been acknowledged by a guardian'
  );

/**
 * Decides what a start request should do given the document as it stands now:
 *   error  -> throw (refuse the request)
 *   replay -> idempotent 200 with the existing level (no write, no emit, no timer)
 *   start  -> the SOS is ACTIVE with zero levels; attempt the atomic write
 */
const classifyExisting = (sos) => {
  const levels = Array.isArray(sos?.escalation?.levels) ? sos.escalation.levels : [];
  const first = levels[0];

  if (sos.status !== SOS_STATUS.ACTIVE) {
    if (
      first?.type === ESCALATION_LEVEL_TYPE.GUARDIAN &&
      first?.status === ESCALATION_LEVEL_STATUS.ACKNOWLEDGED
    ) {
      return { kind: 'error', error: acknowledgedError() };
    }

    return {
      kind: 'error',
      error: ApiError.conflict(
        'SOS_NOT_ACTIVE',
        `Guardian escalation can only be started for an ACTIVE SOS (current: ${sos.status})`
      ),
    };
  }

  if (!first) return { kind: 'start' };

  if (first.type === ESCALATION_LEVEL_TYPE.GUARDIAN) {
    if (first.status === ESCALATION_LEVEL_STATUS.PENDING) {
      return { kind: 'replay', level: first };
    }
    if (first.status === ESCALATION_LEVEL_STATUS.ACKNOWLEDGED) {
      return { kind: 'error', error: acknowledgedError() };
    }
  }

  return {
    kind: 'error',
    error: ApiError.conflict(
      'ESCALATION_ALREADY_PROGRESS',
      'Escalation has already progressed beyond the guardian level'
    ),
  };
};

/**
 * Highest-priority guardian that is actually reachable: the repository already
 * returns ACTIVE relationships ordered priority ASC / createdAt ASC, and a
 * guardian whose account no longer exists or whose browser is offline is
 * skipped in favour of the next one.
 */
const selectGuardian = async (repository, ownerId, isOnline) => {
  const guardians = await repository.findActiveGuardians(ownerId);

  for (const guardian of guardians) {
    const account = await repository.findUserById(guardian.guardianUserId);

    if (!account) continue;
    if (!(await isOnline(guardian.guardianUserId))) continue;

    return guardian;
  }

  return null;
};

/**
 * Display name for a notification payload (SOS owner or guardian). Best
 * effort: a missing profile or failed read yields null instead of failing the
 * escalation that was already persisted. Shared with the generic acknowledge
 * path in sos.service.js so both lifecycle payloads resolve names the same way.
 */
export const resolveUserName = async (repository, userId) => {
  try {
    const user = await repository.findUserById(userId);
    return user?.name ?? null;
  } catch (err) {
    console.warn(`[escalation] failed to load profile: ${err?.message || err}`);
    return null;
  }
};

/**
 * In-process registry of armed level timeouts, keyed by SOS id — the same
 * single timer mechanism escalation/start already uses (no second timer
 * architecture). Acknowledgement cancels the pending handle here; if a
 * cancellation is missed (process edge cases), the timer callback still
 * re-validates persisted state atomically before touching anything.
 */
const levelTimeouts = new Map();

/**
 * Stops the pending timeout for this SOS. Returns true when an armed timer
 * was cancelled, false when there was nothing to cancel (never throws: a
 * failed cancellation must not fail an already-persisted acknowledgement —
 * the atomic re-validation inside runGuardianTimeout is the backstop).
 */
const cancelLevelTimeout = (sosId) => {
  const key = String(sosId);
  const handle = levelTimeouts.get(key);

  if (handle === undefined) return false;
  levelTimeouts.delete(key);

  try {
    clearTimeout(handle);
  } catch (err) {
    console.warn(`[escalation] failed to cancel level timeout: ${err?.message || err}`);
  }

  return true;
};

/** Replaces any previously armed timeout for this SOS, then stores the new one. */
const armLevelTimeout = ({ sosId, task, ms, schedule }) => {
  cancelLevelTimeout(sosId);

  const handle = schedule(task, ms);

  if (handle !== undefined && handle !== null) {
    levelTimeouts.set(String(sosId), handle);
  }

  return handle;
};

/**
 * In-process timeout. Unref'd so it never keeps the process alive; a timeout
 * surviving a restart is deliberately out of scope for the prototype (see
 * runGuardianTimeout). Scheduling failures are logged, never thrown: the
 * escalation level is already durable without the timer.
 */
const scheduleTimeout = (fn, ms) => {
  try {
    const timer = setTimeout(() => {
      Promise.resolve(fn()).catch((err) =>
        console.warn(`[escalation] guardian timeout task failed: ${err?.message || err}`)
      );
    }, ms);

    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  } catch (err) {
    console.warn(`[escalation] failed to schedule guardian timeout: ${err?.message || err}`);
    return null;
  }
};

/**
 * The escalation timer's callback. Re-validates atomically before writing:
 * an acknowledged, cancelled, resolved or already-timed-out level is never
 * rewritten by a late-firing timer, and every failure path returns false
 * instead of throwing (nothing awaits this from a request).
 *
 * Records the guardian TIMEOUT and stops: the next phase (nearby responders)
 * is started by the escalation workflow through startResponderEscalation
 * (POST /:id/responders/notify), never by this timer — and once the responder
 * level has run its own course, its timer continues into police escalation
 * (see runResponderTimeout).
 */
export async function runGuardianTimeout({ sosId, repository = sosRepository }) {
  // The timer has fired: it is no longer cancellable, drop the handle so a
  // later acknowledgement cannot try to clear a dead timer.
  levelTimeouts.delete(String(sosId));

  try {
    const updated = await repository.timeoutGuardianEscalation({ sosId });

    if (!updated) {
      console.log(`[escalation] guardian timeout skipped for SOS ${sosId} (nothing pending)`);
      return false;
    }

    console.log(
      `[escalation] guardian level timed out for SOS ${sosId}; responder escalation starts through its own endpoint`
    );
    return true;
  } catch (err) {
    console.warn(`[escalation] guardian timeout failed for SOS ${sosId}: ${err?.message || err}`);
    return false;
  }
}

/**
 * The responder timer's callback — the SAME registry, the SAME discipline as
 * runGuardianTimeout: the handle is dropped first, then one conditional
 * update decides whether the transition is still allowed (a responder that
 * acknowledged, a cancelled/resolved SOS or an already-timed-out level all
 * leave the write refused), and every failure path returns false.
 *
 * On a successful write the expiry is notified and the escalation continues:
 *   1. `responder:sos-expired` goes to exactly the responders recorded on
 *      the timed-out level (private rooms, best effort, §18);
 *   2. the EXISTING police escalation is invoked directly through
 *      escalateToPolice — the same service POST /:id/escalation/police
 *      uses (§19): no backend-to-backend HTTP call, no duplicated rules.
 *      All of its validations, its atomic write and its `sos:escalating` /
 *      `sos:police:escalated` events come for free, and its duplicate
 *      protection means a second invocation can never notify the station
 *      twice.
 *
 * Socket failure or a refused/failed police escalation never changes the
 * fact that the timeout write succeeded: the database stays authoritative
 * and the frontend recovers through GET /:id/escalation.
 */
export async function runResponderTimeout({
  sosId,
  repository = sosRepository,
  emit = emitToUserRoom,
  escalatePolice = escalateToPolice,
}) {
  // The timer has fired: it is no longer cancellable, drop the handle so a
  // later acknowledgement cannot try to clear a dead timer.
  levelTimeouts.delete(String(sosId));

  try {
    const updated = await repository.timeoutResponderEscalation({ sosId });

    if (!updated) {
      console.log(`[escalation] responder timeout skipped for SOS ${sosId} (nothing pending)`);
      return false;
    }

    const stored = updated.escalation?.levels?.[1];

    try {
      const expiredRecipients = await emitResponderSosExpired({
        sosId,
        responderIds: stored?.notifiedResponders ?? [],
        status: stored?.status ?? ESCALATION_LEVEL_STATUS.TIMEOUT,
        reason: ESCALATION_REASONS.RESPONDER_TIMEOUT,
        expiredAt: stored?.expiresAt ?? new Date(),
        emit,
      });
      console.log(
        `[escalation] responder level timed out for SOS ${sosId} (${expiredRecipients} responders notified)`
      );
    } catch (err) {
      console.warn(
        `[escalation] responder expiry notification failed for SOS ${sosId}: ${err?.message || err}`
      );
    }

    try {
      await escalatePolice({ sosId, userId: updated.userId, repository, emit });
      console.log(`[escalation] police escalation continued for SOS ${sosId} after responder timeout`);
    } catch (err) {
      console.warn(
        `[escalation] automatic police escalation failed for SOS ${sosId}: ${err?.message || err}`
      );
    }

    return true;
  } catch (err) {
    console.warn(`[escalation] responder timeout failed for SOS ${sosId}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Starts guardian escalation for one ACTIVE SOS.
 *
 * Returns the summary of the level that now exists:
 *   `{ sosId, level, status, targetId, expiresAt }` — for a fresh PENDING
 *   level, for an idempotent replay of an existing one, or for the TIMEOUT
 *   level recorded when no guardian is reachable.
 *
 * Throws 404 (missing), 403 (foreign SOS) or 409 (wrong state / already
 * progressed). The notification is emitted only after the atomic write
 * succeeded, best effort, and the timeout timer is registered only by the
 * single write winner.
 */
export async function startGuardianEscalation({
  sosId,
  userId,
  repository = sosRepository,
  guardianRepository = callRepository,
  isOnline = isUserOnline,
  emit = emitToUserRoom,
  scheduleTimeout: schedule = scheduleTimeout,
  timeoutMs = null,
}) {
  console.log(`[escalation] start requested for SOS ${sosId}`);

  const current = await repository.findById(sosId);

  if (!current) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (String(current.userId) !== String(userId)) {
    throw ApiError.forbidden('SOS_NOT_AUTHORIZED', 'You do not own this SOS event');
  }

  const existing = classifyExisting(current);

  if (existing.kind === 'error') throw existing.error;

  if (existing.kind === 'replay') {
    console.log(`[escalation] duplicate start ignored for SOS ${sosId}`);
    return toSummary(current, existing.level);
  }

  const maxWaitMs = timeoutMs ?? env.escalation.guardianTimeoutSeconds * 1000;
  const ownerId = current.userId;
  const guardian = await selectGuardian(guardianRepository, ownerId, isOnline);

  const notifiedAt = new Date();
  const level = guardian
    ? {
        type: ESCALATION_LEVEL_TYPE.GUARDIAN,
        status: ESCALATION_LEVEL_STATUS.PENDING,
        targetId: guardian.guardianUserId,
        notifiedAt,
        respondedAt: null,
        expiresAt: new Date(notifiedAt.getTime() + maxWaitMs),
      }
    : {
        type: ESCALATION_LEVEL_TYPE.GUARDIAN,
        status: ESCALATION_LEVEL_STATUS.TIMEOUT,
        targetId: null,
        notifiedAt: null,
        respondedAt: null,
        expiresAt: null,
      };

  const updated = await repository.startGuardianEscalation({
    sosId,
    userId: ownerId,
    level,
  });

  if (!updated) {
    const latest = await repository.findById(sosId);

    if (!latest) {
      throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
    }

    const raced = classifyExisting(latest);

    if (raced.kind === 'replay') {
      console.log(`[escalation] concurrent start replayed existing level for SOS ${sosId}`);
      return toSummary(latest, raced.level);
    }

    if (raced.kind === 'error') throw raced.error;

    throw ApiError.conflict(
      'ESCALATION_START_CONFLICT',
      'The guardian escalation could not be started'
    );
  }

  const stored = updated.escalation.levels[0];

  if (stored.status === ESCALATION_LEVEL_STATUS.TIMEOUT) {
    console.log(`[escalation] no reachable guardian for SOS ${sosId}; TIMEOUT level recorded`);
    return toSummary(updated, stored);
  }

  // Only the atomic-write winner registers the timer, so a duplicate request
  // can never stack a second timeout on the same level.
  armLevelTimeout({
    sosId,
    task: () => runGuardianTimeout({ sosId, repository }),
    ms: maxWaitMs,
    schedule,
  });
  console.log(`[escalation] guardian timeout registered for SOS ${sosId} in ${maxWaitMs}ms`);

  const ownerName = await resolveUserName(guardianRepository, ownerId);
  const notified = await emitGuardianNotify({
    sosId,
    guardianUserId: stored.targetId,
    user: { userId: ownerId, name: ownerName },
    location: updated.location ?? null,
    status: stored.status,
    expiresAt: stored.expiresAt,
    emit,
  });

  console.log(
    `[escalation] guardian level ${notified ? 'notified' : 'emission withheld'} for SOS ${sosId}`
  );

  // §5 order: persist -> notify the guardian -> tell the OWNER the guardian
  // stage is waiting (sos:guardian-notified, owner's private room).
  const guardianName = await resolveUserName(guardianRepository, stored.targetId);
  await emitLifecycleGuardianNotified({
    sosId,
    ownerUserId: ownerId,
    guardian: { userId: stored.targetId, name: guardianName },
    notifiedAt: stored.notifiedAt,
    expiresAt: stored.expiresAt,
    emit,
  });

  return toSummary(updated, stored);
}

const ACKNOWLEDGEABLE_STATUSES = [SOS_STATUS.ACTIVE, SOS_STATUS.ESCALATING];

/**
 * Full validation for one acknowledgement attempt, shared by the pre-write
 * path and the post-race re-read, so a request that lost a race reports the
 * exact state that beat it (409) instead of a generic conflict.
 *
 * Order follows the existing acknowledge conventions in sos.service.js and
 * the responder route contract: SOS first (404 / 409), then escalation level
 * (409), then target authorization (403) — the caller is only ever compared
 * against persisted escalation state, never against anything the client sent.
 *
 * `responderId` is the optional `:responderId` path param of
 * POST /:id/responders/:responderId/acknowledge. When present it must match
 * the authenticated caller, so a responder can never acknowledge through
 * another responder's URL; it is checked before notification membership, so
 * the URL is never trusted on its own.
 *
 * Returns { currentIndex, current } for the atomic write.
 */
const validateAcknowledgement = async ({ sos, level, userId, relationships, responderId }) => {
  if (!sos) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (sos.status === SOS_STATUS.ACKNOWLEDGED) {
    throw ApiError.conflict('SOS_ALREADY_ACKNOWLEDGED', 'This SOS has already been acknowledged');
  }

  if (!ACKNOWLEDGEABLE_STATUSES.includes(sos.status)) {
    throw ApiError.conflict(
      'SOS_NOT_ACKNOWLEDGEABLE',
      `Acknowledgement is only allowed for an ACTIVE or ESCALATING SOS (current: ${sos.status})`
    );
  }

  const levels = Array.isArray(sos.escalation?.levels) ? sos.escalation.levels : [];
  const currentIndex = Number(sos.escalation?.currentLevel ?? 0);
  const current = levels[currentIndex];

  if (!current) {
    throw ApiError.conflict(
      'ESCALATION_NOT_PENDING',
      'There is no escalation level to acknowledge'
    );
  }

  if (current.type !== level) {
    throw ApiError.conflict(
      'ESCALATION_LEVEL_MISMATCH',
      `The current escalation level is ${current.type}, not ${level}`
    );
  }

  if (current.status !== ESCALATION_LEVEL_STATUS.PENDING) {
    if (current.status === ESCALATION_LEVEL_STATUS.ACKNOWLEDGED) {
      throw ApiError.conflict(
        'ESCALATION_ALREADY_ACKNOWLEDGED',
        'This escalation level has already been acknowledged'
      );
    }

    throw ApiError.conflict(
      'ESCALATION_ALREADY_PROGRESS',
      `Only a PENDING escalation can be acknowledged (current: ${current.status})`
    );
  }

  if (level === ESCALATION_LEVEL_TYPE.GUARDIAN) {
    if (!current.targetId || String(current.targetId) !== String(userId)) {
      throw ApiError.forbidden(
        'SOS_RECIPIENT_NOT_AUTHORIZED',
        'You are not the notified guardian for this SOS'
      );
    }

    // The relationship must still exist AND still be active: a guardian who
    // was removed or blocked after being notified cannot acknowledge.
    const relationship = await relationships.findRelationship(sos.userId, userId);

    if (!relationship || relationship.status !== GUARDIAN_STATUS.ACTIVE) {
      throw ApiError.forbidden(
        'SOS_RECIPIENT_NOT_AUTHORIZED',
        'Your guardian relationship is no longer active'
      );
    }
  } else {
    if (responderId !== undefined && String(responderId) !== String(userId)) {
      throw ApiError.forbidden(
        'SOS_RESPONDER_IDENTITY_MISMATCH',
        'You can only acknowledge as the responder identity you are authenticated as'
      );
    }

    const notified = Array.isArray(current.notifiedResponders)
      ? current.notifiedResponders.map(String)
      : [];

    if (!notified.includes(String(userId))) {
      throw ApiError.forbidden(
        'SOS_RECIPIENT_NOT_AUTHORIZED',
        'You are not a notified responder for this SOS'
      );
    }
  }

  return { currentIndex, current };
};

/**
 * Acknowledges the CURRENT escalation level (guardian or nearby responder).
 *
 * Validates against persisted state only (§6-§8): the SOS must be
 * acknowledgeable, the requested `level` must be the current level, and that
 * level must be PENDING. The caller must be that level's notified target —
 * for a guardian additionally backed by a still-ACTIVE guardian
 * relationship; for a responder by membership in `notifiedResponders`
 * (prototype: no geospatial discovery, the persisted list is the truth).
 *
 * One atomic conditional update decides the transition (PENDING ->
 * ACKNOWLEDGED, loser gets null), then, and only then: the pending timeout
 * is cancelled and the owner's room is notified — database first, sockets
 * second. The SOS itself moves to ACKNOWLEDGED through the existing
 * acknowledgement rule (required by /:id/resolve); it is NEVER resolved or
 * escalated to the next level here — only timeouts move escalation forward.
 *
 * Returns `{ sosId, level, status, acknowledgedBy, acknowledgedAt }`.
 */
export async function acknowledgeEscalation({
  sosId,
  userId,
  level,
  responderId,
  repository = sosRepository,
  relationships = relationshipRepository,
  profiles = callRepository,
  emit = emitToUserRoom,
  cancelTimeout = cancelLevelTimeout,
}) {
  console.log(`[escalation] acknowledge requested for SOS ${sosId} (${level})`);

  const sos = await repository.findById(sosId);
  const { currentIndex } = await validateAcknowledgement({
    sos,
    level,
    userId,
    relationships,
    responderId,
  });

  const respondedAt = new Date();
  const updated = await repository.acknowledgeEscalationLevel({
    sosId,
    userId: sos.userId,
    levelIndex: currentIndex,
    levelType: level,
    target: userId,
    respondedAt,
  });

  if (!updated) {
    const latest = await repository.findById(sosId);

    try {
      await validateAcknowledgement({ sos: latest, level, userId, relationships, responderId });
    } catch (err) {
      console.log(`[escalation] acknowledge lost a race for SOS ${sosId}: ${err.code}`);
      throw err;
    }

    throw ApiError.conflict('SOS_ACKNOWLEDGE_CONFLICT', 'The escalation could not be acknowledged');
  }

  const stored = updated.escalation.levels[currentIndex];

  // The level is no longer waiting for a response: stop its timeout before
  // notifying anyone (a stale handle here is harmless — the timer callback
  // re-validates atomically — but cancelling keeps the registry honest).
  cancelTimeout(sosId);

  // Prototype responder ids are not real user accounts, so the profile lookup
  // misses for them: fall back to the responder service's hardcoded display
  // name (single source of truth for the prototype dataset).
  const actorName =
    (await resolveUserName(profiles, userId)) ??
    (level === ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER ? findResponderName(userId) : null);

  if (level === ESCALATION_LEVEL_TYPE.GUARDIAN) {
    await emitGuardianAcknowledged({
      sosId,
      ownerUserId: updated.userId,
      guardian: { userId, name: actorName },
      acknowledgedAt: stored.respondedAt,
      emit,
    });
    // Lifecycle layer (§6): the same acknowledged transition, owner room only,
    // after the detailed event — acknowledgement never resolves the SOS.
    await emitLifecycleGuardianAcknowledged({
      sosId,
      ownerUserId: updated.userId,
      guardian: { userId, name: actorName },
      acknowledgedAt: stored.respondedAt,
      emit,
    });
  } else {
    await emitResponderAcknowledged({
      sosId,
      ownerUserId: updated.userId,
      responder: { responderId: userId, name: actorName },
      acknowledgedAt: stored.respondedAt,
      emit,
    });
    // Responder channel (§10-§11): the owner's room also hears the
    // responder-specific acknowledgement — same write, same payload contract,
    // after the detailed event. Acknowledgement means a responder accepted
    // responsibility; it never resolves the SOS (§12) and never escalates.
    await emitResponderSosAcknowledged({
      sosId,
      ownerUserId: updated.userId,
      responder: { responderId: userId, name: actorName },
      acknowledgedAt: stored.respondedAt,
      emit,
    });
  }

  console.log(`[escalation] ${level} level acknowledged for SOS ${sosId}`);

  return {
    sosId: String(sosId),
    level,
    status: ESCALATION_LEVEL_STATUS.ACKNOWLEDGED,
    acknowledgedBy: String(userId),
    acknowledgedAt: stored.respondedAt,
  };
}

/**
 * POST /:id/responders/:responderId/acknowledge — a notified responder
 * explicitly accepting the nearby-responder escalation.
 *
 * The whole state machine already exists in acknowledgeEscalation (SOS state
 * gates, current level must be NEARBY_RESPONDER and PENDING, `:responderId`
 * bound to the authenticated caller, membership in `notifiedResponders`, one
 * atomic PENDING -> ACKNOWLEDGED write, timeout cancellation, then
 * `sos:responder:acknowledged` + `responder:sos-acknowledged` to the owner's
 * private room). This wrapper is
 * the thin endpoint entry point: it pins the level so a client can never
 * acknowledge a guardian or police level through a responder URL, and hands
 * the path param to the shared validator (checked after the 404 / 409
 * gates, before membership, exactly like the rest of the contract).
 *
 * It never resolves the SOS, never escalates to police and never contacts
 * anyone else: acknowledgement only means a responder responded.
 */
export async function acknowledgeResponderNotification({
  sosId,
  userId,
  responderId,
  ...dependencies
}) {
  console.log(`[escalation] responder acknowledgement requested for SOS ${sosId}`);

  return acknowledgeEscalation({
    sosId,
    userId,
    responderId,
    ...dependencies,
    // Pinned last: no caller can route another level through this endpoint.
    level: ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
  });
}

/** The POST /:id/responders/notify answer — one shape for every outcome. */
const responderSummary = (sos, level) => ({
  sosId: String(sos?._id ?? sos?.sosId ?? ''),
  level: ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
  radiusKm: PROTOTYPE_RESPONDER_RADIUS_KM,
  notifiedResponders: Array.isArray(level?.notifiedResponders)
    ? level.notifiedResponders.map(String)
    : [],
  status: level?.status ?? null,
  expiresAt: level?.expiresAt ?? null,
});

/**
 * Decides what a responder-notify request should do given the document as it
 * stands now, following the same shape as classifyExisting for the guardian
 * level:
 *   error  -> throw (refuse the request)
 *   replay -> 200 with the existing PENDING responder level (no write, no
 *             timer, no second notification batch)
 *   start  -> guardian TIMEOUT recorded, no second level yet: attempt the
 *             atomic write
 *
 * Order: SOS state first (404 / 409), then the guardian level (409), then an
 * already-existing responder/police level (409 / replay). Every decision reads
 * persisted state only — a client can never claim a state it does not have.
 */
const classifyResponderStart = (sos) => {
  const levels = Array.isArray(sos?.escalation?.levels) ? sos.escalation.levels : [];
  const guardian = levels[0];
  const next = levels[1];

  if (sos.status === SOS_STATUS.ACKNOWLEDGED) {
    return {
      kind: 'error',
      error: ApiError.conflict('SOS_ALREADY_ACKNOWLEDGED', 'This SOS has already been acknowledged'),
    };
  }

  if (sos.status !== SOS_STATUS.ACTIVE && sos.status !== SOS_STATUS.ESCALATING) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'SOS_NOT_ACTIVE',
        `Responder escalation can only be started for an ACTIVE or ESCALATING SOS (current: ${sos.status})`
      ),
    };
  }

  if (!guardian || guardian.type !== ESCALATION_LEVEL_TYPE.GUARDIAN) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_GUARDIAN_NOT_TIMED_OUT',
        'Guardian escalation must exist and time out before responders can be notified'
      ),
    };
  }

  if (guardian.status === ESCALATION_LEVEL_STATUS.ACKNOWLEDGED) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_ALREADY_ACKNOWLEDGED',
        'Guardian escalation has already been acknowledged'
      ),
    };
  }

  if (guardian.status !== ESCALATION_LEVEL_STATUS.TIMEOUT) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_GUARDIAN_NOT_TIMED_OUT',
        `Guardian escalation has not timed out yet (current: ${guardian.status})`
      ),
    };
  }

  if (next) {
    if (
      next.type === ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER &&
      next.status === ESCALATION_LEVEL_STATUS.PENDING
    ) {
      return { kind: 'replay', level: next };
    }

    if (
      next.type === ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER &&
      next.status === ESCALATION_LEVEL_STATUS.ACKNOWLEDGED
    ) {
      return {
        kind: 'error',
        error: ApiError.conflict(
          'ESCALATION_ALREADY_ACKNOWLEDGED',
          'Responder escalation has already been acknowledged'
        ),
      };
    }

    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_ALREADY_PROGRESS',
        'Responder escalation has already been started or the escalation has moved on'
      ),
    };
  }

  return { kind: 'start' };
};

/**
 * Re-reads after a lost atomic write and answers with the state that won the
 * race: an existing PENDING responder level replays idempotently, anything
 * else surfaces the precise conflict.
 */
const resolveLostResponderStart = async ({ sosId, repository }) => {
  const latest = await repository.findById(sosId);

  if (!latest) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  const raced = classifyResponderStart(latest);

  if (raced.kind === 'replay') {
    console.log(`[escalation] concurrent responder notify replayed existing level for SOS ${sosId}`);
    return responderSummary(latest, raced.level);
  }

  if (raced.kind === 'error') throw raced.error;

  throw ApiError.conflict(
    'ESCALATION_RESPONDER_CONFLICT',
    'The responder escalation could not be started'
  );
};

/**
 * Starts the prototype nearby-responder escalation phase for one SOS whose
 * guardian level already timed out (POST /:id/responders/notify).
 *
 * The single entry point for this transition — the HTTP controller is only
 * one caller; the escalation workflow calls this same function after the
 * guardian timeout, so there is exactly one responder-escalation path.
 *
 * Order (§17): validate SOS -> verify guardian TIMEOUT -> read the hardcoded
 * responders from the responder service (never a second copy of the data,
 * never an HTTP self-call) -> ONE atomic conditional update -> arm the
 * responder timeout with the existing timer registry -> re-read to confirm
 * the level is still valid -> emit `sos:responder:notify` to each responder's
 * private room -> respond. Database first, sockets second, always.
 *
 * Deliberately does NOT: resolve the SOS, acknowledge any level, rank
 * responders by distance, run a geospatial query, or escalate to police —
 * the next level belongs to the police escalation workflow, and an
 * acknowledgement only ever comes from POST /:id/responders/:responderId/
 * acknowledge.
 *
 * Returns `{ sosId, level, radiusKm, notifiedResponders, status, expiresAt }`.
 * When no prototype responder is eligible the level is recorded as TIMEOUT
 * (the same convention as a guardian level with nobody reachable), so the
 * escalation is never stuck and the next stage can proceed — nothing is
 * notified, no timer is armed, no acknowledgement is faked.
 *
 * Throws 404 (missing), 403 (foreign SOS) or 409 (wrong state, guardian not
 * timed out, already escalated/acknowledged). A duplicate request replays the
 * existing PENDING level without writing, timing out or notifying twice.
 */
export async function startResponderEscalation({
  sosId,
  userId,
  repository = sosRepository,
  profiles = callRepository,
  eligibleResponders = filterEligibleResponders,
  emit = emitToUserRoom,
  scheduleTimeout: schedule = scheduleTimeout,
  timeoutMs = null,
}) {
  console.log(`[escalation] responder escalation requested for SOS ${sosId}`);

  const current = await repository.findById(sosId);

  if (!current) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (String(current.userId) !== String(userId)) {
    throw ApiError.forbidden('SOS_NOT_AUTHORIZED', 'You do not own this SOS event');
  }

  const existing = classifyResponderStart(current);

  if (existing.kind === 'error') {
    console.log(
      `[escalation] responder escalation refused for SOS ${sosId}: ${existing.error.code}`
    );
    throw existing.error;
  }

  if (existing.kind === 'replay') {
    console.log(`[escalation] duplicate responder escalation ignored for SOS ${sosId}`);
    return responderSummary(current, existing.level);
  }

  console.log(`[escalation] guardian timeout verified for SOS ${sosId}`);

  const maxWaitMs = timeoutMs ?? env.escalation.responderTimeoutSeconds * 1000;
  const ownerId = current.userId;
  const eligible = eligibleResponders();

  console.log(`[escalation] prototype responders loaded for SOS ${sosId}: ${eligible.length} eligible`);

  const notifiedAt = new Date();
  const level = eligible.length
    ? {
        type: ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
        status: ESCALATION_LEVEL_STATUS.PENDING,
        targetId: null,
        notifiedResponders: eligible.map((responder) => responder.id),
        notifiedAt,
        respondedAt: null,
        expiresAt: new Date(notifiedAt.getTime() + maxWaitMs),
      }
    : {
        // Nobody to notify: record the level as already progressed (same
        // convention as a guardian level with no reachable guardian) so the
        // escalation can move on instead of waiting forever.
        type: ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
        status: ESCALATION_LEVEL_STATUS.TIMEOUT,
        targetId: null,
        notifiedResponders: [],
        notifiedAt: null,
        respondedAt: null,
        expiresAt: null,
      };

  const updated = await repository.startResponderEscalation({
    sosId,
    userId: ownerId,
    level,
  });

  if (!updated) {
    return resolveLostResponderStart({ sosId, repository });
  }

  const stored = updated.escalation.levels[1];

  if (stored.status === ESCALATION_LEVEL_STATUS.TIMEOUT) {
    console.log(`[escalation] no eligible responders for SOS ${sosId}; TIMEOUT level recorded`);
    return responderSummary(updated, stored);
  }

  // Only the atomic-write winner registers the timer, so a duplicate request
  // can never stack a second timeout on the same level.
  armLevelTimeout({
    sosId,
    task: () => runResponderTimeout({ sosId, repository, emit }),
    ms: maxWaitMs,
    schedule,
  });
  console.log(`[escalation] responder timeout registered for SOS ${sosId} in ${maxWaitMs}ms`);

  // Final state check before anyone is told: a SOS cancelled or resolved
  // while this request was in flight must not notify responders.
  const persisted = await repository.findById(sosId);
  const stillValid =
    persisted &&
    (persisted.status === SOS_STATUS.ACTIVE || persisted.status === SOS_STATUS.ESCALATING) &&
    persisted.escalation?.levels?.[1]?.status === ESCALATION_LEVEL_STATUS.PENDING;

  if (!stillValid) {
    console.log(`[escalation] responder notification withheld for SOS ${sosId} (no longer active)`);
    return responderSummary(updated, stored);
  }

  // §8/§16: report the stage move to the owner BEFORE this stage's
  // per-recipient notifications. `previousLevel` is the persisted guardian
  // level; `GUARDIAN_TIMEOUT` is its persisted TIMEOUT status, which
  // classifyResponderStart guaranteed before the write was even attempted.
  await emitLifecycleEscalating({
    sosId,
    ownerUserId: ownerId,
    currentLevel: stored.type,
    previousLevel: updated.escalation.levels[0]?.type ?? null,
    reason: ESCALATION_REASONS.GUARDIAN_TIMEOUT,
    escalatedAt: stored.notifiedAt,
    emit,
  });

  const ownerName = await resolveUserName(profiles, ownerId);
  const recipients = await emitResponderNotify({
    sosId,
    responderIds: stored.notifiedResponders ?? [],
    user: { userId: ownerId, name: ownerName },
    location: persisted.location ?? null,
    radiusKm: PROTOTYPE_RESPONDER_RADIUS_KM,
    expiresAt: stored.expiresAt,
    emit,
  });

  // Responder channel of the Nearby Responder event contract (§3-§7): the
  // same persisted level, the same private responder rooms, the same §4
  // payload — emitted after the write winner's gate, best effort like every
  // other notification.
  const channelRecipients = await emitResponderSosNotification({
    sosId,
    responderIds: stored.notifiedResponders ?? [],
    user: { userId: ownerId, name: ownerName },
    location: persisted.location ?? null,
    radiusKm: PROTOTYPE_RESPONDER_RADIUS_KM,
    expiresAt: stored.expiresAt,
    emit,
  });

  console.log(
    `[escalation] responder level notified for SOS ${sosId} (${recipients} recipients, ${channelRecipients} responder-channel)`
  );

  return responderSummary(updated, stored);
}

/** The POST /:id/escalation/police answer — one shape for every outcome. */
const policeSummary = (sos, level) => ({
  sosId: String(sos?._id ?? sos?.sosId ?? ''),
  level: ESCALATION_LEVEL_TYPE.POLICE,
  status: ESCALATION_LEVEL_STATUS.NOTIFIED,
  policeStation: {
    id: level?.policeStation?.id ?? null,
    name: level?.policeStation?.name ?? null,
    phone: level?.policeStation?.phone ?? null,
  },
  escalatedAt: level?.escalatedAt ?? null,
});

/**
 * Decides what a police-escalation request should do given the document as it
 * stands now, following the same shape as classifyResponderStart:
 *   error  -> throw (refuse the request)
 *   replay -> 200 with the existing NOTIFIED police level (no write, no
 *             second station notification)
 *   start  -> guardian TIMEOUT + responder TIMEOUT and no third level yet:
 *             attempt the atomic write
 *
 * Order: SOS state first (404 / 409), then the guardian level (409), then the
 * responder level (409), then an already-existing police level (409 / replay).
 * Every decision reads persisted state only — a client can never claim a
 * stage it has not reached, and an active SOS is never "blindly" sent to
 * police.
 */
const classifyPoliceEscalation = (sos) => {
  const levels = Array.isArray(sos?.escalation?.levels) ? sos.escalation.levels : [];
  const guardian = levels[0];
  const responder = levels[1];
  const police = levels[2];

  if (sos.status === SOS_STATUS.ACKNOWLEDGED) {
    return {
      kind: 'error',
      error: ApiError.conflict('SOS_ALREADY_ACKNOWLEDGED', 'This SOS has already been acknowledged'),
    };
  }

  if (sos.status !== SOS_STATUS.ACTIVE && sos.status !== SOS_STATUS.ESCALATING) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'SOS_NOT_ACTIVE',
        `Police escalation can only be started for an ACTIVE or ESCALATING SOS (current: ${sos.status})`
      ),
    };
  }

  if (!guardian || guardian.type !== ESCALATION_LEVEL_TYPE.GUARDIAN) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_GUARDIAN_NOT_TIMED_OUT',
        'Guardian escalation must exist and time out before police escalation'
      ),
    };
  }

  if (guardian.status === ESCALATION_LEVEL_STATUS.ACKNOWLEDGED) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_ALREADY_ACKNOWLEDGED',
        'Guardian escalation has already been acknowledged'
      ),
    };
  }

  if (guardian.status !== ESCALATION_LEVEL_STATUS.TIMEOUT) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_GUARDIAN_NOT_TIMED_OUT',
        `Guardian escalation has not timed out yet (current: ${guardian.status})`
      ),
    };
  }

  if (!responder || responder.type !== ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_POLICE_NOT_ALLOWED',
        'Nearby responder escalation must run before police escalation'
      ),
    };
  }

  if (responder.status === ESCALATION_LEVEL_STATUS.ACKNOWLEDGED) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_ALREADY_ACKNOWLEDGED',
        'A nearby responder has already acknowledged this SOS'
      ),
    };
  }

  if (responder.status !== ESCALATION_LEVEL_STATUS.TIMEOUT) {
    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_POLICE_NOT_ALLOWED',
        `Police escalation requires the responder escalation to finish (current: ${responder.status})`
      ),
    };
  }

  if (police) {
    if (
      police.type === ESCALATION_LEVEL_TYPE.POLICE &&
      police.status === ESCALATION_LEVEL_STATUS.NOTIFIED
    ) {
      return { kind: 'replay', level: police };
    }

    return {
      kind: 'error',
      error: ApiError.conflict(
        'ESCALATION_ALREADY_PROGRESS',
        'Police escalation has already been started or the escalation has moved on'
      ),
    };
  }

  return { kind: 'start' };
};

/**
 * Re-reads after a lost atomic write and answers with the state that won the
 * race: an existing NOTIFIED police level replays idempotently (no second
 * notification), anything else surfaces the precise conflict.
 */
const resolveLostPoliceStart = async ({ sosId, repository }) => {
  const latest = await repository.findById(sosId);

  if (!latest) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  const raced = classifyPoliceEscalation(latest);

  if (raced.kind === 'replay') {
    console.log(`[escalation] concurrent police escalation replayed existing level for SOS ${sosId}`);
    return policeSummary(latest, raced.level);
  }

  if (raced.kind === 'error') throw raced.error;

  throw ApiError.conflict(
    'ESCALATION_POLICE_CONFLICT',
    'The police escalation could not be started'
  );
};

/**
 * Escalates one SOS to the prototype police station
 * (POST /:id/escalation/police).
 *
 * The single entry point for this transition — the HTTP controller is only
 * one caller; a responder-timeout handler can call this same function later,
 * so there is exactly one police-escalation path.
 *
 * Order (§17): validate SOS -> verify guardian TIMEOUT and responder TIMEOUT
 * -> read the hardcoded station from the police service (never a client
 * value, never a second copy of the data, never a lookup) -> ONE atomic
 * conditional update -> re-read to confirm the state is still valid -> emit
 * `sos:police:escalated` to the owner's private room -> respond. Database
 * first, sockets second, always; if the write fails, nobody is told.
 *
 * Deliberately does NOT: resolve or cancel the SOS, acknowledge any level,
 * create a police acknowledgement, run a geospatial query, search for a
 * station, contact any real authority, or arm a timer — the stored level is
 * a prototype escalation state only.
 *
 * Returns `{ sosId, level, status, policeStation, escalatedAt }`. A duplicate
 * or concurrent request replays the existing NOTIFIED level without writing
 * or notifying again.
 *
 * Throws 404 (missing), 403 (foreign SOS) or 409 (wrong SOS state, guardian
 * not timed out, responder stage unfinished, already escalated).
 */
export async function escalateToPolice({
  sosId,
  userId,
  repository = sosRepository,
  policeStation = getPrototypePoliceStation,
  emit = emitToUserRoom,
}) {
  console.log(`[escalation] police escalation requested for SOS ${sosId}`);

  const current = await repository.findById(sosId);

  if (!current) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (String(current.userId) !== String(userId)) {
    throw ApiError.forbidden('SOS_NOT_AUTHORIZED', 'You do not own this SOS event');
  }

  const existing = classifyPoliceEscalation(current);

  if (existing.kind === 'error') {
    console.log(`[escalation] police escalation refused for SOS ${sosId}: ${existing.error.code}`);
    throw existing.error;
  }

  if (existing.kind === 'replay') {
    console.log(`[escalation] duplicate police escalation ignored for SOS ${sosId}`);
    return policeSummary(current, existing.level);
  }

  const { source, station } = policeStation();

  console.log(`[escalation] prototype police station loaded for SOS ${sosId}: ${station.id}`);

  const escalatedAt = new Date();
  const level = {
    type: ESCALATION_LEVEL_TYPE.POLICE,
    status: ESCALATION_LEVEL_STATUS.NOTIFIED,
    targetId: station.id,
    policeStation: { id: station.id, name: station.name, phone: station.phone },
    source,
    notifiedAt: escalatedAt,
    escalatedAt,
    respondedAt: null,
    expiresAt: null,
  };

  const updated = await repository.escalateToPolice({
    sosId,
    userId: current.userId,
    level,
  });

  if (!updated) {
    return resolveLostPoliceStart({ sosId, repository });
  }

  const stored = updated.escalation.levels[2];

  // Final state check before anyone is told: a SOS cancelled or resolved
  // while this request was in flight must not produce an escalation event.
  const persisted = await repository.findById(sosId);
  const stillValid =
    persisted &&
    (persisted.status === SOS_STATUS.ACTIVE || persisted.status === SOS_STATUS.ESCALATING) &&
    persisted.escalation?.levels?.[2]?.status === ESCALATION_LEVEL_STATUS.NOTIFIED;

  if (!stillValid) {
    console.log(`[escalation] police escalation event withheld for SOS ${sosId} (no longer active)`);
    return policeSummary(updated, stored);
  }

  // §8/§16: the stage move is reported to the owner first, then the station
  // escalation event. `previousLevel` is the persisted responder level and
  // `RESPONDER_TIMEOUT` its persisted TIMEOUT status, guaranteed by
  // classifyPoliceEscalation before the write was attempted.
  await emitLifecycleEscalating({
    sosId,
    ownerUserId: updated.userId,
    currentLevel: stored.type,
    previousLevel: updated.escalation.levels[1]?.type ?? null,
    reason: ESCALATION_REASONS.RESPONDER_TIMEOUT,
    escalatedAt: stored.escalatedAt,
    emit,
  });

  await emitPoliceEscalated({
    sosId,
    ownerUserId: updated.userId,
    policeStation: stored.policeStation,
    escalatedAt: stored.escalatedAt,
    emit,
  });

  console.log(`[escalation] police level notified for SOS ${sosId} (${stored.policeStation?.id})`);

  return policeSummary(updated, stored);
}

/** First persisted level of a given type — never a computed/derived state. */
const findLevel = (levels, type) => levels.find((level) => level?.type === type) ?? null;

/**
 * Transforms the persisted escalation document into the frontend-safe state
 * returned by GET /:id/escalation. Pure: reads fields, invents nothing — no
 * timer reasoning, no online-status checks, no clock, no responder/police
 * lookup, no location.
 *
 * Shape (stable keys, null defaults — same convention as toSosResponse):
 *   { sosId, currentLevel, status, guardian, nearbyResponders, police }
 *
 * A level that does not exist yet reports PENDING (nothing has happened
 * yet); `currentLevel` / `status` describe the persisted current level and
 * are null when the SOS has no escalation history at all.
 */
const toEscalationState = (sos) => {
  const levels = Array.isArray(sos?.escalation?.levels) ? sos.escalation.levels : [];
  const current = levels[Number(sos?.escalation?.currentLevel ?? 0)] ?? null;

  const guardian = findLevel(levels, ESCALATION_LEVEL_TYPE.GUARDIAN);
  const responder = findLevel(levels, ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER);
  const police = findLevel(levels, ESCALATION_LEVEL_TYPE.POLICE);

  return {
    sosId: String(sos._id),
    currentLevel: current?.type ?? null,
    status: current?.status ?? null,
    guardian: {
      status: guardian?.status ?? ESCALATION_LEVEL_STATUS.PENDING,
      notifiedAt: guardian?.notifiedAt ?? null,
      respondedAt: guardian?.respondedAt ?? null,
    },
    nearbyResponders: {
      status: responder?.status ?? ESCALATION_LEVEL_STATUS.PENDING,
      notified: Array.isArray(responder?.notifiedResponders)
        ? responder.notifiedResponders.length
        : 0,
      acknowledgedBy: responder?.targetId ? String(responder.targetId) : null,
      notifiedAt: responder?.notifiedAt ?? null,
      respondedAt: responder?.respondedAt ?? null,
    },
    police: {
      status: police?.status ?? ESCALATION_LEVEL_STATUS.PENDING,
      notifiedAt: police?.notifiedAt ?? null,
      escalatedAt: police?.escalatedAt ?? null,
      policeStation: police?.policeStation
        ? {
            id: police.policeStation.id ?? null,
            name: police.policeStation.name ?? null,
            phone: police.policeStation.phone ?? null,
          }
        : null,
    },
  };
};

/**
 * GET /:id/escalation — the persisted escalation state, read-only
 * (frontend recovery after a dropped socket, refresh or reconnect).
 *
 * Exactly one scoped query (`findByIdAndUserId`) — the same ownership
 * convention as GET /:id, so a foreign SOS and a missing SOS return the
 * identical 404 and nothing can be enumerated. It never writes, never arms
 * or stops a timer, never notifies anybody, never starts another level and
 * never emits a socket event: Socket.IO owns real-time updates, this endpoint
 * only answers with what the database already holds — for every SOS status,
 * including CANCELLED and RESOLVED.
 */
export async function getEscalationState({ sosId, userId, repository = sosRepository }) {
  console.log(`[escalation] state requested for SOS ${sosId}`);

  const sos = await repository.findByIdAndUserId(sosId, userId);

  if (!sos) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  return toEscalationState(sos);
}
