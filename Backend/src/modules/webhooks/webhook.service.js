import { emitToUserRoom } from '../../sockets/index.js';
import { emitCallConnected, emitCallDisconnected, emitCallEnded, emitCallFailed, safeEmit } from '../calling/call.events.js';
import * as callRepository from '../calling/call.repository.js';
import {
  CALL_END_REASON,
  CALL_STATUS,
  CONNECTABLE_CALL_STATUSES,
  ENDABLE_CALL_STATUSES,
  TERMINAL_CALL_STATUSES,
} from '../calling/call.constants.js';

/**
 * LiveKit webhook → application call state.
 *
 * Rules that are never broken here:
 *
 * - Only verified events reach this module (the controller authenticates the
 *   signature first), and even then LiveKit never decides ownership: `userId`,
 *   `guardianUserId` and `sosId` are only ever read, never written.
 * - Rooms map to calls through the backend-generated `roomName`. Unknown rooms
 *   are logged and acknowledged — a call document is never created here.
 * - Participant identities are matched against the stored `participants`;
 *   anything else is logged and ignored.
 * - Every transition is a single conditional update, so duplicate, delayed or
 *   out-of-order webhooks are no-ops: no second timestamp, no second socket
 *   event, no jump out of a terminal state (ENDED/REJECTED/CANCELLED/FAILED).
 * - The SOS is never touched: ending a call and resolving an SOS are separate
 *   state machines.
 * - Socket events are emitted only after the database actually changed, and
 *   only to the two participants (never broadcast).
 *
 * Event mapping:
 *
 *   room_started                → log only (a room proves nothing about state)
 *   participant_joined          → presence; ACCEPTED → CONNECTED when both
 *                                 expected participants are in the room
 *   participant_left            → in-flight → ENDED (PARTICIPANT_LEFT)
 *   participant_connection_aborted → in-flight → FAILED + `call:failed`
 *                                 (unrecoverable: never a retryable
 *                                 `call:disconnected`, never an app-level end)
 *   room_finished               → in-flight → ENDED (ROOM_FINISHED)
 */

const handlers = {
  room_started: handleRoomStarted,
  room_finished: handleRoomFinished,
  participant_joined: handleParticipantJoined,
  participant_left: handleParticipantLeft,
  participant_connection_aborted: handleConnectionAborted,
};

const roomNameOf = (event) => event?.room?.name || '';
const identityOf = (event) => event?.participant?.identity || '';

const logLine = (log, parts) => log.info(`[webhook] ${parts.join(' ')}`);

const findCall = async (repository, log, event) => {
  const roomName = roomNameOf(event);
  const call = await repository.findCallByRoomName(roomName);

  if (!call) {
    logLine(log, [
      `event=${event.event}`,
      `id=${event.id || '-'}`,
      `room=${roomName || '<missing>'}`,
      'result=unknown-room',
    ]);
    return null;
  }

  return call;
};

/** Returns the stored participant for this identity, or null when unknown. */
const findParticipant = (call, identity, log, event) => {
  const participant = (call.participants || []).find((p) => p.identity === identity);

  if (!participant) {
    logLine(log, [
      `event=${event.event}`,
      `call=${call._id}`,
      `identity=${identity || '<missing>'}`,
      'result=unknown-participant',
    ]);
    return null;
  }

  return participant;
};

/** room_started: the room existing says nothing about the application call. */
async function handleRoomStarted(event, { repository, log }) {
  const call = await findCall(repository, log, event);

  logLine(log, [
    `event=room_started`,
    `id=${event.id || '-'}`,
    `room=${roomNameOf(event) || '<missing>'}`,
    `call=${call ? String(call._id) : 'unknown'}`,
    'result=acknowledged',
  ]);

  return { callId: call ? String(call._id) : null, changed: false };
}

/** room_finished: the room is gone — finalize an in-flight call. */
async function handleRoomFinished(event, { repository, emit, log }) {
  const call = await findCall(repository, log, event);
  if (!call) return { callId: null, changed: false };

  if (TERMINAL_CALL_STATUSES.includes(call.status)) {
    logLine(log, [
      `event=room_finished`,
      `call=${call._id}`,
      `status=${call.status}`,
      'result=already-terminal',
    ]);
    return { callId: String(call._id), changed: false };
  }

  const wasConnected = call.status === CALL_STATUS.CONNECTED;
  const endedAt = new Date();

  const ended = await repository.markEndedFromWebhook(call._id, ENDABLE_CALL_STATUSES, {
    endedAt,
    endReason: CALL_END_REASON.ROOM_FINISHED,
  });

  if (!ended) {
    return { callId: String(call._id), changed: false };
  }

  if (wasConnected) {
    await emitCallDisconnected({ call, identity: null, disconnectedAt: endedAt, emit });
  }

  await emitCallEnded({ call: ended, endedAt: ended.endedAt, emit });

  logLine(log, [
    `event=room_finished`,
    `call=${call._id}`,
    'status=ENDED',
    'result=transitioned',
  ]);

  return { callId: String(call._id), changed: true };
}

/** participant_joined: presence, and ACCEPTED → CONNECTED when both are in. */
async function handleParticipantJoined(event, { repository, emit, log }) {
  const call = await findCall(repository, log, event);
  if (!call) return { callId: null, changed: false };

  const identity = identityOf(event);
  if (!findParticipant(call, identity, log, event)) {
    return { callId: String(call._id), changed: false };
  }

  // Idempotent: presence is only written the first time the identity joins.
  await repository.markParticipantJoined(call._id, identity);

  const current = (await repository.findById(call._id)) || call;
  const bothPresent =
    Array.isArray(current.participants) &&
    current.participants.length >= 2 &&
    current.participants.every((p) => p.joinedAt);

  if (!bothPresent) {
    logLine(log, [
      `event=participant_joined`,
      `call=${current._id}`,
      'result=waiting-for-participants',
    ]);
    return { callId: String(current._id), changed: false };
  }

  if (!CONNECTABLE_CALL_STATUSES.includes(current.status)) {
    // Never jump into CONNECTED from a terminal state, from a state the
    // application has not accepted from, or twice.
    logLine(log, [
      `event=participant_joined`,
      `call=${current._id}`,
      `status=${current.status}`,
      'result=not-connectable',
    ]);
    return { callId: String(current._id), changed: false };
  }

  const connectedAt = new Date();
  const connected = await repository.markConnected(current._id, CONNECTABLE_CALL_STATUSES, connectedAt);

  if (!connected) {
    return { callId: String(current._id), changed: false };
  }

  await emitCallConnected({ call: connected, connectedAt, emit });

  logLine(log, [
    `event=participant_joined`,
    `call=${connected._id}`,
    'status=CONNECTED',
    'result=transitioned',
  ]);

  return { callId: String(connected._id), changed: true };
}

/** participant_left: an expected participant dropped — finalize the call. */
async function handleParticipantLeft(event, { repository, emit, log }) {
  const call = await findCall(repository, log, event);
  if (!call) return { callId: null, changed: false };

  const identity = identityOf(event);
  if (!findParticipant(call, identity, log, event)) {
    return { callId: String(call._id), changed: false };
  }

  if (TERMINAL_CALL_STATUSES.includes(call.status)) {
    logLine(log, [
      `event=participant_left`,
      `call=${call._id}`,
      `status=${call.status}`,
      'result=already-terminal',
    ]);
    return { callId: String(call._id), changed: false };
  }

  const presenceChanged = Boolean(await repository.markParticipantLeft(call._id, identity));
  const endedAt = new Date();

  const ended = await repository.markEndedFromWebhook(call._id, ENDABLE_CALL_STATUSES, {
    endedAt,
    endReason: CALL_END_REASON.PARTICIPANT_LEFT,
  });

  if (!ended) {
    // Somebody else finalized the call between our read and this update.
    if (presenceChanged) {
      await emitCallDisconnected({ call, identity, disconnectedAt: endedAt, emit });
    }
    return { callId: String(call._id), changed: presenceChanged };
  }

  await emitCallDisconnected({ call, identity, disconnectedAt: endedAt, emit });
  await emitCallEnded({ call: ended, endedAt: ended.endedAt, emit });

  logLine(log, [
    `event=participant_left`,
    `call=${call._id}`,
    `identity=${identity}`,
    'status=ENDED',
    'result=transitioned',
  ]);

  return { callId: String(call._id), changed: true };
}

/**
 * participant_connection_aborted: LiveKit could not keep the media alive —
 * an unrecoverable failure, not a retryable disconnect. The FAILED write and
 * `call:failed` follow the same order as every other emission: database
 * first, socket second, and never a socket event without a successful write.
 */
async function handleConnectionAborted(event, { repository, emit, log }) {
  const call = await findCall(repository, log, event);
  if (!call) return { callId: null, changed: false };

  const identity = identityOf(event);
  if (identity && !findParticipant(call, identity, log, event)) {
    return { callId: String(call._id), changed: false };
  }

  if (TERMINAL_CALL_STATUSES.includes(call.status)) {
    logLine(log, [
      `event=participant_connection_aborted`,
      `call=${call._id}`,
      `status=${call.status}`,
      'result=already-terminal',
    ]);
    return { callId: String(call._id), changed: false };
  }

  const endedAt = new Date();

  const failed = await repository.markFailedFromWebhook(call._id, ENDABLE_CALL_STATUSES, {
    endedAt,
    endReason: CALL_END_REASON.FAILED,
  });

  if (!failed) {
    return { callId: String(call._id), changed: false };
  }

  await emitCallFailed({ call: failed, failedAt: endedAt, emit });

  logLine(log, [
    `event=participant_connection_aborted`,
    `call=${call._id}`,
    'status=FAILED',
    'result=transitioned',
  ]);

  return { callId: String(call._id), changed: true };
}

/**
 * Dispatches one signature-verified LiveKit event.
 *
 * Returns `{ handled, eventType, callId, changed }` for logging; it never
 * throws for unknown rooms or unsupported event types, because a valid webhook
 * must always be acknowledged with success.
 */
export async function handleLiveKitEvent(event, options = {}) {
  const repository = options.repository ?? callRepository;
  const emit = options.emit ?? emitToUserRoom;
  const log = options.logger ?? console;

  const eventType = typeof event?.event === 'string' ? event.event : '';
  const handler = handlers[eventType];

  logLine(log, [
    `event=${eventType || '<missing>'}`,
    `id=${event?.id || '-'}`,
    `room=${roomNameOf(event) || '<missing>'}`,
  ]);

  if (!handler) {
    logLine(log, [`event=${eventType || '<missing>'}`, 'result=unsupported']);
    return { handled: false, eventType, callId: null, changed: false };
  }

  const result = await handler(event, { repository, emit, log });

  return { handled: true, eventType, ...result };
}
