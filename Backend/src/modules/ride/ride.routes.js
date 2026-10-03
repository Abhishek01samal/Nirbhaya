import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";
import { validateBody, validateQuery } from "../../middleware/validate.js";
import { uploadSingle } from "../../middleware/upload.middleware.js";
import * as controller from "./ride.controller.js";

const router = Router();

const geoSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  address: z.string().max(300).optional(),
});

// Place: coordinates, an address (geocoded), or both.
const placeSchema = z
  .object({
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
    address: z.string().max(300).optional(),
  })
  .refine((p) => (p.lat === undefined) === (p.lng === undefined), {
    message: "lat and lng must be provided together",
  })
  .refine(
    (p) => (p.lat !== undefined && p.lng !== undefined) || Boolean(p.address?.trim()),
    { message: "provide lat+lng or an address" }
  );

const confirmSchema = z.object({
  provider: z.string().max(50).optional(),
  driver: z
    .object({
      name: z.string().max(80).optional(),
      phone: z.string().max(20).optional(),
    })
    .optional(),
  vehicleNumber: z.string().max(20).optional(),
  vehicleModel: z.string().max(80).optional(),
  fareEstimate: z.number().nonnegative().max(1000000).nullable().optional(),
  tripNote: z.string().max(500).optional(),
  pickup: placeSchema.optional(),
  drop: placeSchema.optional(),
});

const startSchema = z.object({
  safetySessionId: z.string().optional(),
});

const stopSchema = z.object({
  status: z.enum(["completed", "cancelled"]).optional(),
  reason: z.string().max(300).optional(),
});

const listSchema = z.object({
  status: z.enum(["draft", "uploaded", "confirmed", "active", "completed", "cancelled"]).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
});

router.use(requireAuth);

router.post("/upload", uploadSingle("screenshot"), controller.uploadRide);
router.get("/", validateQuery(listSchema), controller.listRides);
router.get("/:id", controller.getRide);
router.post("/:id/confirm", validateBody(confirmSchema), controller.confirmRide);
router.post("/:id/start", validateBody(startSchema), controller.startRide);
router.post("/:id/stop", validateBody(stopSchema), controller.stopRide);

export default router;
