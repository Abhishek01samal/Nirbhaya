import { asyncHandler, badRequest } from "../../middleware/error.js";
import { requireOwner } from "../../middleware/auth.js";
import * as service from "./ride.service.js";
import { uploadImage } from "../../integrations/cloudinary/cloudinary.js";
import { extractRideFields } from "../../integrations/ocr/ocr.js";
import { extractRideFieldsWithAI } from "../../integrations/ai/groqExtract.js";
import logger from "../../utils/logger.js";

/**
 * POST /api/v1/rides/upload (multipart: screenshot)
 * Cloudinary stores the image (optional), OCR extracts prefilled fields.
 * Works without either service - response reports warnings instead of failing.
 */
export const uploadRide = asyncHandler(async (req, res) => {
  const file = req.file;
  const warnings = [];

  let image = { stored: false, url: "", publicId: "" };
  try {
    const uploaded = await uploadImage(file.buffer, { originalName: file.originalname });
    image = { stored: true, url: uploaded.url, publicId: uploaded.publicId };
  } catch (err) {
    warnings.push(`image not stored: ${err.code ?? err.message}`);
    logger.warn("ride", `screenshot upload skipped: ${err.message}`);
  }

  const ocr = await extractRideFields(file.buffer);
  if (ocr.error) warnings.push(`ocr failed: ${ocr.error}`);

  const ai = await extractRideFieldsWithAI(ocr.text);
  if (ai.error) warnings.push(`ai extraction: ${ai.error}`);
  if (ai.fields) {
    ocr.fields = {
      ...ocr.fields,
      provider: ai.fields.provider || ocr.fields.provider,
      driverName: ai.fields.driverName || ocr.fields.driverName,
      driverPhone: ai.fields.driverPhone || ocr.fields.driverPhone,
      vehicleNumber: ai.fields.vehicleNumber || ocr.fields.vehicleNumber,
      vehicleModel: ai.fields.vehicleModel || ocr.fields.vehicleModel,
      fareEstimate: ai.fields.fareEstimate ?? ocr.fields.fareEstimate,
      tripOtp: ai.fields.tripOtp || ocr.fields.tripOtp,
      pickup: ai.fields.pickup || undefined,
      drop: ai.fields.drop || undefined,
      tripNote: ai.fields.tripNote || undefined,
    };
  }

  const ride = await service.createRideFromUpload({
    userId: req.user.userId,
    fileMeta: { originalName: file.originalname, sizeBytes: file.size },
    image,
    ocr,
  });

  res.status(201).json({
    success: true,
    data: ride,
    warnings,
  });
});

/** GET /api/v1/rides */
export const listRides = asyncHandler(async (req, res) => {
  const rides = await service.listRides(req.user.userId, {
    status: req.query.status,
    limit: req.query.limit,
  });
  res.json({ success: true, data: rides });
});

/** GET /api/v1/rides/:id */
export const getRide = asyncHandler(async (req, res) => {
  const ride = await service.getRide(req.params.id);
  requireOwner(req, ride.userId);
  res.json({ success: true, data: ride });
});

/** POST /api/v1/rides/:id/confirm */
export const confirmRide = asyncHandler(async (req, res) => {
  const existing = await service.getRide(req.params.id);
  requireOwner(req, existing.userId);

  const ride = await service.confirmRide(req.params.id, req.body ?? {});
  res.json({ success: true, data: ride });
});

/** POST /api/v1/rides/:id/start */
export const startRide = asyncHandler(async (req, res) => {
  const existing = await service.getRide(req.params.id);
  requireOwner(req, existing.userId);

  const ride = await service.startRide(req.params.id, {
    safetySessionId: req.body?.safetySessionId,
  });
  res.json({ success: true, data: ride });
});

/** POST /api/v1/rides/:id/stop */
export const stopRide = asyncHandler(async (req, res) => {
  const existing = await service.getRide(req.params.id);
  requireOwner(req, existing.userId);

  const ride = await service.stopRide(req.params.id, {
    status: req.body?.status ?? "completed",
    reason: req.body?.reason,
  });
  res.json({ success: true, data: ride });
});

export { badRequest };
