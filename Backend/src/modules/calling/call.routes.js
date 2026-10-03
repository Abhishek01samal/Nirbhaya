import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import {
  acceptCallController,
  createCallTokenController,
  endCallController,
  rejectCallController,
  startCallController,
} from './call.controller.js';
import {
  acceptCallSchema,
  createCallTokenSchema,
  endCallSchema,
  getCallByIdParamsSchema,
  rejectCallSchema,
  startCallSchema,
} from './call.validation.js';

const router = Router();

router.post('/start', requireAuth, validateBody(startCallSchema), startCallController);

router.post('/end', requireAuth, validateBody(endCallSchema), endCallController);

router.post('/token', requireAuth, validateBody(createCallTokenSchema), createCallTokenController);

router.post(
  '/:id/accept',
  requireAuth,
  validateParams(getCallByIdParamsSchema),
  validateBody(acceptCallSchema),
  acceptCallController
);

router.post(
  '/:id/reject',
  requireAuth,
  validateParams(getCallByIdParamsSchema),
  validateBody(rejectCallSchema),
  rejectCallController
);

export default router;
