import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import * as controller from "./location.controller.js";

const router = Router();

const pointSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100000).optional(),
  altitude: z.number().optional(),
  speed: z.number().min(0).max(200).optional(),
  heading: z.number().min(0).max(360).optional(),
  recordedAt: z.string().datetime({ offset: true }).or(z.string().datetime()).optional(),
  safetySessionId: z.string().optional(),
  rideId: z.string().optional(),
});

const recordSchema = pointSchema.extend({
  userId: z.string().optional(),
});

const batchSchema = z.object({
  userId: z.string().optional(),
  points: z.array(pointSchema).min(1).max(500),
});

const historySchema = z.object({
  userId: z.string().optional(),
  rideId: z.string().optional(),
  safetySessionId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(5000).optional(),
});

router.use(requireAuth);

router.post("/", validateBody(recordSchema), controller.recordLocation);
router.post("/batch", validateBody(batchSchema), controller.recordBatch);
router.get("/current/:userId", controller.getCurrent);
router.get("/history", validateQuery(historySchema), controller.getHistory);

export default router;
