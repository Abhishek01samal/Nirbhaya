import { asyncHandler, badRequest } from "../../middleware/error.js";
import { requireOwner } from "../../middleware/auth.js";
import * as service from "./location.service.js";

/** POST /api/v1/location - single ping (also triggers ride monitoring). */
export const recordLocation = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const userId = body.userId ?? req.user.userId;
  requireOwner(req, userId);

  const { point, monitors } = await service.recordPoint({
    ...body,
    userId,
    source: "http",
  });

  res.status(201).json({
    success: true,
    data: {
      id: point._id,
      lat: point.lat,
      lng: point.lng,
      recordedAt: point.recordedAt,
      monitors,
    },
  });
});

/** POST /api/v1/location/batch - several pings at once (offline sync). */
export const recordBatch = asyncHandler(async (req, res) => {
  const { points } = req.body ?? {};
  if (!Array.isArray(points) || points.length === 0) {
    throw badRequest("points must be a non-empty array");
  }
  if (points.length > 500) throw badRequest("points limited to 500 per batch");

  const userId = req.body.userId ?? req.user.userId;
  requireOwner(req, userId);

  const saved = [];
  let lastMonitors = null;

  for (const p of points) {
    const result = await service.recordPoint({ ...p, userId, source: "http" });
    saved.push(result.point._id);
    if (result.monitors) lastMonitors = result.monitors;
  }

  res.status(201).json({
    success: true,
    data: { saved: saved.length, ids: saved, monitors: lastMonitors },
  });
});

/** GET /api/v1/location/current/:userId */
export const getCurrent = asyncHandler(async (req, res) => {
  requireOwner(req, req.params.userId);
  const point = await service.getCurrent(req.params.userId);
  res.json({ success: true, data: point });
});

/** GET /api/v1/location/history?userId|rideId|safetySessionId&from&to&limit */
export const getHistory = asyncHandler(async (req, res) => {
  const { userId, rideId, safetySessionId, from, to, limit } = req.query;

  if (userId) requireOwner(req, userId);
  if (!userId && !req.user?.userId) throw badRequest("userId required");

  const points = await service.getHistory({
    userId: userId ?? (rideId || safetySessionId ? undefined : req.user.userId),
    rideId,
    safetySessionId,
    from,
    to,
    limit,
  });

  res.json({ success: true, data: points, count: points.length });
});
