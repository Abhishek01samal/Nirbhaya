export const SOS_TRIGGER_TYPES = Object.freeze([
  'MANUAL',
  'VOICE_DANGER',
  'OFF_ROUTE',
  'LONG_STOP',
]);

export const SOS_STATUS = Object.freeze({
  VERIFYING: 'VERIFYING',
  ACTIVE: 'ACTIVE',
  CANCELLED: 'CANCELLED',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  RESOLVED: 'RESOLVED',
  ESCALATING: 'ESCALATING',
});

export const UNRESOLVED_STATUSES = Object.freeze([
  SOS_STATUS.VERIFYING,
  SOS_STATUS.ACTIVE,
  SOS_STATUS.ACKNOWLEDGED,
  SOS_STATUS.ESCALATING,
]);

export const HISTORICAL_STATUSES = Object.freeze([
  SOS_STATUS.CANCELLED,
  SOS_STATUS.RESOLVED,
]);

export const DEFAULT_VERIFICATION_TIMEOUT_SECONDS = 10;

/**
 * Recorded outcome of the verification window (`verification.userResponse`).
 * TIMEOUT means the backend timer activated the SOS: the user never answered,
 * and the original trigger information stays untouched (§17).
 */
export const VERIFICATION_RESPONSE = Object.freeze({
  CONFIRMED: 'CONFIRMED',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
});

/**
 * Human-readable reasons carried by the `sos:cancelled` / `sos:timeout`
 * notifications. Payload-only: the persisted outcome lives in
 * `verification.userResponse`, so no new reason types are stored.
 */
export const VERIFICATION_REASONS = Object.freeze({
  USER_CANCELLED: 'USER_CANCELLED',
  VERIFICATION_TIMEOUT: 'VERIFICATION_TIMEOUT',
});

/**
 * Reasons carried by the `sos:escalating` lifecycle notification. Payload-only
 * (same convention as VERIFICATION_REASONS): each reason is derived from the
 * persisted previous level's TIMEOUT status, which the escalation classifiers
 * guarantee before a responder/police level can be written — never invented.
 */
export const ESCALATION_REASONS = Object.freeze({
  GUARDIAN_TIMEOUT: 'GUARDIAN_TIMEOUT',
  RESPONDER_TIMEOUT: 'RESPONDER_TIMEOUT',
});

/**
 * Escalation level kinds. The prototype implements the guardian level only;
 * NEARBY_RESPONDER / POLICE are named here so stored levels and future work
 * share one vocabulary.
 */
export const ESCALATION_LEVEL_TYPE = Object.freeze({
  GUARDIAN: 'GUARDIAN',
  NEARBY_RESPONDER: 'NEARBY_RESPONDER',
  POLICE: 'POLICE',
});

/**
 * Lifecycle of a single escalation level. ACKNOWLEDGED deliberately reuses
 * the same string as SOS_STATUS.ACKNOWLEDGED (existing acknowledge flow already
 * writes it into level status). NOTIFIED is the police level's "escalated to
 * the prototype station" state: nobody acknowledged it, it is simply told —
 * it never receives a timeout timer and is never faked as acknowledged.
 */
export const ESCALATION_LEVEL_STATUS = Object.freeze({
  PENDING: 'PENDING',
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  TIMEOUT: 'TIMEOUT',
  NOTIFIED: 'NOTIFIED',
});

export const DEFAULT_GUARDIAN_ESCALATION_TIMEOUT_SECONDS = 60;

export const DEFAULT_RESPONDER_ESCALATION_TIMEOUT_SECONDS = 60;
