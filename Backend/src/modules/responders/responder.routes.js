import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { getNearbyResponders } from './responder.controller.js';

const router = Router();

// Hardcoded prototype dataset: authenticated callers only, no validation
// middleware because the endpoint accepts no body, params or query contract.
router.get('/nearby', requireAuth, getNearbyResponders);

export default router;
