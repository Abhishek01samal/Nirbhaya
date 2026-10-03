/**
 * Socket.IO events for the SOS escalation flow.
 *
 * Event names, payloads and best-effort delivery live here so the escalation
 * service stays focused on business rules and never touches `io.to(...)`
 * directly. Delivery is always a notification: a socket outage must never
 * fail — or roll back — a successfully persisted escalation level, because
 * the database remains the source of truth.
 */

import { safeEmit } from '../calling/call.events.js';
import {
  ESCALATION_LEVEL_STATUS,
  ESCALATION_LEVEL_TYPE,
  SOS_STATUS,
  VERIFICATION_REASONS,
} from './sos.constants.js';

/**
 * Known SOS events: the four verification notifications first (they surround
 * the backend-authoritative verification state machine), then the escalation
 * levels. Later levels extend this map rather than hard-coding strings.
 */
export const SOS_EVENT = Object.freeze({
  VERIFICATION_REQUIRED: 'sos:verification-required',
  CONFIRMED: 'sos:confirmed',
  CANCELLED: 'sos:cancelled',
  TIMEOUT: 'sos:timeout',
  GUARDIAN_NOTIFY: 'sos:guardian:notify',
  GUARDIAN_ACKNOWLEDGED: 'sos:guardian:acknowledged',
  RESPONDER_NOTIFY: 'sos:responder:notify',
  RESPONDER_ACKNOWLEDGED: 'sos:responder:acknowledged',
  POLICE_ESCALATED: 'sos:police:escalated',
});

/**
 * Owner-room LIFECYCLE notifications (§22): a parallel, coarser view of the
 * same state machine for the SOS owner's own UI — activation, guardian stage
 * changes, escalation-stage moves and resolution. Kept in a separate map
 * because `sos:guardian-acknowledged` (lifecycle) is a different channel from
 * `sos:guardian:acknowledged` (detailed): both are emitted, they never replace
 * each other, and neither ever replaces a REST read (§19).
 */
export const SOS_LIFECYCLE_EVENT = Object.freeze({
  ACTIVATED: 'sos:activated',
  GUARDIAN_NOTIFIED: 'sos:guardian-notified',
  GUARDIAN_ACKNOWLEDGED: 'sos:guardian-acknowledged',
  ESCALATING: 'sos:escalating',
  RESOLVED: 'sos:resolved',
});

/**
 * Responder-channel notifications around the SAME responder escalation state:
 * `responder:sos-notification` when the level is written, `responder:sos-
 * acknowledged` when a notified responder accepts it, `responder:sos-expired`
 * when the response window closes. Kept in their own map because they are a
 * different channel from `sos:responder:notify` / `sos:responder:acknowledged`
 * (detailed) and from the owner-room lifecycle events: all three are emitted,
 * they never replace each other, they never replace a REST read, and none of
 * them is ever a client-originated event — the backend generates them after
 * the database write.
 */
export const RESPONDER_SOS_EVENT = Object.freeze({
  NOTIFICATION: 'responder:sos-notification',
  ACKNOWLEDGED: 'responder:sos-acknowledged',
  EXPIRED: 'responder:sos-expired',
});

const toIso = (value) => (value ? new Date(value).toISOString() : null);

/**
 * `sos:verification-required` payload: everything the verification UI needs —
 * which SOS just entered VERIFYING, what triggered it, where, and how long
 * the user has to answer before the backend timer activates it.
 *
 * Common fields (§20): sosId, status, timestamp, triggerType. Location is
 * `{lat, lng}` only (never the free-text address); no safety-session id, no
 * escalation history, no internal database fields.
 */
export const verificationRequiredPayload = ({ sos, timeoutSeconds }) => ({
  sosId: String(sos._id),
  status: SOS_STATUS.VERIFYING,
  triggerType: sos.triggerType ?? null,
  timestamp: toIso(sos.createdAt) ?? toIso(new Date()),
  triggerData: sos.triggerData ?? null,
  location: sos.location ? { lat: sos.location.lat, lng: sos.location.lng } : null,
  verification: {
    expiresAt: toIso(sos.verification?.expiresAt),
    timeoutSeconds,
  },
});

/**
 * Tells the SOS owner's browser that a freshly created SOS is waiting for
 * verification — emitted only AFTER the document was persisted, to the
 * owner's private `user:<id>` room (never a broadcast). Best effort: a
 * dropped notification never affects the SOS; the frontend recovers state
 * through GET /api/v1/sos/active and GET /api/v1/sos/:id.
 *
 * Returns true when the notification was handed to the socket layer.
 */
export const emitVerificationRequired = async ({ sos, timeoutSeconds, emit }) => {
  if (!sos?._id || !sos.userId) return false;

  await safeEmit(
    emit,
    String(sos.userId),
    SOS_EVENT.VERIFICATION_REQUIRED,
    verificationRequiredPayload({ sos, timeoutSeconds })
  );

  return true;
};

/**
 * `sos:confirmed` payload: the verification was explicitly confirmed, so the
 * SOS is now ACTIVE. `previousStatus` documents the transition that actually
 * happened; `timestamp`/`confirmedAt` are the server-generated response time.
 */
export const confirmedPayload = ({ sos, previousStatus, confirmedAt }) => ({
  sosId: String(sos._id),
  status: SOS_STATUS.ACTIVE,
  previousStatus: previousStatus ?? SOS_STATUS.VERIFYING,
  timestamp: toIso(confirmedAt),
  triggerType: sos.triggerType ?? null,
  confirmedAt: toIso(confirmedAt),
});

/**
 * Tells the SOS owner's browser that their confirmation was accepted. Called
 * only AFTER the atomic VERIFYING -> ACTIVE write succeeded, so duplicates,
 * losing racers and failed transitions never notify anyone. Owner's private
 * room, best effort, no internal fields.
 */
export const emitSosConfirmed = async ({ sos, previousStatus, confirmedAt, emit }) => {
  if (!sos?._id || !sos.userId || !confirmedAt) return false;

  await safeEmit(
    emit,
    String(sos.userId),
    SOS_EVENT.CONFIRMED,
    confirmedPayload({ sos, previousStatus, confirmedAt })
  );

  return true;
};

/**
 * `sos:cancelled` payload: the verification was dismissed as a mistake, so
 * the SOS is CANCELLED and nobody was (or will be) notified. `reason` is the
 * payload-side outcome label; the persisted outcome stays in
 * `verification.userResponse`.
 */
export const cancelledPayload = ({ sos, previousStatus, cancelledAt, reason }) => ({
  sosId: String(sos._id),
  status: SOS_STATUS.CANCELLED,
  previousStatus: previousStatus ?? SOS_STATUS.VERIFYING,
  timestamp: toIso(cancelledAt),
  triggerType: sos.triggerType ?? null,
  cancelledAt: toIso(cancelledAt),
  reason: reason ?? VERIFICATION_REASONS.USER_CANCELLED,
});

/**
 * Tells the SOS owner's browser that the verification was cancelled. Same
 * rules as emitSosConfirmed: persisted transition first, owner's private
 * room only, best effort, withheld without an owner or a timestamp.
 */
export const emitSosCancelled = async ({ sos, previousStatus, cancelledAt, reason, emit }) => {
  if (!sos?._id || !sos.userId || !cancelledAt) return false;

  await safeEmit(
    emit,
    String(sos.userId),
    SOS_EVENT.CANCELLED,
    cancelledPayload({ sos, previousStatus, cancelledAt, reason })
  );

  return true;
};

/**
 * `sos:timeout` payload: nobody answered the verification dialog in time, so
 * the backend timer activated the SOS. `reason` is VERIFICATION_TIMEOUT and
 * the original trigger information is preserved in the database (and via
 * `triggerType` here) — a timeout is an outcome, not a new trigger.
 */
export const timeoutPayload = ({ sos, previousStatus, timedOutAt, reason }) => ({
  sosId: String(sos._id),
  status: SOS_STATUS.ACTIVE,
  previousStatus: previousStatus ?? SOS_STATUS.VERIFYING,
  timestamp: toIso(timedOutAt),
  triggerType: sos.triggerType ?? null,
  reason: reason ?? VERIFICATION_REASONS.VERIFICATION_TIMEOUT,
  timedOutAt: toIso(timedOutAt),
});

/**
 * Tells the SOS owner's browser that the verification window expired and the
 * SOS was activated. Same rules as the other verification emitters: the
 * atomic VERIFYING -> ACTIVE write must already have succeeded, owner's
 * private room only, best effort — a dropped notification never stops the
 * escalation that follows.
 */
export const emitSosTimeout = async ({ sos, previousStatus, timedOutAt, reason, emit }) => {
  if (!sos?._id || !sos.userId || !timedOutAt) return false;

  await safeEmit(
    emit,
    String(sos.userId),
    SOS_EVENT.TIMEOUT,
    timeoutPayload({ sos, previousStatus, timedOutAt, reason })
  );

  return true;
};

/**
 * `sos:guardian:notify` payload: everything the guardian's emergency view
 * needs — which SOS, which escalation level reached them, who needs help
 * (the SOS owner), where, and how long they have to respond before the level
 * times out.
 *
 * Location is deliberately `{lat, lng}` only (never the free-text address),
 * and the payload carries no tokens, no room names, no profile documents and
 * no other escalation history.
 */
export const guardianNotifyPayload = ({ sosId, level, status, user, location, expiresAt }) => ({
  sosId: String(sosId),
  level: level ?? ESCALATION_LEVEL_TYPE.GUARDIAN,
  status: status ?? ESCALATION_LEVEL_STATUS.PENDING,
  user: {
    userId: user?.userId ? String(user.userId) : null,
    name: user?.name ?? null,
  },
  location: location ? { lat: location.lat, lng: location.lng } : null,
  expiresAt: toIso(expiresAt),
});

/**
 * Tells the assigned guardian's browser that a guardian escalation level is
 * waiting for their response — "this SOS escalated to you", and nothing more:
 * not an acknowledgement, not a resolution, not any other recipient.
 *
 * Recipient: `guardianUserId`, chosen by the server-side guardian selection
 * and read back from the stored level — never a client-supplied id, never a
 * broadcast, never every guardian. Must only be called after the escalation
 * level exists in the database, and is always best effort: a dropped
 * notification never rolls the level back, the client recovers state through
 * REST.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when there was no recipient to tell.
 */
export const emitGuardianNotify = async ({
  sosId,
  guardianUserId,
  user,
  location,
  status,
  expiresAt,
  emit,
}) => {
  if (!guardianUserId) return false;

  await safeEmit(
    emit,
    String(guardianUserId),
    SOS_EVENT.GUARDIAN_NOTIFY,
    guardianNotifyPayload({
      sosId,
      level: ESCALATION_LEVEL_TYPE.GUARDIAN,
      status: status ?? ESCALATION_LEVEL_STATUS.PENDING,
      user,
      location,
      expiresAt,
    })
  );

  return true;
};

/**
 * `sos:responder:notify` payload: tells one notified nearby responder that a
 * responder escalation level is waiting — which SOS, who needs help, where
 * (display only), how long they have to respond, and the prototype 2 km
 * business-rule label.
 *
 * `radiusKm` is a LABEL, never a measured distance: this payload is produced
 * from the hardcoded prototype responder dataset and carries no computed
 * proximity, no distance and no ranking. Location is the SOS's own stored
 * `{lat, lng}` for display — it is never used to match responders.
 *
 * Like `guardianNotifyPayload`: no tokens, no room names, no profile
 * documents, no escalation history, no credentials.
 */
export const responderNotifyPayload = ({ sosId, level, status, radiusKm, user, location, expiresAt }) => ({
  sosId: String(sosId),
  level: level ?? ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
  status: status ?? ESCALATION_LEVEL_STATUS.PENDING,
  radiusKm: radiusKm ?? null,
  user: {
    userId: user?.userId ? String(user.userId) : null,
    name: user?.name ?? null,
  },
  location: location ? { lat: location.lat, lng: location.lng } : null,
  expiresAt: toIso(expiresAt),
});

/**
 * Tells each selected prototype responder's browser that they were notified
 * of a nearby-responder escalation — one PRIVATE `user:<id>` room per
 * responder (never a broadcast, never a global room, never a client-supplied
 * recipient list: the ids come from the persisted level).
 *
 * Must only be called after the escalation level exists in the database, and
 * is always best effort: a dropped notification never rolls the level back,
 * responders and the SOS owner recover state through REST.
 *
 * Returns the number of recipients the notification was handed to.
 */
export const emitResponderNotify = async ({
  sosId,
  responderIds,
  user,
  location,
  radiusKm,
  expiresAt,
  emit,
}) => {
  const ids = (Array.isArray(responderIds) ? responderIds : []).filter(Boolean);

  if (!ids.length) return 0;

  const payload = responderNotifyPayload({
    sosId,
    level: ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
    status: ESCALATION_LEVEL_STATUS.PENDING,
    radiusKm,
    user,
    location,
    expiresAt,
  });

  for (const responderId of ids) {
    await safeEmit(emit, String(responderId), SOS_EVENT.RESPONDER_NOTIFY, payload);
  }

  return ids.length;
};

/**
 * `responder:sos-notification` — the responder-channel twin of
 * emitResponderNotify (Nearby Responder event contract §3-§7): emitted only
 * after the responder level exists in the database, to exactly the responders
 * recorded on that persisted level — one PRIVATE `user:<id>` room per
 * responder, never a broadcast, never the owner, never a client-supplied
 * recipient. Payload is the §4 contract (reusing responderNotifyPayload):
 * sosId, level, status, radiusKm (the 2 km label, never a measured distance),
 * the SOS owner's {userId, name}, the SOS's display-only location and the
 * persisted expiry. Best effort: a dropped notification never rolls the level
 * back, responders recover state through REST.
 *
 * Returns the number of recipients the notification was handed to.
 */
export const emitResponderSosNotification = async ({
  sosId,
  responderIds,
  user,
  location,
  radiusKm,
  expiresAt,
  emit,
}) => {
  const ids = (Array.isArray(responderIds) ? responderIds : []).filter(Boolean);

  if (!ids.length) return 0;

  const payload = responderNotifyPayload({
    sosId,
    level: ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
    status: ESCALATION_LEVEL_STATUS.PENDING,
    radiusKm,
    user,
    location,
    expiresAt,
  });

  for (const responderId of ids) {
    await safeEmit(emit, String(responderId), RESPONDER_SOS_EVENT.NOTIFICATION, payload);
  }

  return ids.length;
};

/**
 * `sos:guardian:acknowledged` payload: the SOS owner learns their guardian
 * responded — which SOS, which level, who acknowledged and when. Enough to
 * stop the "waiting for guardian…" UI; it carries no SOS status, resolves
 * nothing and contains no other escalation history.
 */
export const guardianAcknowledgedPayload = ({ sosId, guardian, acknowledgedAt }) => ({
  sosId: String(sosId),
  level: ESCALATION_LEVEL_TYPE.GUARDIAN,
  status: ESCALATION_LEVEL_STATUS.ACKNOWLEDGED,
  guardian: {
    userId: guardian?.userId ? String(guardian.userId) : null,
    name: guardian?.name ?? null,
  },
  acknowledgedAt: toIso(acknowledgedAt),
});

/**
 * Tells the SOS owner's browser that the guardian acknowledged the pending
 * escalation — emitted only AFTER the atomic PENDING -> ACKNOWLEDGED write
 * succeeded, so duplicates, idempotent replays and losing racers never notify
 * anyone. Recipient: `ownerUserId` from the stored SOS (the owner's private
 * `user:<id>` room — never a broadcast, never the guardian, never a
 * client-supplied id). Delivery stays best effort: a dropped notification
 * never rolls the acknowledgement back, the frontend recovers state through
 * the GET escalation endpoints.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitGuardianAcknowledged = async ({
  sosId,
  ownerUserId,
  guardian,
  acknowledgedAt,
  emit,
}) => {
  if (!ownerUserId) return false;
  if (!acknowledgedAt) return false;

  await safeEmit(
    emit,
    String(ownerUserId),
    SOS_EVENT.GUARDIAN_ACKNOWLEDGED,
    guardianAcknowledgedPayload({ sosId, guardian, acknowledgedAt })
  );

  return true;
};

/**
 * `sos:responder:acknowledged` payload: the SOS owner learns one of the
 * notified nearby responders responded — which responder (id + display name)
 * and when. The full notified list and every other level stay out of the
 * payload; they live in the database.
 */
export const responderAcknowledgedPayload = ({ sosId, responder, acknowledgedAt }) => ({
  sosId: String(sosId),
  level: ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
  status: ESCALATION_LEVEL_STATUS.ACKNOWLEDGED,
  responder: {
    responderId: responder?.responderId ? String(responder.responderId) : null,
    name: responder?.name ?? null,
  },
  acknowledgedAt: toIso(acknowledgedAt),
});

/**
 * Tells the SOS owner's browser that a nearby responder acknowledged the
 * escalation. Same rules as emitGuardianAcknowledged: database write first,
 * private owner room only, best-effort delivery, withheld without a stored
 * acknowledgement timestamp or an owner to tell.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitResponderAcknowledged = async ({
  sosId,
  ownerUserId,
  responder,
  acknowledgedAt,
  emit,
}) => {
  if (!ownerUserId) return false;
  if (!acknowledgedAt) return false;

  await safeEmit(
    emit,
    String(ownerUserId),
    SOS_EVENT.RESPONDER_ACKNOWLEDGED,
    responderAcknowledgedPayload({ sosId, responder, acknowledgedAt })
  );

  return true;
};

/**
 * `responder:sos-acknowledged` — the responder-channel twin of
 * emitResponderAcknowledged (§10-§11): the SOS owner's PRIVATE room learns a
 * notified responder accepted responsibility for the current responder
 * level. Same guards as every acknowledgement emitter (owner to tell,
 * stored acknowledgement timestamp — withheld otherwise), same §11 payload
 * (reusing responderAcknowledgedPayload). Emitted only after the atomic
 * PENDING -> ACKNOWLEDGED write, so duplicate acknowledgements and losing
 * racers never notify anyone. It never resolves the SOS (§12): the SOS stays
 * active until the existing resolution workflow runs.
 *
 * Returns true when the notification was handed to the socket layer, false
 * when it was withheld.
 */
export const emitResponderSosAcknowledged = async ({
  sosId,
  ownerUserId,
  responder,
  acknowledgedAt,
  emit,
}) => {
  if (!ownerUserId) return false;
  if (!acknowledgedAt) return false;

  await safeEmit(
    emit,
    String(ownerUserId),
    RESPONDER_SOS_EVENT.ACKNOWLEDGED,
    responderAcknowledgedPayload({ sosId, responder, acknowledgedAt })
  );

  return true;
};

/**
 * `responder:sos-expired` payload (§16-§17): the responder response window
 * closed without a valid acknowledgement. `status` is the PERSISTED level
 * status — TIMEOUT, the existing schema convention, never a second "EXPIRED"
 * database state — while the event itself is named `responder:sos-expired`.
 * `reason` is the payload-only escalation reason label, and `expiredAt` the
 * persisted `expiresAt` instant of that level (clock-free, read from the
 * database write).
 */
export const responderSosExpiredPayload = ({ sosId, status, reason, expiredAt }) => ({
  sosId: String(sosId),
  level: ESCALATION_LEVEL_TYPE.NEARBY_RESPONDER,
  status: status ?? ESCALATION_LEVEL_STATUS.TIMEOUT,
  reason: reason ?? null,
  expiredAt: toIso(expiredAt),
});

/**
 * Tells every responder recorded on the timed-out level that the response
 * window closed — the SAME persisted `notifiedResponders` list that received
 * the notification (history, never recomputed), one PRIVATE `user:<id>` room
 * per responder, never a broadcast and never the SOS owner (the owner hears
 * the stage move through `sos:escalating` from the continuing police
 * escalation, §18/§25). Call only AFTER the atomic PENDING -> TIMEOUT write,
 * best effort like every other emitter.
 *
 * Returns the number of recipients the expiry was handed to.
 */
export const emitResponderSosExpired = async ({
  sosId,
  responderIds,
  status,
  reason,
  expiredAt,
  emit,
}) => {
  const ids = (Array.isArray(responderIds) ? responderIds : []).filter(Boolean);

  if (!ids.length) return 0;

  const payload = responderSosExpiredPayload({ sosId, status, reason, expiredAt });

  for (const responderId of ids) {
    await safeEmit(emit, String(responderId), RESPONDER_SOS_EVENT.EXPIRED, payload);
  }

  return ids.length;
};

/**
 * `sos:police:escalated` payload: the SOS owner learns the escalation reached
 * the prototype police station — which station (id/name/phone) and when. It
 * states the escalation state only: no acknowledgement, no resolution, no
 * claim that a real authority was contacted, and no internal database fields.
 */
export const policeEscalatedPayload = ({ sosId, status, policeStation, escalatedAt }) => ({
  sosId: String(sosId),
  level: ESCALATION_LEVEL_TYPE.POLICE,
  status: status ?? ESCALATION_LEVEL_STATUS.NOTIFIED,
  policeStation: {
    id: policeStation?.id ?? null,
    name: policeStation?.name ?? null,
    phone: policeStation?.phone ?? null,
  },
  escalatedAt: toIso(escalatedAt),
});

/**
 * Tells the SOS owner's browser that the escalation reached the prototype
 * police station. Same rules as the other emitters: database write first,
 * private owner room only, best-effort delivery, withheld without a stored
 * escalation timestamp or an owner to tell.
 *
 * Returns true when the notification was handed to the socket layer,
 * false when it was withheld.
 */
export const emitPoliceEscalated = async ({
  sosId,
  ownerUserId,
  policeStation,
  escalatedAt,
  emit,
}) => {
  if (!ownerUserId) return false;
  if (!escalatedAt) return false;

  await safeEmit(
    emit,
    String(ownerUserId),
    SOS_EVENT.POLICE_ESCALATED,
    policeEscalatedPayload({ sosId, policeStation, escalatedAt })
  );

  return true;
};

// ---------------------------------------------------------------------------
// Owner-room lifecycle notifications (§22): sos:activated / sos:guardian-notified
// / sos:guardian-acknowledged / sos:escalating / sos:resolved.
//
// Same discipline as every detailed emitter above: emitted only AFTER the
// atomic write that produced the state, to the owner's private `user:<id>`
// room only, best effort (a dropped notification never rolls anything back —
// the frontend recovers through GET /api/v1/sos/:id and
// GET /api/v1/sos/:id/escalation, §19), and withheld without the persisted
// timestamp or owner the payload would have to invent.
// ---------------------------------------------------------------------------

/**
 * `sos:activated` payload: the SOS is now ACTIVE and escalation may begin.
 * `previousStatus` documents the transition that actually happened (both
 * activation paths come from VERIFYING), `location` is `{lat, lng}` only, and
 * `activatedAt` is the persisted confirmation/timeout response time.
 */
export const lifecycleActivatedPayload = ({ sos, previousStatus, activatedAt }) => ({
  sosId: String(sos._id),
  status: SOS_STATUS.ACTIVE,
  previousStatus: previousStatus ?? SOS_STATUS.VERIFYING,
  triggerType: sos.triggerType ?? null,
  location: sos.location ? { lat: sos.location.lat, lng: sos.location.lng } : null,
  activatedAt: toIso(activatedAt),
});

/**
 * Tells the SOS owner's browser that the SOS became ACTIVE — emitted right
 * after `sos:confirmed` / `sos:timeout` (§16 ordering), never for a lost
 * verification race or a failed transition. Owner's private room, best effort.
 */
export const emitLifecycleActivated = async ({ sos, previousStatus, activatedAt, emit }) => {
  if (!sos?._id || !sos.userId || !activatedAt) return false;

  await safeEmit(
    emit,
    String(sos.userId),
    SOS_LIFECYCLE_EVENT.ACTIVATED,
    lifecycleActivatedPayload({ sos, previousStatus, activatedAt })
  );

  return true;
};

/**
 * `sos:guardian-notified` payload: the guardian stage of THIS SOS is waiting
 * — which guardian received it (identity is included because the recipient is
 * the owner), when, and until when. No SOS location, no escalation history,
 * no internal fields.
 */
export const lifecycleGuardianNotifiedPayload = ({ sosId, guardian, notifiedAt, expiresAt }) => ({
  sosId: String(sosId),
  level: ESCALATION_LEVEL_TYPE.GUARDIAN,
  status: ESCALATION_LEVEL_STATUS.PENDING,
  guardian: {
    userId: guardian?.userId ? String(guardian.userId) : null,
    name: guardian?.name ?? null,
  },
  notifiedAt: toIso(notifiedAt),
  expiresAt: toIso(expiresAt),
});

/**
 * Tells the SOS owner's browser that their guardian was notified — emitted
 * AFTER the detailed `sos:guardian:notify` (§5: persist, notify guardian,
 * then report it) and only for a PENDING level; a TIMEOUT level with no
 * reachable guardian never claims a notification happened. Owner's private
 * room, best effort, only after the level exists in the database.
 */
export const emitLifecycleGuardianNotified = async ({
  sosId,
  ownerUserId,
  guardian,
  notifiedAt,
  expiresAt,
  emit,
}) => {
  if (!sosId || !ownerUserId || !notifiedAt) return false;

  await safeEmit(
    emit,
    String(ownerUserId),
    SOS_LIFECYCLE_EVENT.GUARDIAN_NOTIFIED,
    lifecycleGuardianNotifiedPayload({ sosId, guardian, notifiedAt, expiresAt })
  );

  return true;
};

/**
 * `sos:guardian-acknowledged` payload: the guardian stage of THIS SOS is
 * answered — who acknowledged and when. Resolves nothing itself; the persisted
 * ACKNOWLEDGED state (and `sos:resolved`, once someone resolves) stays the
 * source of truth.
 */
export const lifecycleGuardianAcknowledgedPayload = ({ sosId, guardian, acknowledgedAt }) => ({
  sosId: String(sosId),
  level: ESCALATION_LEVEL_TYPE.GUARDIAN,
  status: ESCALATION_LEVEL_STATUS.ACKNOWLEDGED,
  guardian: {
    userId: guardian?.userId ? String(guardian.userId) : null,
    name: guardian?.name ?? null,
  },
  acknowledgedAt: toIso(acknowledgedAt),
});

/**
 * Tells the SOS owner's browser that their guardian acknowledged — emitted
 * only AFTER the atomic PENDING -> ACKNOWLEDGED write, so duplicates, replays
 * and losing racers never notify anyone. Owner's private room, best effort;
 * it never resolves the SOS (§13: acknowledgement is not resolution).
 */
export const emitLifecycleGuardianAcknowledged = async ({
  sosId,
  ownerUserId,
  guardian,
  acknowledgedAt,
  emit,
}) => {
  if (!sosId || !ownerUserId || !acknowledgedAt) return false;

  await safeEmit(
    emit,
    String(ownerUserId),
    SOS_LIFECYCLE_EVENT.GUARDIAN_ACKNOWLEDGED,
    lifecycleGuardianAcknowledgedPayload({ sosId, guardian, acknowledgedAt })
  );

  return true;
};

/**
 * `sos:escalating` payload: the escalation moved to a new stage — from which
 * persisted level, to which persisted level, why, and when. `currentLevel` /
 * `previousLevel` are the STORED level types (never a computed guess),
 * `reason` is the derived timeout reason of the previous level, and
 * `status: ESCALATING` is the lifecycle label of the notification itself:
 * the SOS document keeps its own status (§13), the persisted progress lives
 * in `escalation.levels`.
 */
export const lifecycleEscalatingPayload = ({
  sosId,
  currentLevel,
  previousLevel,
  reason,
  escalatedAt,
}) => ({
  sosId: String(sosId),
  status: SOS_STATUS.ESCALATING,
  currentLevel: currentLevel ?? null,
  previousLevel: previousLevel ?? null,
  reason: reason ?? null,
  escalatedAt: toIso(escalatedAt),
});

/**
 * Tells the SOS owner's browser that the escalation entered the next stage.
 * Emitted only for a write winner whose new level actually persisted, AFTER
 * the final still-active re-check and BEFORE the per-recipient notifications
 * of that stage (§16: escalating -> responder/police notification). Owner's
 * private room, best effort, withheld without a stored timestamp.
 */
export const emitLifecycleEscalating = async ({
  sosId,
  ownerUserId,
  currentLevel,
  previousLevel,
  reason,
  escalatedAt,
  emit,
}) => {
  if (!sosId || !ownerUserId || !escalatedAt) return false;

  await safeEmit(
    emit,
    String(ownerUserId),
    SOS_LIFECYCLE_EVENT.ESCALATING,
    lifecycleEscalatingPayload({ sosId, currentLevel, previousLevel, reason, escalatedAt })
  );

  return true;
};

/**
 * `sos:resolved` payload: the SOS is over — which status it came from, when it
 * was resolved, and who resolved it (`type: "USER"` for the owner, otherwise
 * the persisted level type of the acknowledging recipient). Carries no
 * resolution reason: the project persists none, and §13 forbids inventing one.
 */
export const lifecycleResolvedPayload = ({ sos, previousStatus, resolvedAt, resolvedBy }) => ({
  sosId: String(sos._id),
  status: SOS_STATUS.RESOLVED,
  previousStatus: previousStatus ?? null,
  resolvedAt: toIso(resolvedAt),
  resolvedBy: {
    userId: resolvedBy?.userId ? String(resolvedBy.userId) : null,
    type: resolvedBy?.type ?? null,
  },
});

/**
 * Tells the SOS owner's browser that the SOS was resolved — emitted only
 * AFTER the atomic ACKNOWLEDGED -> RESOLVED write, so a losing or duplicate
 * resolve never notifies anyone. Owner's private room, best effort; stopped
 * escalation levels and cancelled timers are the state machine's own concern,
 * not this notification's.
 */
export const emitLifecycleResolved = async ({
  sos,
  previousStatus,
  resolvedAt,
  resolvedBy,
  emit,
}) => {
  if (!sos?._id || !sos.userId || !resolvedAt) return false;

  await safeEmit(
    emit,
    String(sos.userId),
    SOS_LIFECYCLE_EVENT.RESOLVED,
    lifecycleResolvedPayload({ sos, previousStatus, resolvedAt, resolvedBy })
  );

  return true;
};
