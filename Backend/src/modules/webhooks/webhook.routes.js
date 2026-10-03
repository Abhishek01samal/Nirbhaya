import express, { Router } from 'express';
import { receiveLiveKitWebhook } from './webhook.controller.js';

const router = Router();

/**
 * POST /api/v1/webhooks/livekit — called by LiveKit Cloud, never by a browser.
 *
 * `express.raw` runs here (and this router is mounted before `express.json()`
 * in app.js) so signature verification sees the exact bytes LiveKit signed.
 * There is deliberately no `requireAuth`: this caller has no user JWT.
 */
router.post('/livekit', express.raw({ type: '*/*', limit: '1mb' }), receiveLiveKitWebhook);

export default router;
