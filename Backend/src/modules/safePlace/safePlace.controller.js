import { asyncHandler, badRequest } from "../../middleware/error.js";
import * as service from "./safePlace.service.js";
import { isGoogleMapsConfigured } from "../../integrations/googleMaps/googleMaps.js";

/** GET /api/v1/safe-places/nearby?lat&lng&radius&types */
export const getNearby = asyncHandler(async (req, res) => {
  const query = req.validatedQuery ?? req.query;
  const lat = Number(query.lat);
  const lng = Number(query.lng);
  const radius = query.radius !== undefined ? Number(query.radius) : undefined;
  const { types } = query;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw badRequest("lat and lng are required numbers");
  }

  const result = await service.nearby({
    lat,
    lng,
    radiusM: radius ?? 5000,
    types: typeof types === "string" ? types.split(",").filter(Boolean) : undefined,
  });

  res.json({
    success: true,
    data: result.places,
    meta: { source: result.source, googleMaps: isGoogleMapsConfigured() },
  });
});

/** GET /api/v1/safe-places/route?origin=lat,lng&destination=lat,lng */
export const getAlongRoute = asyncHandler(async (req, res) => {
  const origin = parsePoint(req.query.origin, "origin");
  const destination = parsePoint(req.query.destination, "destination");

  const result = await service.alongRoute({ origin, destination });
  res.json({
    success: true,
    data: result.places,
    route: result.route,
    meta: { source: result.source, googleMaps: isGoogleMapsConfigured() },
  });
});

function parsePoint(value, label) {
  if (typeof value !== "string") throw badRequest(`${label} is required (lat,lng)`);
  const [lat, lng] = value.split(",").map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw badRequest(`${label} must be "lat,lng"`);
  }
  return { lat, lng };
}
