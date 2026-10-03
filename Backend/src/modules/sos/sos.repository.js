import mongoose from 'mongoose';
import { SosEvent } from './sos.model.js';
import {
  SOS_STATUS,
  UNRESOLVED_STATUSES,
  HISTORICAL_STATUSES,
  ESCALATION_LEVEL_TYPE,
  ESCALATION_LEVEL_STATUS,
  VERIFICATION_RESPONSE,
} from './sos.constants.js';

/**
 * `escalation.levels` is a Mixed array, so Mongoose casts nothing on those
 * paths: targetId/notifiedResponders may hold ObjectIds (written by the
 * guardian selection) or plain strings, while the authenticated userId is
 * always a string. The atomic filters below therefore match either form.
 */
const targetCandidates = (value) => {
  const str = String(value);
  const candidates = [str];

  if (/^[0-9a-fA-F]{24}$/.test(str)) {
    candidates.push(new mongoose.Types.ObjectId(str));
  }

  return { $in: candidates };
};

/**
 * Database operations only. No business decisions live here.
 */

const unresolvedFilter = (userId) => ({
  userId,
  status: { $in: [...UNRESOLVED_STATUSES] },
});

export async function findActiveByUserId(userId) {
  return SosEvent.findOne(unresolvedFilter(userId)).sort({ createdAt: -1 }).lean();
}

export async function findUnresolvedSOS({ userId, safetySessionIds }) {
  const filter = unresolvedFilter(userId);

  if (Array.isArray(safetySessionIds)) {
    filter.safetySessionId = { $in: safetySessionIds };
  }

  return SosEvent.findOne(filter).sort({ createdAt: -1 }).lean();
}

export async function createSOS(data) {
  return SosEvent.create(data);
}

export async function findByIdAndUserId(sosId, userId) {
  return SosEvent.findOne({ _id: sosId, userId }).lean();
}

/**
 * Unscoped lookup used by recipient-facing actions (acknowledge): the
 * requester is a guardian/responder, NOT the SOS owner.
 */
export async function findById(sosId) {
  return SosEvent.findOne({ _id: sosId }).lean();
}

/**
 * Atomic VERIFYING -> ACTIVE transition.
 * The status (and verification window) are part of the filter, so concurrent
 * requests cannot both win the same transition.
 */
export async function confirmAndActivate({ sosId, userId, respondedAt }) {
  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      userId,
      status: SOS_STATUS.VERIFYING,
      $or: [
        { 'verification.expiresAt': null },
        { 'verification.expiresAt': { $gte: respondedAt } },
      ],
    },
    {
      $set: {
        status: SOS_STATUS.ACTIVE,
        'verification.userResponse': VERIFICATION_RESPONSE.CONFIRMED,
        'verification.respondedAt': respondedAt,
      },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic VERIFYING -> CANCELLED transition with the same race guarantees as
 * confirmAndActivate: status and expiry are part of the filter, so a confirm
 * and a cancel can never both win.
 */
export async function cancelAndRecord({ sosId, userId, respondedAt }) {
  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      userId,
      status: SOS_STATUS.VERIFYING,
      $or: [
        { 'verification.expiresAt': null },
        { 'verification.expiresAt': { $gte: respondedAt } },
      ],
    },
    {
      $set: {
        status: SOS_STATUS.CANCELLED,
        'verification.userResponse': VERIFICATION_RESPONSE.CANCELLED,
        'verification.respondedAt': respondedAt,
      },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic verification-timeout activation (backend timer callback).
 *
 * Only a still-VERIFYING SOS can be activated, so a timer that fires after a
 * confirmation, a cancellation — or after another copy of itself — misses the
 * filter, gets null and must do nothing. The expiry is deliberately NOT part
 * of the filter: this update is only ever issued by the timer armed for this
 * very window, and requiring `expiresAt <= now` there could refuse a fired
 * timer with no re-arm left, stranding the SOS in VERIFYING forever.
 *
 * The outcome is recorded in `verification.userResponse` ('TIMEOUT');
 * `triggerType`/`triggerData` are untouched (§17: the timeout is an outcome,
 * never a new trigger).
 */
export async function activateOnVerificationTimeout({ sosId, timedOutAt }) {
  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      status: SOS_STATUS.VERIFYING,
    },
    {
      $set: {
        status: SOS_STATUS.ACTIVE,
        'verification.userResponse': VERIFICATION_RESPONSE.TIMEOUT,
        'verification.respondedAt': timedOutAt,
      },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic recipient acknowledgement.
 *
 * The SOS must still be ACTIVE/ESCALATING and the target escalation level must
 * not already be ACKNOWLEDGED at write time, so two concurrent acknowledgements
 * (or an acknowledgement racing another state change) cannot both succeed.
 */
export async function acknowledgeByRecipient({ sosId, levelIndex, respondedAt }) {
  const levelStatusPath = `escalation.levels.${levelIndex}.status`;

  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      status: { $in: [SOS_STATUS.ACTIVE, SOS_STATUS.ESCALATING] },
      [levelStatusPath]: { $ne: SOS_STATUS.ACKNOWLEDGED },
    },
    {
      $set: {
        status: SOS_STATUS.ACKNOWLEDGED,
        [levelStatusPath]: SOS_STATUS.ACKNOWLEDGED,
        [`escalation.levels.${levelIndex}.respondedAt`]: respondedAt,
      },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic ACKNOWLEDGED -> RESOLVED transition.
 *
 * `asOwner` scopes the update to the owner's own document; otherwise the update
 * is scoped to the specific escalation level that acknowledged the SOS (level
 * index comes from the service's authorization check).
 * status = ACKNOWLEDGED is part of the filter, so concurrent resolves cannot
 * both succeed.
 */
export async function resolveById({ sosId, userId, asOwner, levelIndex, resolvedAt }) {
  const scope = asOwner
    ? { userId }
    : { [`escalation.levels.${levelIndex}.status`]: SOS_STATUS.ACKNOWLEDGED };

  return SosEvent.findOneAndUpdate(
    { _id: sosId, status: SOS_STATUS.ACKNOWLEDGED, ...scope },
    { $set: { status: SOS_STATUS.RESOLVED, resolvedAt } },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic guardian escalation start: an ACTIVE SOS with zero escalation levels
 * gains its first level in one conditional update. Ownership, ACTIVE status
 * and the empty-levels requirement are all part of the filter, so concurrent
 * starts can never double-notify — exactly one request wins, the rest get null.
 */
export async function startGuardianEscalation({ sosId, userId, level }) {
  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      userId,
      status: SOS_STATUS.ACTIVE,
      'escalation.levels': { $size: 0 },
    },
    {
      $set: { 'escalation.currentLevel': 0 },
      $push: { 'escalation.levels': level },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic guardian-level timeout, invoked by the escalation timer. Only a
 * still-escalatable SOS (ACTIVE / ESCALATING) whose FIRST level is the
 * guardian level in PENDING can move to TIMEOUT, so a guardian that
 * acknowledged, a resolved SOS, or an already-recorded timeout can never be
 * rewritten by a late-firing timer.
 */
export async function timeoutGuardianEscalation({ sosId }) {
  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      status: { $in: [SOS_STATUS.ACTIVE, SOS_STATUS.ESCALATING] },
      'escalation.levels.0.type': ESCALATION_LEVEL_TYPE.GUARDIAN,
      'escalation.levels.0.status': ESCALATION_LEVEL_STATUS.PENDING,
    },
    {
      $set: { 'escalation.levels.0.status': ESCALATION_LEVEL_STATUS.TIMEOUT },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic nearby-responder escalation start (POST /:id/responders/notify).
 *
 * Only a still-escalatable SOS whose FIRST level is the guardian level in
 * TIMEOUT and that has no second level yet can gain the responder level, so:
 *   - a guardian that is still PENDING (or acknowledged) can never be skipped;
 *   - a cancelled/resolved/acknowledged SOS never reaches responders;
 *   - concurrent notifies collapse into exactly one write — the loser gets
 *     null and replays the winner's state, so no duplicate level, no second
 *     notification batch and no second timer;
 *   - once a responder (or police) level exists, `levels.1` matches and the
 *     write is refused: escalation can never move backwards.
 *
 * `currentLevel` becomes 1 (the responder index) and the guardian level is
 * left completely untouched — history is preserved.
 */
export async function startResponderEscalation({ sosId, userId, level }) {
  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      userId,
      status: { $in: [SOS_STATUS.ACTIVE, SOS_STATUS.ESCALATING] },
      'escalation.levels.0.type': ESCALATION_LEVEL_TYPE.GUARDIAN,
      'escalation.levels.0.status': ESCALATION_LEVEL_STATUS.TIMEOUT,
      'escalation.levels.1': { $exists: false },
    },
    {
      $set: { 'escalation.currentLevel': 1 },
      $push: { 'escalation.levels': level },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic police escalation start (POST /:id/escalation/police).
 *
 * The whole previous history is part of the filter — guardian level TIMED
 * OUT, responder level present and TIMED OUT (the "timed out / nobody
 * eligible" convention of startResponderEscalation), no third level yet —
 * so:
 *   - a guardian or responder that is still PENDING (or acknowledged) can
 *     never be skipped, and an SOS that never escalated cannot jump to police;
 *   - concurrent escalations (timer-driven or manual) collapse into exactly
 *     one write — the loser gets null and replays the winner's state, so no
 *     duplicate level and no second notification;
 *   - once a police level exists the write is refused: escalation can never
 *     move backwards or notify the station twice.
 *
 * `currentLevel` becomes 2 (the police index) and the SOS STATUS is
 * deliberately untouched: escalation levels describe progress, status stays
 * with the existing SOS state machine (ACTIVE / ESCALATING, never RESOLVED).
 */
export async function escalateToPolice({ sosId, userId, level }) {
  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      userId,
      status: { $in: [SOS_STATUS.ACTIVE, SOS_STATUS.ESCALATING] },
      'escalation.levels.0.type': ESCALATION_LEVEL_TYPE.GUARDIAN,
      'escalation.levels.0.status': ESCALATION_LEVEL_STATUS.TIMEOUT,
      'escalation.levels.1.type': ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
      'escalation.levels.1.status': ESCALATION_LEVEL_STATUS.TIMEOUT,
      'escalation.levels.2': { $exists: false },
    },
    {
      $set: { 'escalation.currentLevel': 2 },
      $push: { 'escalation.levels': level },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic responder-level timeout, invoked by the escalation timer.
 *
 * The same conditional-update discipline as timeoutGuardianEscalation: only a
 * still-escalatable SOS whose responder level is PENDING can move to TIMEOUT.
 * Therefore a responder that already acknowledged (PENDING -> ACKNOWLEDGED,
 * which also moves the SOS out of ACTIVE/ESCALATING), a cancelled/resolved
 * SOS, or an already-recorded timeout can never be rewritten by a late-firing
 * timer — acknowledgement and timeout can never both win.
 */
export async function timeoutResponderEscalation({ sosId }) {
  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      status: { $in: [SOS_STATUS.ACTIVE, SOS_STATUS.ESCALATING] },
      'escalation.levels.1.type': ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
      'escalation.levels.1.status': ESCALATION_LEVEL_STATUS.PENDING,
    },
    {
      $set: { 'escalation.levels.1.status': ESCALATION_LEVEL_STATUS.TIMEOUT },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Atomic escalation acknowledgement (POST /:id/escalation/acknowledge).
 *
 * Everything that must hold at write time lives in the filter — SOS state,
 * level type, level status exactly PENDING, and the caller's target scope
 * (targetId for a guardian, membership in notifiedResponders for a
 * responder). Therefore acknowledgement vs. timeout vs. duplicate tabs
 * collapse into a single winner: PENDING -> ACKNOWLEDGED happens at most
 * once, and a late timer can never overwrite it.
 *
 * The SOS moves to ACKNOWLEDGED in the same update — the existing state
 * machine's acknowledgement rule (also used by POST /:id/acknowledge), which
 * the resolve endpoint requires. `targetId` for a responder level is written
 * here (who acknowledged); `notifiedResponders` is never part of the update,
 * so the notification history is preserved untouched.
 *
 * NOTE: deliberately stricter than acknowledgeByRecipient (used by the
 * generic /:id/acknowledge endpoint), which allows any non-ACKNOWLEDGED
 * level status — this flow only accepts PENDING.
 */
export async function acknowledgeEscalationLevel({
  sosId,
  userId,
  levelIndex,
  levelType,
  target,
  respondedAt,
}) {
  const basePath = `escalation.levels.${levelIndex}`;
  const targetFilter =
    levelType === ESCALATION_LEVEL_TYPE.GUARDIAN
      ? { [`${basePath}.targetId`]: targetCandidates(target) }
      : { [`${basePath}.notifiedResponders`]: targetCandidates(target) };

  return SosEvent.findOneAndUpdate(
    {
      _id: sosId,
      userId,
      status: { $in: [SOS_STATUS.ACTIVE, SOS_STATUS.ESCALATING] },
      [`${basePath}.type`]: levelType,
      [`${basePath}.status`]: ESCALATION_LEVEL_STATUS.PENDING,
      ...targetFilter,
    },
    {
      $set: {
        status: SOS_STATUS.ACKNOWLEDGED,
        [`${basePath}.status`]: ESCALATION_LEVEL_STATUS.ACKNOWLEDGED,
        [`${basePath}.respondedAt`]: respondedAt,
        ...(levelType === ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER
          ? { [`${basePath}.targetId`]: target }
          : {}),
      },
    },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * Read-only history queries. Ownership (userId) is always part of the filter so
 * a caller can never read another user's records; results are paginated in the
 * database (skip/limit), never in application memory.
 */
const historyFilter = (userId) => ({
  userId,
  status: { $in: [...HISTORICAL_STATUSES] },
});

export async function findHistoryByUserId({ userId, skip, limit }) {
  return SosEvent.find(historyFilter(userId))
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();
}

export async function countHistoryByUserId({ userId }) {
  return SosEvent.countDocuments(historyFilter(userId));
}
