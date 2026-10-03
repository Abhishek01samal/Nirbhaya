import { asyncHandler } from "../../middleware/error.js";
import { requireOwner } from "../../middleware/auth.js";
import * as service from "./safetySession.service.js";

/** POST /api/v1/safety-sessions */
export const startSession = asyncHandler(async (req, res) => {
  const session = await service.startSession({
    userId: req.user.userId,
    ...req.body,
  });
  res.status(201).json({ success: true, data: session });
});

/** GET /api/v1/safety-sessions/active */
export const getActive = asyncHandler(async (req, res) => {
  const userId = req.query.userId ?? req.user.userId;
  const session = await service.getActiveSession(userId);
  res.json({ success: true, data: session });
});

/** GET /api/v1/safety-sessions */
export const listSessions = asyncHandler(async (req, res) => {
  const sessions = await service.listSessions(req.user.userId, {
    limit: req.query.limit,
    status: req.query.status,
  });
  res.json({ success: true, data: sessions });
});

/** GET /api/v1/safety-sessions/:id */
export const getSession = asyncHandler(async (req, res) => {
  const session = await service.getSessionById(req.params.id);
  requireOwner(req, session.userId);
  res.json({ success: true, data: session });
});

/** POST /api/v1/safety-sessions/:id/end */
export const endSession = asyncHandler(async (req, res) => {
  const existing = await service.getSessionById(req.params.id);
  requireOwner(req, existing.userId);

  const session = await service.endSession(req.params.id, {
    status: req.body?.status ?? "ended",
    reason: req.body?.reason,
  });
  res.json({ success: true, data: session });
});
