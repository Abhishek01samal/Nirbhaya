import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody, validateParams } from '../../middleware/validate.js';
import {
  getUsers,
  getUser,
  createUserHandler,
  updateUser,
  deleteUser,
} from './user.controller.js';
import { createUserSchema, updateUserSchema, userIdParamsSchema } from './user.validation.js';

const router = Router();

// Authentication only — authorization/role checks are intentionally not implemented yet.
router.use(requireAuth);

router.get('/', getUsers);

router.post('/', validateBody(createUserSchema), createUserHandler);

router.get('/:id', validateParams(userIdParamsSchema), getUser);

router.put('/:id', validateParams(userIdParamsSchema), validateBody(updateUserSchema), updateUser);

router.delete('/:id', validateParams(userIdParamsSchema), deleteUser);

export default router;
