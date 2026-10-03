import { asyncHandler, badRequest } from "../../middleware/error.js";
import * as service from "./transport.service.js";
import { TRANSPORT_TYPES } from "./transport.service.js";
import { isGoogleMapsConfigured } from "../../integrations/googleMaps/googleMaps.js";

/** GET /api/v1/transport/search?lat&lng&type&radius&limit */
export const search = asyncHandler(async (req, res) => {
  const query = req.validatedQuery ?? req.query;
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  const { type } = query;
  const radius = query.radius !== undefined ? Number(query.radius) : undefined;
  const limit = query.limit !== undefined ? Number(query.limit) : undefined;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw badRequest("lat and lng are required numbers");
  }

  const result = await service.search({
    lat,
    lng,
    type,
    radiusM: radius ?? 5000,
    limit: limit ?? 20,
  });

  res.json({
    success: true,
    data: result.places,
    meta: { source: result.source, type: result.type, googleMaps: isGoogleMapsConfigured() },
  });
});

/** GET /api/v1/transport/types */
export const listTypes = asyncHandler(async (_req, res) => {
  res.json({
    success: true,
    data: Object.keys(TRANSPORT_TYPES).map((key) => ({ type: key, placesTypes: TRANSPORT_TYPES[key] })),
  });
});
