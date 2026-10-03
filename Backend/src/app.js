import express from 'express';
import cors from 'cors';
import { env } from './config/env.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';

// Person 1 routes
import sosRoutes from './modules/sos/sos.routes.js';
import guardianRoutes from './modules/guardians/guardian.routes.js';
import callRoutes from './modules/calling/call.routes.js';
import responderRoutes from './modules/responders/responder.routes.js';
import webhookRoutes from './modules/webhooks/webhook.routes.js';

// Person 2 routes
import safetySessionRoutes from './modules/safetySession/safetySession.routes.js';
import locationRoutes from './modules/location/location.routes.js';
import rideRoutes from './modules/ride/ride.routes.js';
import safePlaceRoutes from './modules/safePlace/safePlace.routes.js';
import crimeRoutes from './modules/crime/crime.routes.js';
import transportRoutes from './modules/safeTransport/transport.routes.js';
import emergencyTransportRoutes from './modules/guardianTransport/transport.routes.js';

import voiceRoutes from './modules/voice/voice.routes.js';
import assistantRoutes from './modules/assistant/assistant.routes.js';

const app = express();

app.use(
  cors({
    origin: (origin, callback) => callback(null, true),
    credentials: true,
  })
);

// LiveKit signs the raw bytes it posts, so the webhook router (which reads the
// body with express.raw) must run before the JSON parser replaces it.
app.use('/api/v1/webhooks', webhookRoutes);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/health', (req, res) => {
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } });
});

// --- Person 1 routes ---
app.use('/api/v1/sos', sosRoutes);
app.use('/api/v1/guardians', guardianRoutes);
app.use('/api/v1/calls', callRoutes);
app.use('/api/v1/responders', responderRoutes);

// --- Person 2 routes ---
app.use('/api/v1/safety-sessions', safetySessionRoutes);
app.use('/api/v1/location', locationRoutes);
app.use('/api/v1/rides', rideRoutes);
app.use('/api/v1/safe-places', safePlaceRoutes);
app.use('/api/v1/crime', crimeRoutes);
app.use('/api/v1/transport', transportRoutes);
app.use('/api/v1/emergency/transport', emergencyTransportRoutes);

// --- Person 3 routes ---
app.use('/api/v1/voice', voiceRoutes);
app.use('/api/v1/assistant', assistantRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
