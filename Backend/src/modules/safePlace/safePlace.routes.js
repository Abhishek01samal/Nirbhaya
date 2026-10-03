import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateQuery } from "../../middleware/validate.js";
import * as controller from "./safePlace.controller.js";

const router = Router();

const nearbySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().max(50000).optional(),
  types: z.string().max(300).optional(),
});

const routeSchema = z.object({
  origin: z.string().min(3).max(300),
  destination: z.string().min(3).max(300),
});

router.use(requireAuth);

router.get("/nearby", validateQuery(nearbySchema), controller.getNearby);
router.get("/route", validateQuery(routeSchema), controller.getAlongRoute);

export default router;
