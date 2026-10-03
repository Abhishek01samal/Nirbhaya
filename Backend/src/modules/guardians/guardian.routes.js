import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import {
  createGuardian,
  getGuardians,
  updateGuardian,
  removeGuardian,
  acceptGuardian,
  rejectGuardian,
} from './guardian.controller.js';
import {
  createGuardianSchema,
  getGuardianByIdParamsSchema,
  updateGuardianSchema,
} from './guardian.validation.js';

const router = Router();

router.post('/', requireAuth, validateBody(createGuardianSchema), createGuardian);

router.get('/', requireAuth, getGuardians);

router.patch(
  '/:id',
  requireAuth,
  validateParams(getGuardianByIdParamsSchema),
  validateBody(updateGuardianSchema),
  updateGuardian
);

router.delete('/:id', requireAuth, validateParams(getGuardianByIdParamsSchema), removeGuardian);

router.post(
  '/:id/accept',
  requireAuth,
  validateParams(getGuardianByIdParamsSchema),
  acceptGuardian
);

router.post(
  '/:id/reject',
  requireAuth,
  validateParams(getGuardianByIdParamsSchema),
  rejectGuardian
);

export default router;
