import { SOS_STATUS } from '../sos/sos.constants.js';

export const CALL_STATUS = Object.freeze({
  CREATED: 'CREATED',
  OUTGOING: 'OUTGOING',
  RINGING: 'RINGING',
  ACCEPTED: 'ACCEPTED',
  CONNECTED: 'CONNECTED',
  ENDED: 'ENDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REJECTED: 'REJECTED',
});

export const CALL_STATUSES = Object.freeze(Object.values(CALL_STATUS));

/**
 * Calls that are still in flight for their SOS. These block a second call for
 * the same SOS (unique index) and are exactly the states a participant may
 * join the room in.
 *
 *   OUTGOING -> RINGING -> ACCEPTED -> CONNECTED
 *   OUTGOING/RINGING -> REJECTED | FAILED | CANCELLED
 *   any -> ENDED
 */
export const PENDING_CALL_STATUSES = Object.freeze([
  CALL_STATUS.CREATED,
  CALL_STATUS.OUTGOING,
  CALL_STATUS.RINGING,
  CALL_STATUS.ACCEPTED,
  CALL_STATUS.CONNECTED,
]);

/** A pending call is precisely the state in which a participant may join. */
export const JOINABLE_CALL_STATUSES = PENDING_CALL_STATUSES;

/** States in which a call is finished and no longer blocks a retry. */
export const TERMINAL_CALL_STATUSES = Object.freeze([
  CALL_STATUS.ENDED,
  CALL_STATUS.FAILED,
  CALL_STATUS.CANCELLED,
  CALL_STATUS.REJECTED,
]);

/** Every state from which a call may be ended — exactly the in-flight ones. */
export const ENDABLE_CALL_STATUSES = PENDING_CALL_STATUSES;

/**
 * The only state from which verified LiveKit evidence may mark a call
 * connected. LiveKit proves that media is flowing, but it can never invent an
 * application-level acceptance: `ACCEPTED` is set by the application itself.
 */
export const CONNECTABLE_CALL_STATUSES = Object.freeze([CALL_STATUS.ACCEPTED]);

/**
 * The only state from which the guardian may accept the application-level call
 * request. Acceptance is an explicit, single-step transition:
 *
 *   RINGING -> ACCEPTED
 *
 * Everything else (CREATED / OUTGOING / an already accepted, connected,
 * rejected or finished call) is refused with 409 — in particular a terminal
 * state must never be resurrected into ACCEPTED.
 */
export const ACCEPTABLE_CALL_STATUSES = Object.freeze([CALL_STATUS.RINGING]);

/**
 * The only state from which the guardian may decline the call. Declining is a
 * single, explicit step into a terminal state:
 *
 *   RINGING -> REJECTED
 *
 * Everything else is refused with 409: in particular a call the guardian
 * already answered, or one that is already finished, must never flip to
 * REJECTED.
 */
export const REJECTABLE_CALL_STATUSES = Object.freeze([CALL_STATUS.RINGING]);

/**
 * Controlled vocabulary for why a call ended. The client may only pick one of
 * these labels; who actually ended it is recorded separately as `endedBy`
 * (derived from the authenticated participant, never from the body).
 *
 * PARTICIPANT_LEFT / ROOM_FINISHED are backend-only reasons written when a
 * verified LiveKit webhook finalizes the call.
 */
export const CALL_END_REASON = Object.freeze({
  USER_ENDED: 'USER_ENDED',
  GUARDIAN_ENDED: 'GUARDIAN_ENDED',
  CALLER_ENDED: 'CALLER_ENDED',
  TIMEOUT: 'TIMEOUT',
  FAILED: 'FAILED',
  SOS_RESOLVED: 'SOS_RESOLVED',
  SYSTEM: 'SYSTEM',
  // Backend-only: written when the assigned guardian declines a RINGING call
  // through `POST /calls/:id/reject`, alongside the REJECTED status.
  GUARDIAN_REJECTED: 'GUARDIAN_REJECTED',
  PARTICIPANT_LEFT: 'PARTICIPANT_LEFT',
  ROOM_FINISHED: 'ROOM_FINISHED',
});

export const CALL_END_REASONS = Object.freeze(Object.values(CALL_END_REASON));

/**
 * The application only supports browser-to-browser calls today. The value is
 * stored on the record for auditability; no call-type branching exists (and
 * none should be added until a second type actually arrives).
 */
export const CALL_TYPE = Object.freeze({
  BROWSER_TO_BROWSER: 'BROWSER_TO_BROWSER',
});

export const CALL_TYPES = Object.freeze(Object.values(CALL_TYPE));

/**
 * Participant roles, always derived on the server from the call document.
 * Clients can never send or override them.
 */
export const CALL_PARTICIPANT_ROLE = Object.freeze({
  USER: 'USER',
  GUARDIAN: 'GUARDIAN',
});

/**
 * SOS states in which guardian communication (an emergency call) is allowed.
 *
 * ALLOWED:   ACTIVE, ESCALATING, ACKNOWLEDGED (emergency still unresolved)
 * REJECTED:  VERIFYING, CANCELLED, RESOLVED
 */
export const CALLABLE_SOS_STATUSES = Object.freeze([
  SOS_STATUS.ACTIVE,
  SOS_STATUS.ESCALATING,
  SOS_STATUS.ACKNOWLEDGED,
]);
