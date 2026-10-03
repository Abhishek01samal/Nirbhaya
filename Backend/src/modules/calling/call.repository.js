import { Call } from './call.model.js';
import { SosEvent } from '../sos/sos.model.js';
import { Guardian } from '../guardians/guardian.model.js';
import { GUARDIAN_STATUS } from '../guardians/guardian.constants.js';
import {
  ACCEPTABLE_CALL_STATUSES,
  CALL_END_REASON,
  CALL_STATUS,
  PENDING_CALL_STATUSES,
  REJECTABLE_CALL_STATUSES,
} from './call.constants.js';

/**
 * Database access only. Authorization, SOS-state policy, guardian priority
 * decisions and call lifecycle rules all live in the service.
 *
 * Person 3 owns the `users` collection — `findUserById` re-exports Person 1's
 * existing read-only adapter instead of defining a second one.
 */
export { findUserById } from '../guardians/guardian.dependencies.js';

export async function findById(callId) {
  return Call.findOne({ _id: callId }).lean();
}

/** Unscoped SOS read — the service decides whether the caller owns it. */
export async function findSOSById(sosId) {
  return SosEvent.findOne({ _id: sosId }).lean();
}

/**
 * The SOS owner's eligible guardians, already ordered by the escalation rule
 * (priority ASC, createdAt ASC). Only ACTIVE relationships qualify, so
 * PENDING / REJECTED / BLOCKED guardians are excluded by the query itself.
 */
export async function findActiveGuardians(userId) {
  return Guardian.find({ userId, status: GUARDIAN_STATUS.ACTIVE })
    .sort({ priority: 1, createdAt: 1 })
    .lean();
}

/** The one in-flight call for this SOS, if any (terminal states excluded). */
export async function findActiveCallBySOS(sosId) {
  return Call.findOne({ sosId, status: { $in: [...PENDING_CALL_STATUSES] } })
    .sort({ createdAt: -1 })
    .lean();
}

export async function createCall(data) {
  return Call.create(data);
}

/**
 * The only write `POST /calls/start` performs after creating the call:
 * OUTGOING → RINGING in a single conditional update. The current status is
 * part of the filter, so the transition can happen at most once — a racing
 * start, a call that was ended in between, or any other state simply gets
 * `null` back instead of being dragged into RINGING.
 *
 * `ringingAt` is written in the same update as the status, so "the guardian
 * was rung at" can never drift from the flip itself.
 *
 * Returns the updated document, or null when the call is not OUTGOING.
 */
export async function ringCallAtomically(callId, ringingAt) {
  return Call.findOneAndUpdate(
    { _id: callId, status: CALL_STATUS.OUTGOING },
    { $set: { status: CALL_STATUS.RINGING, ringingAt, updatedAt: ringingAt } },
    { returnDocument: 'after' }
  ).lean();
}

// ---------------------------------------------------------------------------
// LiveKit webhook writes. Every one of them is a single conditional update so
// duplicate / delayed / out-of-order webhooks cannot re-apply a transition or
// overwrite a timestamp that was already recorded.
// ---------------------------------------------------------------------------

/** The application call behind a LiveKit room (`roomName` is backend-made). */
export async function findCallByRoomName(roomName) {
  if (!roomName) return null;
  return Call.findOne({ roomName }).lean();
}

/** Records that an expected participant entered the room — only once. */
export async function markParticipantJoined(callId, identity) {
  return Call.findOneAndUpdate(
    { _id: callId, participants: { $elemMatch: { identity, joinedAt: null } } },
    { $set: { 'participants.$[p].joinedAt': new Date(), updatedAt: new Date() } },
    { arrayFilters: [{ 'p.identity': identity }], returnDocument: 'after' }
  ).lean();
}

/** Clears presence when a participant leaves — only if they were present. */
export async function markParticipantLeft(callId, identity) {
  return Call.findOneAndUpdate(
    { _id: callId, participants: { $elemMatch: { identity, joinedAt: { $ne: null } } } },
    { $set: { 'participants.$[p].joinedAt': null, updatedAt: new Date() } },
    { arrayFilters: [{ 'p.identity': identity }], returnDocument: 'after' }
  ).lean();
}

/** ACCEPTED → CONNECTED (plus whatever else the caller explicitly allows). */
export async function markConnected(callId, allowedStatuses, connectedAt) {
  return Call.findOneAndUpdate(
    { _id: callId, status: { $in: [...allowedStatuses] } },
    { $set: { status: 'CONNECTED', connectedAt, updatedAt: connectedAt } },
    { returnDocument: 'after' }
  ).lean();
}

/** In-flight → ENDED, as decided by a verified webhook. */
export async function markEndedFromWebhook(callId, allowedStatuses, { endedAt, endReason }) {
  return Call.findOneAndUpdate(
    { _id: callId, status: { $in: [...allowedStatuses] } },
    { $set: { status: 'ENDED', endedAt, endReason, updatedAt: endedAt } },
    { returnDocument: 'after' }
  ).lean();
}

/** In-flight → FAILED when LiveKit reports the connection was aborted. */
export async function markFailedFromWebhook(callId, allowedStatuses, { endedAt, endReason }) {
  return Call.findOneAndUpdate(
    { _id: callId, status: { $in: [...allowedStatuses] } },
    { $set: { status: 'FAILED', endedAt, endReason, updatedAt: endedAt } },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * The only write `/calls/end` performs: flips the call to ENDED in a single
 * conditional update, so two simultaneous end requests cannot both win.
 * Returns the updated document, or null when the call is no longer in an
 * allowed state (already ended by someone else, or terminal).
 */
export async function endCallAtomically(callId, allowedStatuses, update) {
  return Call.findOneAndUpdate(
    { _id: callId, status: { $in: [...allowedStatuses] } },
    { $set: { ...update, updatedAt: update.endedAt ?? new Date() } },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * The only write `POST /calls/:id/accept` performs: a guardian-scoped
 * RINGING → ACCEPTED flip in a single conditional update. Guardian ownership
 * and call state are both inside the filter, so a double-tap, two concurrent
 * accepts or a caller who is not the assigned guardian can never win twice —
 * the loser simply gets `null` back.
 *
 * `connectedAt` and `endedAt` are deliberately untouched: media connectivity
 * is proven later by a verified LiveKit webhook.
 *
 * Returns the updated document, or null when the call is not RINGING or is
 * not assigned to this guardian.
 */
export async function acceptCallAtomically(callId, guardianUserId, acceptedAt) {
  return Call.findOneAndUpdate(
    { _id: callId, guardianUserId, status: { $in: [...ACCEPTABLE_CALL_STATUSES] } },
    { $set: { status: CALL_STATUS.ACCEPTED, updatedAt: acceptedAt } },
    { returnDocument: 'after' }
  ).lean();
}

/**
 * The only write `POST /calls/:id/reject` performs: a guardian-scoped
 * RINGING → REJECTED flip in a single conditional update. Guardian ownership
 * and call state are both inside the filter, so duplicate or concurrent
 * rejections produce exactly one transition — every loser gets `null`.
 *
 * The call is finished in the same write: `endedAt` is recorded and the
 * controlled `GUARDIAN_REJECTED` reason is stored, matching what `/calls/end`
 * writes. `connectedAt` stays null — media never started.
 *
 * The SOS is never part of this filter or update: declining an emergency call
 * does not resolve the emergency.
 *
 * Returns the updated document, or null when the call is not RINGING or is
 * not assigned to this guardian.
 */
export async function rejectCallAtomically(callId, guardianUserId, rejectedAt) {
  return Call.findOneAndUpdate(
    { _id: callId, guardianUserId, status: { $in: [...REJECTABLE_CALL_STATUSES] } },
    {
      $set: {
        status: CALL_STATUS.REJECTED,
        endReason: CALL_END_REASON.GUARDIAN_REJECTED,
        endedAt: rejectedAt,
        updatedAt: rejectedAt,
      },
    },
    { returnDocument: 'after' }
  ).lean();
}
