import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateParams, validateQuery } from '../../middleware/validate.js';
import {
  createSOS,
  getActiveSOS,
  getSOSById,
  confirmSOS,
  cancelSOS,
  acknowledgeSOS,
  resolveSOS,
  getSOSHistory,
  startEscalation,
  notifyResponders,
  acknowledgeEscalation,
  acknowledgeResponder,
  escalateToPolice,
  getEscalationState,
} from './sos.controller.js';
import {
  createSOSchema,
  getSOSByIdParamsSchema,
  getSOSHistoryQuerySchema,
  acknowledgeEscalationSchema,
  acknowledgeResponderParamsSchema,
} from './sos.validation.js';

const router = Router();

router.post('/', requireAuth, validateBody(createSOSchema), createSOS);

// Literal routes must stay registered before '/:id'.
router.get('/active', requireAuth, getActiveSOS);

router.get('/history', requireAuth, validateQuery(getSOSHistoryQuerySchema), getSOSHistory);

router.get('/:id', requireAuth, validateParams(getSOSByIdParamsSchema), getSOSById);

// Read-only escalation-state recovery: no body, no state change, no timer,
// no socket emission. Ownership is scoped inside the service, so a foreign
// SOS and a missing SOS return the identical 404.
router.get(
  '/:id/escalation',
  requireAuth,
  validateParams(getSOSByIdParamsSchema),
  getEscalationState
);

router.post('/:id/confirm', requireAuth, validateParams(getSOSByIdParamsSchema), confirmSOS);

router.post('/:id/cancel', requireAuth, validateParams(getSOSByIdParamsSchema), cancelSOS);

router.post(
  '/:id/acknowledge',
  requireAuth,
  validateParams(getSOSByIdParamsSchema),
  acknowledgeSOS
);

router.post('/:id/resolve', requireAuth, validateParams(getSOSByIdParamsSchema), resolveSOS);

router.post(
  '/:id/escalation/start',
  requireAuth,
  validateParams(getSOSByIdParamsSchema),
  startEscalation
);

// No body: the prototype responder escalation derives everything from the
// persisted SOS/escalation state.
router.post(
  '/:id/responders/notify',
  requireAuth,
  validateParams(getSOSByIdParamsSchema),
  notifyResponders
);

// The responder id is validated as a path param, then bound to the
// authenticated caller and checked against the persisted notified list in the
// escalation service — it is never trusted on its own.
router.post(
  '/:id/responders/:responderId/acknowledge',
  requireAuth,
  validateParams(acknowledgeResponderParamsSchema),
  acknowledgeResponder
);

router.post(
  '/:id/escalation/acknowledge',
  requireAuth,
  validateParams(getSOSByIdParamsSchema),
  validateBody(acknowledgeEscalationSchema),
  acknowledgeEscalation
);

// No body: the police station is server-side hardcoded and the escalation
// state decides eligibility, so no client can select or influence a station.
router.post(
  '/:id/escalation/police',
  requireAuth,
  validateParams(getSOSByIdParamsSchema),
  escalateToPolice
);

export default router;
