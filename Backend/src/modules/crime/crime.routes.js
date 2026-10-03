import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateQuery } from "../../middleware/validate.js";
import * as controller from "./crime.controller.js";
import { CRIME_CATEGORIES } from "./crime.model.js";

const router = Router();

const incidentsSchema = z.object({
  bbox: z.string().max(80).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  category: z.enum(CRIME_CATEGORIES).optional(),
  minSeverity: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().positive().max(2000).optional(),
});

const heatmapSchema = z.object({
  bbox: z.string().max(80).optional(),
  cellDeg: z.coerce.number().min(0.001).max(0.5).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  category: z.enum(CRIME_CATEGORIES).optional(),
});

router.use(requireAuth);

router.get("/incidents", validateQuery(incidentsSchema), controller.getIncidents);
router.get("/heatmap", validateQuery(heatmapSchema), controller.getHeatmap);
router.get("/categories", controller.getCategories);

export default router;
