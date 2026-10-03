import mongoose from 'mongoose';
import { AccessToken } from 'livekit-server-sdk';
import { ApiError } from '../../utils/ApiError.js';
import { env } from '../../config/env.js';
import { emitToUserRoom } from '../../sockets/index.js';
import {
  emitCallAccepted,
  emitCallEnded,
  emitCallOutgoing,
  emitCallRejected,
  emitCallRinging,
} from './call.events.js';
import * as callRepository from './call.repository.js';
import {
  ACCEPTABLE_CALL_STATUSES,
  CALLABLE_SOS_STATUSES,
  CALL_PARTICIPANT_ROLE,
  CALL_STATUS,
  CALL_TYPE,
  ENDABLE_CALL_STATUSES,
  JOINABLE_CALL_STATUSES,
  REJECTABLE_CALL_STATUSES,
} from './call.constants.js';

/**
 * Backend-side token factory. Credentials and TTL come from configuration —
 * never from the request. Grants are minimal: join this room, publish mic,
 * subscribe. No room/admin/SIP permissions.
 */
export const issueLiveKitToken = async ({ roomName, identity, config = env.livekit }) => {
  if (!config.url || !config.apiKey || !config.apiSecret) {
    throw new ApiError(502, 'LIVEKIT_NOT_CONFIGURED', 'Voice provider is not configured');
  }

  const token = new AccessToken(config.apiKey, config.apiSecret, {
    identity,
    ttl: config.tokenTtlSeconds,
  });

  token.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
  });

  return token.toJwt();
};

/**
 * Determines the participant's role from the stored call document — never from
 * the request. Returns null when the caller is not an authorized participant.
 *
 *   call.userId        -> USER      (the protected user who owns the SOS)
 *   call.guardianUserId -> GUARDIAN (the invited guardian)
 *
 * The LiveKit identity keeps the project's existing `user:<userId>`
 * convention for both roles, so the role itself is authorization metadata and
 * is never echoed to (or overridable by) the client.
 */
export const resolveParticipantRole = (call, userId) => {
  const uid = String(userId);

  if (call?.userId !== undefined && call.userId !== null && String(call.userId) === uid) {
    return CALL_PARTICIPANT_ROLE.USER;
  }

  if (
    call?.guardianUserId !== undefined &&
    call.guardianUserId !== null &&
    String(call.guardianUserId) === uid
  ) {
    return CALL_PARTICIPANT_ROLE.GUARDIAN;
  }

  return null;
};

/**
 * Issues a short-lived LiveKit participant token for an existing call.
 *
 * Authorization uses the application call record (owner OR invited guardian),
 * the room always comes from the stored record (clients can never pick a room),
 * and the identity is backend-derived (`user:<userId>`, reusing a stored one).
 * Non-joinable states (ENDED/FAILED/CANCELLED) are refused with 409.
 */
export async function createCallToken({
  callId,
  userId,
  repository = callRepository,
  issueToken = issueLiveKitToken,
  config = env.livekit,
}) {
  const call = await repository.findById(callId);

  if (!call) {
    throw ApiError.notFound('CALL_NOT_FOUND', 'Call not found');
  }

  // Knowing the callId is never enough: the caller must be a participant.
  const participantRole = resolveParticipantRole(call, userId);

  if (!participantRole) {
    throw ApiError.forbidden('CALL_NOT_AUTHORIZED', 'You are not a participant of this call');
  }

  if (!JOINABLE_CALL_STATUSES.includes(call.status)) {
    throw ApiError.conflict('CALL_NOT_JOINABLE', `Call is not joinable (current: ${call.status})`);
  }

  // A valid call record always carries a backend-generated room; a missing one
  // means corrupt data, so this is a server error rather than a client error.
  const roomName = typeof call.roomName === 'string' ? call.roomName.trim() : '';

  if (!roomName) {
    throw ApiError.internal('CALL_ROOM_MISSING', 'Call record is missing a valid room name');
  }

  const participantIdentity =
    (call.identities && call.identities[String(userId)]) || `user:${String(userId)}`;

  let token;

  try {
    token = await issueToken({
      roomName,
      identity: participantIdentity,
      config,
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError(502, 'LIVEKIT_TOKEN_FAILED', 'Failed to generate voice token');
  }

  return {
    token,
    serverUrl: config.url,
    roomName,
    participantIdentity,
  };
}

/**
 * LiveKit identity for a participant. Deterministic, backend-controlled and
 * unique inside the room (one identity per user id); it never contains a
 * phone number, email or anything the client could have supplied.
 *
 * This is the same convention `/calls/token` uses, so a token issued for this
 * call always matches the identity stored on the record.
 */
const buildIdentity = (userId) => `user:${String(userId)}`;

const buildParticipants = (ownerId, guardianId) => [
  {
    userId: ownerId,
    identity: buildIdentity(ownerId),
    role: CALL_PARTICIPANT_ROLE.USER,
  },
  {
    userId: guardianId,
    identity: buildIdentity(guardianId),
    role: CALL_PARTICIPANT_ROLE.GUARDIAN,
  },
];

/**
 * Highest-priority guardian that is actually reachable: `findActiveGuardians`
 * already returns ACTIVE relationships in priority ASC / createdAt ASC order,
 * and a guardian whose Person 3 account no longer exists is skipped.
 */
const selectGuardian = async (repository, ownerId) => {
  const guardians = await repository.findActiveGuardians(ownerId);

  for (const guardian of guardians) {
    const account = await repository.findUserById(guardian.guardianUserId);

    if (account) {
      return guardian;
    }
  }

  return null;
};

/**
 * Display name for a participant on an event payload (the ringing caller, the
 * accepting guardian). Best effort: a missing profile or a failed read yields
 * `null` instead of failing the state change that triggered the event.
 */
const resolveUserName = async (repository, userId) => {
  try {
    const user = await repository.findUserById(userId);
    return user?.name ?? null;
  } catch (err) {
    console.warn(`[call] failed to load user profile: ${err?.message || err}`);
    return null;
  }
};

/**
 * Starts an emergency browser-to-browser call request.
 *
 * Verifies the SOS exists, is owned by the caller and is in a state that
 * allows guardian communication, picks the eligible guardian itself (the
 * client never chooses one), refuses to stack a second in-flight call on the
 * same SOS, then persists an OUTGOING call on a backend-generated room.
 *
 * The call is then moved OUTGOING → RINGING in one conditional update and the
 * guardian is notified with `call:ringing` — never the other way round, and
 * never when the transition did not happen, so the event can only ever mean
 * "this call is ringing for this guardian" and can only fire once per call.
 *
 * Returns `{ created: true, call }` or `{ created: false, existing }` — the
 * controller turns the latter into 409, mirroring SOS creation. `call` is the
 * document as the database left it: RINGING after a successful transition,
 * still OUTGOING when the transition was withheld.
 *
 * It never issues a LiveKit token: that stays in `createCallToken`, so a
 * ringing guardian still has to accept and request a token to join a room.
 */
export async function startEmergencyCall({
  sosId,
  userId,
  repository = callRepository,
  emit = emitToUserRoom,
}) {
  const sos = await repository.findSOSById(sosId);

  if (!sos) {
    throw ApiError.notFound('SOS_NOT_FOUND', 'SOS event not found');
  }

  if (String(sos.userId) !== String(userId)) {
    throw ApiError.forbidden('SOS_NOT_AUTHORIZED', 'You do not own this SOS event');
  }

  if (!CALLABLE_SOS_STATUSES.includes(sos.status)) {
    throw ApiError.conflict(
      'SOS_NOT_ACTIVE',
      `An emergency call can only be started for an active SOS (current: ${sos.status})`
    );
  }

  const guardian = await selectGuardian(repository, sos.userId);

  if (!guardian) {
    throw ApiError.conflict(
      'CALL_NO_ELIGIBLE_GUARDIAN',
      'No eligible guardian is available for this emergency call'
    );
  }

  const existing = await repository.findActiveCallBySOS(sosId);

  if (existing) {
    return { created: false, existing };
  }

  // The id exists before the document, so the room is `emergency-call-<callId>`
  // and stays tied to this call without ever coming from the client.
  const callId = new mongoose.Types.ObjectId();
  const ownerId = sos.userId;

  let call;

  try {
    call = await repository.createCall({
      _id: callId,
      sosId: sos._id,
      userId: ownerId,
      guardianUserId: guardian.guardianUserId,
      type: CALL_TYPE.BROWSER_TO_BROWSER,
      status: CALL_STATUS.OUTGOING,
      roomName: `emergency-call-${callId.toString()}`,
      participants: buildParticipants(ownerId, guardian.guardianUserId),
      // The session starts when it is recorded; `/calls/end` derives the
      // duration from this timestamp.
      startedAt: new Date(),
    });
  } catch (err) {
    // Two simultaneous starts: the unique partial index lets exactly one win.
    if (err?.code === 11000) {
      const raced = await repository.findActiveCallBySOS(sosId);

      if (raced) {
        return { created: false, existing: raced };
      }
    }

    throw err;
  }

  // Post-persist and best effort: the record already exists, so a dropped
  // notification can never leave the client believing in a call that failed.
  // The owner hears about it while it is still OUTGOING, before it rings out.
  await emitCallOutgoing({ call, emit });

  // OUTGOING → RINGING in a single conditional write: the status filter makes
  // the flip impossible to apply twice and impossible for a call that has
  // already moved on (ended in between, for example). The guardian is told
  // only after this write lands, so `call:ringing` always describes state the
  // database has actually recorded — never a hopeful "maybe ringing".
  const ringingAt = new Date();
  let ringed = null;

  try {
    ringed = await repository.ringCallAtomically(call._id, ringingAt);
  } catch (err) {
    // The document already exists and stays the source of truth: it is
    // returned as created (still OUTGOING), nobody is rung, and recovery goes
    // through the normal call-state sync rather than a rollback.
    console.warn(`[call] failed to mark the call ringing: ${err?.message || err}`);
  }

  if (ringed) {
    await emitCallRinging({
      call: ringed,
      callerName: await resolveUserName(repository, ownerId),
      emit,
    });
  }

  return { created: true, call: ringed ?? call };
}

/**
 * Accepts an incoming emergency call — the guardian's explicit "I pick up".
 *
 * Flow: find → authorize (must be the assigned guardian) → state check
 * (only RINGING) → atomic RINGING → ACCEPTED → `call:accepted` to the SOS
 * owner (`call.userId`) → response. The socket event is emitted only after
 * the database actually changed, so a client is never told a call was
 * accepted while the backend still has it ringing, and a lost transition
 * emits nothing at all.
 *
 * Authorization and state are re-checked inside the atomic update, so a
 * double-tap or two simultaneous accepts perform exactly one transition; the
 * loser is mapped to the same 409 as any other invalid state and never
 * produces a second `call:accepted`.
 *
 * Acceptance is application-level only: it never mints a token, never joins a
 * room and never touches `connectedAt` — LiveKit proves connectivity later.
 * The event carries the accepting guardian and the acceptance time and
 * nothing else; the SOS is untouched, because a guardian answering does not
 * resolve the emergency.
 *
 * Returns `{ accepted: true, call }`.
 */
export async function acceptCall({
  callId,
  userId,
  repository = callRepository,
  emit = emitToUserRoom,
}) {
  const call = await repository.findById(callId);

  if (!call) {
    throw ApiError.notFound('CALL_NOT_FOUND', 'Call not found');
  }

  // The guardian comes from the token — the SOS owner and any other guardian
  // are refused before the state is even inspected.
  if (String(call.guardianUserId ?? '') !== String(userId)) {
    throw ApiError.forbidden(
      'CALL_NOT_AUTHORIZED',
      'You are not authorized to accept this call'
    );
  }

  if (!ACCEPTABLE_CALL_STATUSES.includes(call.status)) {
    throw ApiError.conflict(
      'CALL_NOT_ACCEPTABLE',
      `Call cannot be accepted in its current state (current: ${call.status})`
    );
  }

  const acceptedAt = new Date();

  const updated = await repository.acceptCallAtomically(callId, userId, acceptedAt);

  if (!updated) {
    // Somebody else moved the call first: read the authoritative state instead
    // of writing again, and never emit an event for a transition we lost.
    const current = (await repository.findById(callId)) || call;

    if (String(current.guardianUserId ?? '') !== String(userId)) {
      throw ApiError.forbidden(
        'CALL_NOT_AUTHORIZED',
        'You are not authorized to accept this call'
      );
    }

    throw ApiError.conflict(
      'CALL_NOT_ACCEPTABLE',
      `Call cannot be accepted in its current state (current: ${current.status})`
    );
  }

  // The waiting SOS owner is told only now, and only from the document the
  // update returned: no acceptance, no event.
  await emitCallAccepted({
    call: updated,
    guardianName: await resolveUserName(repository, userId),
    acceptedAt,
    emit,
  });

  return { accepted: true, call: updated };
}

/**
 * Rejects an incoming emergency call — the guardian's explicit "not answering".
 *
 * Flow: find → authorize (must be the assigned guardian) → state check (only
 * RINGING) → atomic RINGING → REJECTED → `call:rejected` to the SOS owner
 * (`call.userId`) → response. The event is emitted only after the database
 * actually changed, so the frontend is never told a call was declined while
 * it is still ringing, and a lost transition emits nothing at all.
 *
 * The event carries the declining guardian plus the controlled `endReason`
 * and `endedAt` the atomic write recorded — nothing else.
 *
 * Rejection is terminal: `REJECTED` is outside every joinable, endable and
 * connectable set, so the call can never later become ACCEPTED or CONNECTED,
 * and no new call is started from here. A duplicate or concurrent rejection
 * (or an accept racing this write) loses the filter and gets a 409 instead of
 * a second `call:rejected`.
 *
 * The SOS is deliberately untouched. Declining the call does not resolve the
 * emergency — escalation keeps running on its own.
 *
 * No LiveKit work happens: while RINGING there is no media connection to tear
 * down, and the endpoint never mints or revokes a token.
 *
 * Returns `{ rejected: true, call }`.
 */
export async function rejectCall({
  callId,
  userId,
  repository = callRepository,
  emit = emitToUserRoom,
}) {
  const call = await repository.findById(callId);

  if (!call) {
    throw ApiError.notFound('CALL_NOT_FOUND', 'Call not found');
  }

  // The guardian comes from the token — the SOS owner and any other guardian
  // are refused before the state is even inspected.
  if (String(call.guardianUserId ?? '') !== String(userId)) {
    throw ApiError.forbidden('CALL_NOT_AUTHORIZED', 'You are not authorized to reject this call');
  }

  if (!REJECTABLE_CALL_STATUSES.includes(call.status)) {
    throw ApiError.conflict(
      'CALL_NOT_REJECTABLE',
      `Call cannot be rejected in its current state (current: ${call.status})`
    );
  }

  const rejectedAt = new Date();

  const updated = await repository.rejectCallAtomically(callId, userId, rejectedAt);

  if (!updated) {
    // Duplicate or concurrent rejection: read the authoritative state instead
    // of writing again, and never emit an event for a transition we lost.
    const current = (await repository.findById(callId)) || call;

    if (String(current.guardianUserId ?? '') !== String(userId)) {
      throw ApiError.forbidden('CALL_NOT_AUTHORIZED', 'You are not authorized to reject this call');
    }

    throw ApiError.conflict(
      'CALL_NOT_REJECTABLE',
      `Call cannot be rejected in its current state (current: ${current.status})`
    );
  }

  // The waiting SOS owner is told only now, and only from the document the
  // update returned: their ringing UI stops, the SOS keeps running.
  await emitCallRejected({
    call: updated,
    guardianName: await resolveUserName(repository, userId),
    emit,
  });

  return { rejected: true, call: updated };
}

/**
 * Ends an in-flight call for one of its two participants.
 *
 * Flow: find → authorize → atomic ENDED transition → `call:ended` to both
 * participants → response. The socket event is emitted only after the
 * database actually changed the state, so a client can never be told a call
 * ended while the backend still has it active, and `endedBy` is derived from
 * the authenticated participant — never from the request body.
 *
 * Repeating the request on an already ENDED call is idempotent: the existing
 * record is returned, nothing is written and nobody is notified a second time.
 * Any other terminal state (FAILED / CANCELLED / REJECTED) is a 409.
 *
 * Ending a call touches nothing else: the SOS keeps its own state machine and
 * no new call is ever started from here.
 *
 * Returns `{ ended: true, call }` after a real transition, or
 * `{ ended: false, call }` for the idempotent replay.
 */
export async function endCall({
  callId,
  userId,
  endReason = null,
  repository = callRepository,
  emit = emitToUserRoom,
}) {
  const call = await repository.findById(callId);

  if (!call) {
    throw ApiError.notFound('CALL_NOT_FOUND', 'Call not found');
  }

  const isParticipant =
    String(call.userId) === String(userId) || String(call.guardianUserId ?? '') === String(userId);

  if (!isParticipant) {
    throw ApiError.forbidden('CALL_NOT_AUTHORIZED', 'Only a participant of this call can end it');
  }

  // The timestamp comes from the server — a client-supplied endedAt never
  // reaches the document.
  const endedAt = new Date();

  const updated = await repository.endCallAtomically(callId, ENDABLE_CALL_STATUSES, {
    status: CALL_STATUS.ENDED,
    endedAt,
    updatedAt: endedAt,
    ...(endReason ? { endReason } : {}),
  });

  if (!updated) {
    // Lost the race, or the call was already terminal: read the authoritative
    // state instead of writing again.
    const current = (await repository.findById(callId)) || call;

    if (current.status === CALL_STATUS.ENDED) {
      return { ended: false, call: current };
    }

    throw ApiError.conflict(
      'CALL_ALREADY_TERMINAL',
      `Call is already ${current.status} and cannot be ended`
    );
  }

  await emitCallEnded({
    call: updated,
    endedAt,
    endedBy: { userId, role: resolveParticipantRole(updated, userId) },
    emit,
  });

  return { ended: true, call: updated };
}
