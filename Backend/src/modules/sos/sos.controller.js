import { asyncHandler } from '../../utils/asyncHandler.js';
import { sendCreated, sendSuccess, sendError } from '../../utils/response.js';
import {
  createSOS as createSOSService,
  getActiveSOS as getActiveSOSService,
  getSOSById as getSOSByIdService,
  confirmSOS as confirmSOSService,
  cancelSOS as cancelSOSService,
  acknowledgeSOS as acknowledgeSOSService,
  resolveSOS as resolveSOSService,
  getSOSHistory as getSOSHistoryService,
} from './sos.service.js';
import {
  startGuardianEscalation as startEscalationService,
  startResponderEscalation as notifyRespondersService,
  acknowledgeEscalation as acknowledgeEscalationService,
  acknowledgeResponderNotification as acknowledgeResponderService,
  escalateToPolice as escalateToPoliceService,
  getEscalationState as getEscalationStateService,
} from './escalation.service.js';

const toSosResponse = (sos) => ({
  id: String(sos._id),
  userId: sos.userId ? String(sos.userId) : null,
  triggerType: sos.triggerType,
  status: sos.status,
  safetySessionId: sos.safetySessionId ? String(sos.safetySessionId) : null,
  triggerData: sos.triggerData ?? null,
  location: sos.location ?? null,
  verification: {
    expiresAt: sos.verification?.expiresAt ?? null,
    userResponse: sos.verification?.userResponse ?? null,
    respondedAt: sos.verification?.respondedAt ?? null,
  },
  escalation: {
    currentLevel: sos.escalation?.currentLevel ?? 0,
    levels: (Array.isArray(sos.escalation?.levels) ? sos.escalation.levels : []).map((level) => ({
      type: level?.type ?? null,
      status: level?.status ?? null,
      targetId: level?.targetId ? String(level.targetId) : null,
      notifiedAt: level?.notifiedAt ?? null,
      respondedAt: level?.respondedAt ?? null,
    })),
  },
  createdAt: sos.createdAt,
  updatedAt: sos.updatedAt,
  resolvedAt: sos.resolvedAt ?? null,
});

export const createSOS = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const payload = req.body;

  const result = await createSOSService({ userId, payload });

  if (!result.created) {
    return sendError(
      res,
      409,
      'SOS_ALREADY_ACTIVE',
      'An unresolved SOS already exists',
      { existing: toSosResponse(result.sos) }
    );
  }

  return sendCreated(res, toSosResponse(result.sos));
});

export const getActiveSOS = asyncHandler(async (req, res) => {
  const result = await getActiveSOSService({ userId: req.user.id });

  return sendSuccess(res, {
    active: result.active,
    sos: result.sos ? toSosResponse(result.sos) : null,
  });
});

export const getSOSById = asyncHandler(async (req, res) => {
  const sos = await getSOSByIdService({ sosId: req.params.id, userId: req.user.id });

  return sendSuccess(res, toSosResponse(sos));
});

export const confirmSOS = asyncHandler(async (req, res) => {
  const sos = await confirmSOSService({ sosId: req.params.id, userId: req.user.id });

  return sendSuccess(res, toSosResponse(sos));
});

export const cancelSOS = asyncHandler(async (req, res) => {
  const sos = await cancelSOSService({ sosId: req.params.id, userId: req.user.id });

  return sendSuccess(res, toSosResponse(sos));
});

export const acknowledgeSOS = asyncHandler(async (req, res) => {
  const sos = await acknowledgeSOSService({ sosId: req.params.id, userId: req.user.id });

  return sendSuccess(res, toSosResponse(sos));
});

export const resolveSOS = asyncHandler(async (req, res) => {
  const sos = await resolveSOSService({ sosId: req.params.id, userId: req.user.id });

  return sendSuccess(res, toSosResponse(sos));
});

/**
 * POST /:id/escalation/start — 200 for both a fresh escalation and an
 * idempotent replay of an existing guardian level (the spec's §5 semantics);
 * failures surface through ApiError (404/403/409).
 */
export const startEscalation = asyncHandler(async (req, res) => {
  const escalation = await startEscalationService({
    sosId: req.params.id,
    userId: req.user.id,
  });

  return sendSuccess(res, escalation);
});

/**
 * POST /:id/responders/notify — starts the prototype nearby-responder
 * escalation phase once the guardian level timed out. Ownership, SOS state,
 * guardian TIMEOUT verification and every duplicate/race guard live in the
 * escalation service; this stays thin and derives nothing from the request
 * but the id and the authenticated caller (no body, no query contract).
 */
export const notifyResponders = asyncHandler(async (req, res) => {
  const escalation = await notifyRespondersService({
    sosId: req.params.id,
    userId: req.user.id,
  });

  return sendSuccess(res, escalation);
});

/**
 * POST /:id/responders/:responderId/acknowledge — a notified responder
 * accepts the responder escalation. Identity, notification membership, SOS
 * state, level/status guards, the atomic write, the timeout cancellation and
 * the owner notification all live in the escalation service; the controller
 * only forwards the path params (no body, no client-supplied timestamps or
 * status).
 */
export const acknowledgeResponder = asyncHandler(async (req, res) => {
  const escalation = await acknowledgeResponderService({
    sosId: req.params.id,
    userId: req.user.id,
    responderId: req.params.responderId,
  });

  return sendSuccess(res, escalation);
});

/**
 * POST /:id/escalation/acknowledge — only the currently notified target may
 * acknowledge the current PENDING level. Identity, status and timestamps are
 * backend-derived; failures surface through ApiError (400/401/403/404/409).
 */
export const acknowledgeEscalation = asyncHandler(async (req, res) => {
  const escalation = await acknowledgeEscalationService({
    sosId: req.params.id,
    userId: req.user.id,
    level: req.body.level,
  });

  return sendSuccess(res, escalation);
});

/**
 * POST /:id/escalation/police — escalate to the prototype police station once
 * the guardian and responder levels have timed out. No body is read: the
 * station comes from the server-side hardcoded configuration, the state
 * machine decides whether escalation is allowed, and the service owns the
 * atomic write, idempotency and the owner notification.
 */
export const escalateToPolice = asyncHandler(async (req, res) => {
  const escalation = await escalateToPoliceService({
    sosId: req.params.id,
    userId: req.user.id,
  });

  return sendSuccess(res, escalation);
});

/**
 * GET /:id/escalation — read-only escalation state for frontend recovery.
 * No body, no state change, no timer and no socket emission: the service
 * reads the persisted document (owner-scoped) and returns a frontend-safe
 * projection of it.
 */
export const getEscalationState = asyncHandler(async (req, res) => {
  const state = await getEscalationStateService({
    sosId: req.params.id,
    userId: req.user.id,
  });

  return sendSuccess(res, state);
});

const toHistoryResponse = (sos) => {
  const { userId: _userId, ...rest } = toSosResponse(sos);
  return rest;
};

export const getSOSHistory = asyncHandler(async (req, res) => {
  const { page, limit } = req.validatedQuery;

  const result = await getSOSHistoryService({ userId: req.user.id, page, limit });

  return sendSuccess(res, {
    sos: result.items.map(toHistoryResponse),
    pagination: result.pagination,
  });
});
