import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import * as controller from "./safetySession.controller.js";

const router = Router();

const geoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().max(300).optional(),
});

const startSchema = z.object({
  mode: z.enum(["walk", "ride", "static", "travel"]).optional(),
  origin: geoSchema.optional(),
  destination: geoSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  note: z.string().max(500).optional(),
});

const endSchema = z.object({
  status: z.enum(["ended", "cancelled"]).optional(),
  reason: z.string().max(300).optional(),
});

const listSchema = z.object({
  userId: z.string().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  status: z.enum(["active", "ended", "cancelled"]).optional(),
});

router.use(requireAuth);

router.post("/", validateBody(startSchema), controller.startSession);
router.get("/active", validateQuery(listSchema), controller.getActive);
router.get("/", validateQuery(listSchema), controller.listSessions);
router.get("/:id", controller.getSession);
router.post("/:id/end", validateBody(endSchema), controller.endSession);

export default router;
