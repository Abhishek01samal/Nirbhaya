import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateQuery } from "../../middleware/validate.js";
import * as controller from "./transport.controller.js";
import { TRANSPORT_TYPES } from "./transport.service.js";

const router = Router();

const searchSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  type: z.enum(Object.keys(TRANSPORT_TYPES)).optional(),
  radius: z.coerce.number().positive().max(50000).optional(),
  limit: z.coerce.number().int().positive().max(50).optional(),
});

router.use(requireAuth);

router.get("/search", validateQuery(searchSchema), controller.search);
router.get("/types", controller.listTypes);

export default router;
