import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { validateBody } from '../../middleware/validate.js';
import { register, login, me, logout } from './auth.controller.js';
import { registerSchema, loginSchema } from './auth.validation.js';

const router = Router();

router.post('/register', validateBody(registerSchema), register);

router.post('/login', validateBody(loginSchema), login);

router.get('/me', requireAuth, me);

// Stateless JWT logout: success means "discard your token client-side".
router.post('/logout', logout);

export default router;
