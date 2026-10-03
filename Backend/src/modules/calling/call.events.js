/**
 * Socket.IO events for the calling flow.
 *
 * Event names, payloads and best-effort delivery live here so the calling and
 * LiveKit webhook services stay focused on business rules and never touch
 * `io.to(...)` directly. Delivery is always a notification: a socket outage
 * must never fail — or roll back — a successfully persisted call, because the
 * database remains the source of truth.
 */

import { CALL_END_REASONS, CALL_PARTICIPANT_ROLE, CALL_STATUS } from './call.constants.js';

/**
 * Known calling events. New stages of the flow (accepted, rejected,
 * connected, failed, ended) extend this map rather than hard-coding strings.
 */
export const CALL_EVENT = Object.freeze({
  OUTGOING: 'call:outgoing',
  RINGING: 'call:ringing',
  ACCEPTED: 'call:accepted',
  REJECTED: 'call:rejected',
  CONNECTED: 'call:connected',
  DISCONNECTED: 'call:disconnected',
  FAILED: 'call:failed',
  ENDED: 'call:ended',
});

/**
 * Emissions are best effort: a socket outage must never turn a successfully
 * created emergency call into a failed request. Shared with the LiveKit
 * webhook service for the same reason.
 */
export const safeEmit = async (emit, targetUserId, event, payload) => {
  try {
    await emit(targetUserId, event, payload);
  } catch (err) {
    console.warn(`[call] failed to emit ${event}: ${err?.message || err}`);
  }
};

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * `call:outgoing` payload: which call was created, which SOS it belongs to,
 * its current state and who it is ringing out to.
 *
 * Deliberately free of connection details — no room name, no LiveKit key or
 * token, no provider url, no password and no profile data. The frontend only
 * needs to identify the call and show "calling your guardian...".
 */
export const callOutgoingPayload = (call) => ({
  callId: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  status: call.status,
  type: call.type,
  guardianUserId: call.guardianUserId ? String(call.guardianUserId) : null,
  createdAt: toIso(call.createdAt),
});

/**
 * Tells the SOS owner's browser that their emergency call request was created
 * and is now outgoing — the start of the flow, not a connection:
 *
 *   created (OUTGOING) → call:outgoing → call:ringing → call:accepted → …
 *
 * The recipient is `call.userId`, which `startEmergencyCall` has already
 * verified to be the authenticated SOS owner who created the call. It is
 * therefore never a broadcast, never the guardian (they receive
 * `call:ringing`) and never a client-supplied id.
 *
 * Must only be called after the call document exists, and is always best
 * effort: a dropped notification never rolls the call back, the client
 * recovers state through REST.
 */
export const emitCallOutgoing = ({ call, emit }) =>
  safeEmit(emit, String(call.userId), CALL_EVENT.OUTGOING, callOutgoingPayload(call));

/**
 * `call:ringing` payload: everything the guardian's incoming-call UI needs to
 * render "Ansuman is calling you" and offer Accept / Reject — which call, on
 * whose SOS, who is calling, and since when it has been waiting.
 *
 * The caller identity comes from the stored `call.userId` (the authenticated
 * SOS owner), never from anything a client sent. No connection details: this
 * event never grants room access, so no room name, no identities, no LiveKit
 * material, no profile document.
 */
export const callRingingPayload = ({ call, callerName }) => ({
  callId: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  status: call.status,
  type: call.type,
  caller: {
    userId: call.userId ? String(call.userId) : null,
    name: callerName ?? null,
  },
  createdAt: toIso(call.createdAt),
  ringingAt: toIso(call.ringingAt),
});

/**
 * Tells the assigned guardian's browser that an emergency call is waiting for
 * their response — "a call is ringing for you", and nothing more: not an
 * acceptance, not a connected media session, not LiveKit room access.
 *
 * Recipient: `call.guardianUserId`, chosen by the server-side guardian
 * selection inside `/calls/start` and read back from the stored document —
 * never a client-supplied id, never a broadcast, never every guardian.
 *
 * Two guards keep §8/§15 honest even if a caller hands over the wrong
 * document: the event is withheld unless the call is actually RINGING and a
 * guardian is assigned. Delivery itself stays best effort — the database has
 * already moved, so a dropped notification is recovered through REST.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitCallRinging = async ({ call, callerName, emit }) => {
  if (call?.status !== CALL_STATUS.RINGING) return false;
  if (!call.guardianUserId) return false;

  await safeEmit(
    emit,
    String(call.guardianUserId),
    CALL_EVENT.RINGING,
    callRingingPayload({ call, callerName })
  );

  return true;
};

/**
 * `call:accepted` payload: the owner learns that the guardian said yes, who
 * accepted, and when — enough to move the UI from "Calling guardian..." to
 * "Guardian accepted, connecting...".
 *
 * It deliberately stops there: no room name, no identities, no token, no
 * connectivity fields. `acceptedAt` is the timestamp of the acceptance write
 * itself; `connectedAt` / `call:connected` belong to the LiveKit stage.
 */
export const callAcceptedPayload = ({ call, guardianName, acceptedAt }) => ({
  callId: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  status: call.status,
  type: call.type,
  guardian: {
    userId: call.guardianUserId ? String(call.guardianUserId) : null,
    name: guardianName ?? null,
  },
  acceptedAt: toIso(acceptedAt ?? call.acceptedAt ?? call.updatedAt),
});

/**
 * Tells the SOS owner's browser that the guardian accepted their emergency
 * call request — application-level acceptance only. It never means media is
 * connected: the owner still has to request a token and wait for the
 * LiveKit-backed connection stage.
 *
 * Recipient: `call.userId`, read from the document the guardian's own
 * authorized accept just updated — never a client-supplied recipient, never a
 * broadcast, never the guardian (they performed the action) or anyone else.
 *
 * Two guards keep it honest: withheld unless the stored document really says
 * ACCEPTED (so no event for a failed transition, and never a second event for
 * an already-accepted call), and withheld when the call has no owner to tell.
 * Delivery stays best effort — the acceptance is already durable either way.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitCallAccepted = async ({ call, guardianName, acceptedAt, emit }) => {
  if (call?.status !== CALL_STATUS.ACCEPTED) return false;
  if (!call.userId) return false;

  await safeEmit(
    emit,
    String(call.userId),
    CALL_EVENT.ACCEPTED,
    callAcceptedPayload({ call, guardianName, acceptedAt })
  );

  return true;
};

/**
 * `call:rejected` payload: the owner learns that this guardian declined this
 * particular call, who declined, and when the call was finished — enough to
 * stop the ringing UI. The controlled `endReason` / `endedAt` are read from
 * the document the rejection wrote, so the event can never describe a
 * rejection the database does not record.
 *
 * It says nothing about the SOS: no SOS status, no escalation data. Declining
 * a call is not resolving an emergency.
 */
export const callRejectedPayload = ({ call, guardianName }) => ({
  callId: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  status: call.status,
  type: call.type,
  guardian: {
    userId: call.guardianUserId ? String(call.guardianUserId) : null,
    name: guardianName ?? null,
  },
  endReason: call.endReason ?? null,
  endedAt: toIso(call.endedAt),
});

/**
 * Tells the SOS owner's browser that the guardian declined their emergency
 * call request — this call only. The emergency itself keeps running: the
 * event carries no SOS state, resolves nothing, cancels nothing, and never
 * authorises a LiveKit connection for a call that will not happen.
 *
 * Recipient: `call.userId`, read from the document the guardian's own
 * authorized rejection just updated — never a client-supplied recipient,
 * never a broadcast, never the guardian (they performed the action).
 *
 * Two guards keep it honest: withheld unless the stored document really says
 * REJECTED (so no event for a failed transition, and never a second event for
 * an already-rejected call), and withheld when the call has no owner to tell.
 * Delivery stays best effort — the rejection is already durable either way.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitCallRejected = async ({ call, guardianName, emit }) => {
  if (call?.status !== CALL_STATUS.REJECTED) return false;
  if (!call.userId) return false;

  await safeEmit(
    emit,
    String(call.userId),
    CALL_EVENT.REJECTED,
    callRejectedPayload({ call, guardianName })
  );

  return true;
};

/**
 * `call:connected` payload: both sides learn the emergency call actually has
 * media — LiveKit connected the expected participants, the backend recorded
 * it, and this is the application-level confirmation. It stops the
 * "Connecting..." UI and shows the active call interface.
 *
 * Everything connection-related stays out: no room name, no participant
 * identities, no token, no LiveKit material — and no participant metadata,
 * because both recipients already know who is on the call. `connectedAt` is
 * the timestamp the atomic `ACCEPTED → CONNECTED` write produced.
 */
export const callConnectedPayload = ({ call, connectedAt }) => ({
  callId: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  status: call.status,
  type: call.type,
  connectedAt: toIso(connectedAt ?? call.connectedAt),
});

/**
 * Tells both participants' browsers that the emergency call is connected —
 * and only after the LiveKit webhook's atomic `ACCEPTED → CONNECTED` write
 * succeeded. The database is the source of truth: this never runs from a
 * client-side LiveKit callback, and the event is withheld unless the stored
 * document really says CONNECTED, so a failed or duplicate transition never
 * notifies anyone.
 *
 * Recipients: exactly the two participants — `user:{call.userId}` and
 * `user:{call.guardianUserId}` — each in their own private room, never a
 * broadcast, never a client-supplied id. Delivery stays best effort: a
 * dropped notification never rolls the connection back, the frontend
 * recovers state through the existing call/state REST APIs.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitCallConnected = async ({ call, connectedAt, emit }) => {
  if (call?.status !== CALL_STATUS.CONNECTED) return false;

  const recipients = new Set();
  if (call.userId) recipients.add(String(call.userId));
  if (call.guardianUserId) recipients.add(String(call.guardianUserId));
  if (recipients.size === 0) return false;

  const payload = callConnectedPayload({ call, connectedAt });

  for (const recipient of recipients) {
    await safeEmit(emit, recipient, CALL_EVENT.CONNECTED, payload);
  }

  return true;
};

/**
 * `call:disconnected` payload: a participant left or the room disappeared,
 * but the call may or may not have been formally terminated yet. The frontend
 * uses this to briefly show a "reconnecting…" state before either a fresh
 * `call:connected` (if LiveKit recovers) or a `call:ended` / `call:failed`
 * (if it does not) arrives.
 *
 * `identity` is the identity of the participant who dropped — null for
 * room-level disconnects (`room_finished`) where no single participant is to
 * blame. No room name, no token, no LiveKit material.
 */
export const callDisconnectedPayload = (call, identity, disconnectedAt) => ({
  callId: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  identity: identity ?? null,
  disconnectedAt: disconnectedAt
    ? new Date(disconnectedAt).toISOString()
    : new Date().toISOString(),
});

/**
 * Tells both participants that a participant dropped or the room was
 * unexpectedly closed — a transient signal, not a terminal one.
 *
 * Emitted only from verified LiveKit webhooks (`participant_left`,
 * `room_finished`) after the relevant DB write. Delivery is best effort.
 *
 * Returns true when the notification was handed to the socket layer.
 */
export const emitCallDisconnected = async ({ call, identity, disconnectedAt, emit }) => {
  const recipients = new Set();
  if (call.userId) recipients.add(String(call.userId));
  if (call.guardianUserId) recipients.add(String(call.guardianUserId));
  if (recipients.size === 0) return false;

  const payload = callDisconnectedPayload(call, identity, disconnectedAt);

  for (const recipient of recipients) {
    await safeEmit(emit, recipient, CALL_EVENT.DISCONNECTED, payload);
  }

  return true;
};

/**
 * Failure reasons leave the backend only through the controlled `endReason`
 * vocabulary. Anything else — a stack trace, a database error, a provider
 * message — is dropped to null before it can reach a client.
 */
const safeReason = (reason) =>
  typeof reason === 'string' && CALL_END_REASONS.includes(reason) ? reason : null;

/**
 * `call:failed` payload: the emergency call could not be established and
 * recovery is no longer possible. Both sides use it to stop the
 * ringing/connecting UI, leave the LiveKit room and show a safe failure
 * message — and nothing else. It never means the SOS was resolved.
 *
 * `failedAt` is the timestamp of the authoritative FAILED write (stored as
 * `endedAt`, the schema's single terminal timestamp). `reason` is a
 * user-facing label from the controlled vocabulary only: never a stack trace,
 * never a database error, never infrastructure detail. No room name, no
 * identities, no token, no LiveKit material.
 */
export const callFailedPayload = ({ call, failedAt, reason }) => ({
  callId: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  status: call.status,
  type: call.type,
  failedAt: toIso(failedAt ?? call.endedAt),
  reason: safeReason(reason ?? call.endReason),
});

/**
 * Tells both participants' browsers that the emergency call has failed —
 * unrecoverable, not a retryable disconnect (`call:disconnected`) and not an
 * intentional finish (`call:ended`). Emitted only after the backend's atomic
 * transition to FAILED succeeded: the database is the source of truth, so a
 * duplicate, late or racing failure never notifies anyone, and a delivered
 * notification is never rolled back if a socket is missing — the frontend
 * recovers state through the existing call/state REST APIs.
 *
 * Recipients: exactly the two participants — `user:{call.userId}` and
 * `user:{call.guardianUserId}` — each in their own private room, never a
 * broadcast, never a client-supplied id. Delivery is best effort.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitCallFailed = async ({ call, failedAt, reason, emit }) => {
  if (call?.status !== CALL_STATUS.FAILED) return false;

  const recipients = new Set();
  if (call.userId) recipients.add(String(call.userId));
  if (call.guardianUserId) recipients.add(String(call.guardianUserId));
  if (recipients.size === 0) return false;

  const payload = callFailedPayload({ call, failedAt, reason });

  for (const recipient of recipients) {
    await safeEmit(emit, recipient, CALL_EVENT.FAILED, payload);
  }

  return true;
};

/**
 * Who ended the call: only a backend-derived `{userId, role}` survives.
 * Anything else — a client-supplied id, a missing or unknown role — is
 * dropped to null so the event can never credit an arbitrary participant.
 * Webhook-driven terminations (`room_finished`, `participant_left`) pass null:
 * the system ended those, not a user.
 */
const safeEndedBy = (endedBy) => {
  if (!endedBy?.userId) return null;
  if (!Object.values(CALL_PARTICIPANT_ROLE).includes(endedBy.role)) return null;

  return { userId: String(endedBy.userId), role: endedBy.role };
};

/**
 * `call:ended` payload: the final application-level termination both
 * participants need to stop their UIs, leave the LiveKit room and record the
 * outcome. `endedAt` / `endReason` are read from the document the atomic
 * ENDED write produced — never invented here — and `endReason` only ever
 * exposes the controlled vocabulary (never a stack trace or internal error).
 *
 * `endedBy` is present only when the backend can attribute the termination to
 * one of the two authenticated participants; webhook/system terminations send
 * null. No room name, no identities, no token, no LiveKit material, no SOS
 * state: ending a call never resolves the emergency.
 */
export const callEndedPayload = ({ call, endedAt, endedBy }) => ({
  callId: String(call._id),
  sosId: call.sosId ? String(call.sosId) : null,
  status: call.status,
  type: call.type,
  endedAt: toIso(endedAt ?? call.endedAt),
  endReason: safeReason(call.endReason),
  endedBy: safeEndedBy(endedBy),
});

/**
 * Tells both participants' browsers that the emergency call has ended —
 * the final application-level termination (as opposed to the retryable
 * `call:disconnected` and the unrecoverable `call:failed`). Emitted only
 * after the backend's atomic transition to ENDED succeeded: duplicates,
 * idempotent replays and losing racers never notify anyone, and a delivered
 * notification is never rolled back if a socket is missing — the frontend
 * recovers state through the existing call/state REST APIs.
 *
 * Recipients: exactly the two participants — `user:{call.userId}` and
 * `user:{call.guardianUserId}` — each in their own private room, never a
 * broadcast, never a client-supplied id. Delivery is best effort.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitCallEnded = async ({ call, endedAt, endedBy, emit }) => {
  if (call?.status !== CALL_STATUS.ENDED) return false;

  const recipients = new Set();
  if (call.userId) recipients.add(String(call.userId));
  if (call.guardianUserId) recipients.add(String(call.guardianUserId));
  if (recipients.size === 0) return false;

  const payload = callEndedPayload({ call, endedAt, endedBy });

  for (const recipient of recipients) {
    await safeEmit(emit, recipient, CALL_EVENT.ENDED, payload);
  }

  return true;
};
