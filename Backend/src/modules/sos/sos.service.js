import { ApiError } from '../../utils/ApiError.js';
import * as sosRepository from './sos.repository.js';
import * as sosDependencies from './sos.dependencies.js';
import * as callRepository from '../calling/call.repository.js';
import { emitToUserRoom } from '../../sockets/index.js';
import { startGuardianEscalation, resolveUserName } from './escalation.service.js';
import {
  emitVerificationRequired,
  emitSosConfirmed,
  emitSosCancelled,
  emitSosTimeout,
  emitLifecycleActivated,
  emitLifecycleGuardianAcknowledged,
  emitLifecycleResolved,
} from './sos.events.js';
import {
  DEFAULT_VERIFICATION_TIMEOUT_SECONDS,
  ESCALATION_LEVEL_TYPE,
  SOS_STATUS,
  VERIFICATION_REASONS,
} from './sos.constants.js';

const resolveTimeoutSeconds = (settings) => {
  const raw = Number(settings?.sosTimeoutSeconds);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_VERIFICATION_TIMEOUT_SECONDS;
};

/**
 * In-process registry of armed VERIFICATION timeouts, keyed by SOS id — the
 * same single-timer mechanism (and the same discipline) the escalation
 * service uses for level timeouts, kept in the module that owns the
 * verification state machine (§2). An SOS can never have a verification timer
 * and an escalation-level timer at the same time: verification happens before
 * any level exists, and confirm/cancel drop the handle before the SOS can
 * escalate — so one registry keyed by SOS id stays unambiguous.
 */
const verificationTimeouts = new Map();

/**
 * Stops the pending verification timeout for this SOS. Returns true when an
 * armed timer was cancelled. Never throws: a failed cancellation must not
 * fail an already-persisted confirmation/cancellation — the atomic
 * status check inside runVerificationTimeout is the backstop (§12: do not
 * rely solely on clearTimeout()).
 */
const cancelVerificationTimeout = (sosId) => {
  const key = String(sosId);
  const handle = verificationTimeouts.get(key);

  if (handle === undefined) return false;
  verificationTimeouts.delete(key);

  try {
    clearTimeout(handle);
  } catch (err) {
    console.warn(`[sos] failed to cancel verification timeout: ${err?.message || err}`);
  }

  return true;
};

/** Replaces any previously armed verification timeout for this SOS. */
const armVerificationTimeout = ({ sosId, task, ms, schedule }) => {
  cancelVerificationTimeout(sosId);

  const handle = schedule(task, ms);

  if (handle !== undefined && handle !== null) {
    verificationTimeouts.set(String(sosId), handle);
  }

  return handle;
};

/**
 * In-process scheduler. Unref'd so it never keeps the process alive; a
 * verification timeout surviving a restart is deliberately out of scope for
 * the prototype (same rule as the escalation timers). Scheduling failures are
 * logged, never thrown: the SOS with its persisted expiry is already durable
 * without the timer.
 */
const scheduleVerificationTimeout = (fn, ms) => {
  try {
    const timer = setTimeout(() => {
      Promise.resolve(fn()).catch((err) =>
        console.warn(`[sos] verification timeout task failed: ${err?.message || err}`)
      );
    }, ms);

    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  } catch (err) {
    console.warn(`[sos] failed to schedule verification timeout: ${err?.message || err}`);
    return null;
  }
};

/**
 * The verification timer's callback: no response before `verification.expiresAt`
 * means silence defaults to activation (§7 / §21).
 *
 * Order (§10):
 *   1. drop the fired handle (it is no longer cancellable);
 *   2. ONE conditional update VERIFYING -> ACTIVE — a confirmation or a
 *      cancellation that already won leaves the filter unmatched, so this
 *      returns false and does nothing (#24 / #25); a duplicate firing of the
 *      same timer is refused the same way (#11);
 *   3. only after the write: emit `sos:timeout`, then the lifecycle
 *      `sos:activated` (never for a failed or lost transition; §16 order:
 *      timeout -> activated -> guardian escalation);
 *   4. hand the now-ACTIVE SOS to the EXISTING escalation workflow (#8): the
 *      escalation service keeps guardian selection, responder/police levels
 *      and their timers — nothing is duplicated here. A failure here never
 *      rolls the activation back: the database is authoritative and the
 *      escalation can still be started explicitly via
 *      POST /api/v1/sos/:id/escalation/start.
 *
 * Never throws (nothing awaits this from a request); returns whether the
 * transition happened.
 */
export async function runVerificationTimeout({
  sosId,
  repository = sosRepository,
  emit = emitToUserRoom,
  startEscalation = startGuardianEscalation,
}) {
  verificationTimeouts.delete(String(sosId));

  try {
    const timedOutAt = new Date();

    const updated = await repository.activateOnVerificationTimeout({ sosId, timedOutAt });

    if (!updated) {
      console.log(
        `[sos] verification timeout skipped for SOS ${sosId} (already confirmed, cancelled or gone)`
      );
      return false;
    }

    console.log(`[sos] verification timed out for SOS ${sosId}; SOS activated`);

    await emitSosTimeout({ sos: updated, timedOutAt, emit });
    await emitLifecycleActivated({
      sos: updated,
      previousStatus: SOS_STATUS.VERIFYING,
      activatedAt: timedOutAt,
      emit,
    });

    try {
      await startEscalation({ sosId, userId: updated.userId });
    } catch (err) {
      console.warn(
        `[sos] post-timeout escalation start failed for SOS ${sosId}: ${err?.message || err}`
      );
    }

    return true;
  } catch (err) {
    console.warn(`[sos] verification timeout failed for SOS ${sosId}: ${err?.message || err}`);
    return false;
  }
}

/**
 * Creates a new SOS in VERIFYING state.
 *
 * Backend-authoritative verification (§3–§4): the persisted `verification.expiresAt`
 * and the server-side timer armed below always come from the same
 * `timeoutSeconds`, and `sos:verification-required` is emitted to the owner's
 * private room only after the document exists. The frontend countdown is
 * visual only (§21).
 *
 * Returns { created: true, sos } or { created: false, sos: <existing unresolved SOS> }.
 * A duplicate create arms nothing and emits nothing (#11).
 */
export async function createSOS({
  userId,
  payload,
  repository = sosRepository,
  dependencies = sosDependencies,
  emit = emitToUserRoom,
  scheduleTimeout: schedule = scheduleVerificationTimeout,
  startEscalation = startGuardianEscalation,
}) {
  const { triggerType, safetySessionId, triggerData, location } = payload;

  if (safetySessionId) {
    const session = await dependencies.findSafetySessionById(safetySessionId);

    if (!session) {
      throw ApiError.notFound('SAFETY_SESSION_NOT_FOUND', 'Safety session not found');
    }

    if (String(session.userId) !== String(userId)) {
      throw ApiError.forbidden(
        'SAFETY_SESSION_FORBIDDEN',
        'Safety session does not belong to the authenticated user'
      );
    }
  }

  const safetySessionIds = safetySessionId ? [safetySessionId, null] : null;
  const existing = await repository.findUnresolvedSOS({ userId, safetySessionIds });

  if (existing) {
    return { created: false, sos: existing };
  }

  const settings = await dependencies.getUserEmergencySettings(userId);
  const timeoutSeconds = resolveTimeoutSeconds(settings);
  const expiresAt = new Date(Date.now() + timeoutSeconds * 1000);

  const sos = await repository.createSOS({
    userId,
    safetySessionId: safetySessionId || null,
    triggerType,
    status: SOS_STATUS.VERIFYING,
    ...(triggerData ? { triggerData } : {}),
    location: location
      ? {
          lat: location.lat,
          lng: location.lng,
          ...(location.address ? { address: location.address } : {}),
        }
      : null,
    verification: {
      expiresAt,
      userResponse: null,
      respondedAt: null,
    },
    escalation: {
      currentLevel: 0,
      levels: [],
    },
  });

  // The timer is armed only AFTER the write, from the very timeoutSeconds
  // that produced expiresAt, and it re-validates the database state before
  // ever activating (§7: one conditional update, then emit, then escalate).
  armVerificationTimeout({
    sosId: sos._id,
    task: () => runVerificationTimeout({ sosId: sos._id, repository, emit, startEscalation }),
    ms: timeoutSeconds * 1000,
    schedule,
  });

  await emitVerificationRequired({ sos, timeoutSeconds, emit });

  return { created: true, sos };
}

/**
 * Read-only: returns the authenticated user's current unresolved SOS.
 * Never modifies documents and never applies verification-timeout transitions.
 */
export async function getActiveSOS({ userId, repository = sosRepository }) {
  const sos = await repository.findActiveByUserId(userId);

  return sos ? { active: true, sos } : { active: false, sos: null };
}

/**
 * Read-only: retrieves one SOS by id, scoped to the authenticated owner.
 * Works for every status. A foreign or missing SOS returns the same not-found error.
 */
export async function getSOSById({ sosId, userId, repository = sosRepository }) {
  const sos = await repository.findByIdAndUserId(sosId, userId);

  if (!sos) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  return sos;
}

const isVerificationExpired = (sos, now) => {
  const expiresAt = sos.verification?.expiresAt;
  return Boolean(expiresAt) && new Date(expiresAt).getTime() < now.getTime();
};

const TRANSITIONS = {
  confirm: { label: 'Confirmation', verb: 'confirmed', conflictCode: 'SOS_CONFIRM_CONFLICT' },
  cancel: { label: 'Cancellation', verb: 'cancelled', conflictCode: 'SOS_CANCEL_CONFLICT' },
};

/**
 * Builds the error explaining why a VERIFYING transition did not happen.
 * Called only after the atomic update missed, so ownership/state is re-read once.
 */
const buildTransitionError = async ({ repository, sosId, userId, now, action }) => {
  const current = await repository.findByIdAndUserId(sosId, userId);

  if (!current) {
    return ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (current.status !== SOS_STATUS.VERIFYING) {
    return ApiError.conflict(
      'SOS_NOT_VERIFYING',
      `${action.label} is only allowed while an SOS is VERIFYING (current: ${current.status})`
    );
  }

  if (isVerificationExpired(current, now)) {
    return ApiError.conflict('SOS_VERIFICATION_EXPIRED', 'The verification window has expired');
  }

  return ApiError.conflict(action.conflictCode, `The SOS could not be ${action.verb}`);
};

/**
 * Explicit user confirmation: VERIFYING -> ACTIVE.
 *
 * The transition is a single conditional update (status + expiry inside the
 * filter), so concurrent confirmations cannot double-transition the SOS.
 * Timeout-based activation is NOT performed here.
 *
 * Only after that write succeeds: the verification timer is cancelled (§12),
 * `sos:confirmed` is emitted to the owner's private room (§5/§10) and the
 * lifecycle `sos:activated` follows it (§16 ordering). A lost race or a
 * failed transition emits nothing (#30).
 */
export async function confirmSOS({
  sosId,
  userId,
  repository = sosRepository,
  emit = emitToUserRoom,
}) {
  const respondedAt = new Date();

  const updated = await repository.confirmAndActivate({ sosId, userId, respondedAt });

  if (updated) {
    cancelVerificationTimeout(sosId);
    await emitSosConfirmed({ sos: updated, confirmedAt: respondedAt, emit });
    await emitLifecycleActivated({
      sos: updated,
      previousStatus: SOS_STATUS.VERIFYING,
      activatedAt: respondedAt,
      emit,
    });
    return updated;
  }

  throw await buildTransitionError({
    repository,
    sosId,
    userId,
    now: respondedAt,
    action: TRANSITIONS.confirm,
  });
}

/**
 * Accidental trigger: VERIFYING -> CANCELLED.
 *
 * Same atomic conditional update as confirm, so a concurrent confirm/cancel
 * pair produces exactly one winner. Nobody is notified: a cancelled SOS
 * notifies nobody, no escalation level exists yet and none is ever started
 * (#13).
 *
 * Only after the write: cancel the verification timer (the old timer must
 * never activate the SOS later) and emit `sos:cancelled` (§6/§12).
 */
export async function cancelSOS({
  sosId,
  userId,
  repository = sosRepository,
  emit = emitToUserRoom,
}) {
  const respondedAt = new Date();

  const updated = await repository.cancelAndRecord({ sosId, userId, respondedAt });

  if (updated) {
    cancelVerificationTimeout(sosId);
    await emitSosCancelled({
      sos: updated,
      cancelledAt: respondedAt,
      reason: VERIFICATION_REASONS.USER_CANCELLED,
      emit,
    });
    return updated;
  }

  throw await buildTransitionError({
    repository,
    sosId,
    userId,
    now: respondedAt,
    action: TRANSITIONS.cancel,
  });
}

const ACKNOWLEDGEABLE_STATUSES = [SOS_STATUS.ACTIVE, SOS_STATUS.ESCALATING];

const isLevelAcked = (level) => level?.status === SOS_STATUS.ACKNOWLEDGED;

/**
 * Finds the escalation level this requester is allowed to acknowledge.
 * Returns the array index, or throws 403/409.
 */
const resolveAcknowledgingLevel = (sos, userId) => {
  const uid = String(userId);
  const levels = Array.isArray(sos.escalation?.levels) ? sos.escalation.levels : [];
  const currentLevel = Number(sos.escalation?.currentLevel ?? 0);

  const mine = levels
    .map((level, index) => ({ level, index }))
    .filter(({ level }) => level?.targetId !== undefined && level?.targetId !== null && String(level.targetId) === uid);

  if (mine.length === 0) {
    throw ApiError.forbidden(
      'SOS_RECIPIENT_NOT_AUTHORIZED',
      'You are not an authorized recipient for this SOS'
    );
  }

  const current = mine.find(({ index }) => index === currentLevel);
  const eligible =
    current && !isLevelAcked(current.level)
      ? current
      : mine.find(({ level }) => !isLevelAcked(level));

  if (!eligible) {
    throw ApiError.conflict('SOS_ALREADY_ACKNOWLEDGED', 'This SOS has already been acknowledged by you');
  }

  return eligible.index;
};

/**
 * Recipient acknowledgement: ACTIVE / ESCALATING -> ACKNOWLEDGED.
 *
 * The requester must be the target of the relevant escalation level.
 * Nothing else happens: no resolution, no next-level escalation. The ONLY
 * notification is the lifecycle `sos:guardian-acknowledged` when a GUARDIAN
 * level transitions (product spec §12: the owner gets a real-time update) —
 * a responder acknowledging through this endpoint stays silent here, the
 * dedicated responder flow owns its detailed events.
 */
export async function acknowledgeSOS({
  sosId,
  userId,
  repository = sosRepository,
  profiles = callRepository,
  emit = emitToUserRoom,
}) {
  const current = await repository.findById(sosId);

  if (!current) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (current.status === SOS_STATUS.ACKNOWLEDGED) {
    throw ApiError.conflict('SOS_ALREADY_ACKNOWLEDGED', 'This SOS has already been acknowledged');
  }

  if (!ACKNOWLEDGEABLE_STATUSES.includes(current.status)) {
    throw ApiError.conflict(
      'SOS_NOT_ACKNOWLEDGEABLE',
      `Acknowledgement is only allowed for an ACTIVE or ESCALATING SOS (current: ${current.status})`
    );
  }

  const levelIndex = resolveAcknowledgingLevel(current, userId);
  const respondedAt = new Date();

  const updated = await repository.acknowledgeByRecipient({ sosId, levelIndex, respondedAt });

  if (updated) {
    const storedLevel = updated.escalation?.levels?.[levelIndex];

    // Only the guardian stage has a lifecycle acknowledgement event, and only
    // after the atomic PENDING/whatever -> ACKNOWLEDGED write succeeded.
    if (storedLevel?.type === ESCALATION_LEVEL_TYPE.GUARDIAN) {
      const guardianName = await resolveUserName(profiles, userId);
      await emitLifecycleGuardianAcknowledged({
        sosId,
        ownerUserId: updated.userId,
        guardian: { userId, name: guardianName },
        acknowledgedAt: storedLevel.respondedAt ?? respondedAt,
        emit,
      });
    }

    return updated;
  }

  const latest = await repository.findById(sosId);

  if (!latest) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (latest.status === SOS_STATUS.ACKNOWLEDGED) {
    throw ApiError.conflict('SOS_ALREADY_ACKNOWLEDGED', 'This SOS has already been acknowledged');
  }

  if (!ACKNOWLEDGEABLE_STATUSES.includes(latest.status)) {
    throw ApiError.conflict(
      'SOS_NOT_ACKNOWLEDGEABLE',
      `Acknowledgement is only allowed for an ACTIVE or ESCALATING SOS (current: ${latest.status})`
    );
  }

  throw ApiError.conflict('SOS_ACKNOWLEDGE_CONFLICT', 'The SOS could not be acknowledged');
}

/**
 * Decides whether the requester may resolve this SOS.
 * Allowed: the SOS owner, or the escalation recipient that acknowledged it.
 * Returns the scope consumed by the atomic repository update.
 */
const resolveResolvingScope = (sos, userId) => {
  const uid = String(userId);

  if (sos.userId && String(sos.userId) === uid) {
    return { asOwner: true, levelIndex: null };
  }

  const levels = Array.isArray(sos.escalation?.levels) ? sos.escalation.levels : [];

  const ackedByMe = levels.findIndex(
    (level) =>
      level?.targetId !== undefined &&
      level?.targetId !== null &&
      String(level.targetId) === uid &&
      level?.status === SOS_STATUS.ACKNOWLEDGED
  );

  if (ackedByMe === -1) {
    throw ApiError.forbidden('SOS_RESOLVE_NOT_AUTHORIZED', 'You are not authorized to resolve this SOS');
  }

  return { asOwner: false, levelIndex: ackedByMe };
};

/**
 * ACKNOWLEDGED -> RESOLVED only.
 *
 * Authorized participants: the SOS owner or the recipient that acknowledged it.
 * `resolvedAt` is always server-generated. After the atomic write the owner's
 * room receives the lifecycle `sos:resolved` (best effort, §11); no calls, no
 * escalation changes, no resolution reason (the project persists none).
 */
export async function resolveSOS({
  sosId,
  userId,
  repository = sosRepository,
  emit = emitToUserRoom,
}) {
  const current = await repository.findById(sosId);

  if (!current) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  const scope = resolveResolvingScope(current, userId);

  if (current.status === SOS_STATUS.RESOLVED) {
    throw ApiError.conflict('SOS_ALREADY_RESOLVED', 'This SOS has already been resolved');
  }

  if (current.status !== SOS_STATUS.ACKNOWLEDGED) {
    throw ApiError.conflict(
      'SOS_NOT_ACKNOWLEDGED',
      `Only an ACKNOWLEDGED SOS can be resolved (current: ${current.status})`
    );
  }

  const resolvedAt = new Date();

  const updated = await repository.resolveById({ sosId, userId, ...scope, resolvedAt });

  if (updated) {
    // Owner resolves -> type USER; an acknowledging recipient resolves -> the
    // persisted type of the level it acknowledged (never a client claim).
    const resolvedBy = scope.asOwner
      ? { userId, type: 'USER' }
      : {
          userId,
          type: current.escalation?.levels?.[scope.levelIndex]?.type ?? null,
        };

    await emitLifecycleResolved({
      sos: updated,
      previousStatus: current.status,
      resolvedAt: updated.resolvedAt ?? resolvedAt,
      resolvedBy,
      emit,
    });

    return updated;
  }

  const latest = await repository.findById(sosId);

  if (!latest) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (latest.status === SOS_STATUS.RESOLVED) {
    throw ApiError.conflict('SOS_ALREADY_RESOLVED', 'This SOS has already been resolved');
  }

  if (latest.status !== SOS_STATUS.ACKNOWLEDGED) {
    throw ApiError.conflict(
      'SOS_NOT_ACKNOWLEDGED',
      `Only an ACKNOWLEDGED SOS can be resolved (current: ${latest.status})`
    );
  }

  throw ApiError.conflict('SOS_RESOLVE_CONFLICT', 'The SOS could not be resolved');
}

/**
 * Read-only paginated history for one authenticated user.
 *
 * Pure retrieval: no status rewrites (an expired VERIFYING SOS stays as-is),
 * no notifications, no sockets. Ownership is enforced by the repository filter.
 */
export async function getSOSHistory({ userId, page, limit, repository = sosRepository }) {
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    repository.findHistoryByUserId({ userId, skip, limit }),
    repository.countHistoryByUserId({ userId }),
  ]);

  return {
    items,
    pagination: {
      page,
      limit,
      total,
      totalPages: limit > 0 ? Math.ceil(total / limit) : 0,
    },
  };
}

// Automatically initiate SOS upon receiving safety detection events
import('../../utils/safetyEventBus.js').then(({ onSafetyEvent }) => {
  onSafetyEvent(async (event) => {
    if (!event || !event.userId) return;
    try {
      const active = await sosRepository.findActiveByUserId(event.userId);
      if (active) return; // Active or verifying SOS already exists

      await createSOS({
        userId: event.userId,
        payload: {
          triggerType: event.type,
          safetySessionId: event.safetySessionId || null,
          location: event.location || null,
          triggerData: event.metadata || {},
        },
      });
    } catch (err) {
      console.error(`[sos] failed to auto-create SOS for safety event ${event.type}:`, err.message);
    }
  });
}).catch((err) => console.error('[sos] failed to subscribe to safetyEventBus:', err.message));
