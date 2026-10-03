import { asyncHandler, badRequest } from "../../middleware/error.js";
import * as service from "./crime.service.js";
import { parseBbox } from "../../utils/geo.js";

/** GET /api/v1/crime/incidents?bbox=minLat,minLng,maxLat,maxLng&... */
export const getIncidents = asyncHandler(async (req, res) => {
  const bbox = parseBbox(req.query.bbox);
  if (req.query.bbox && !bbox) throw badRequest('bbox must be "minLat,minLng,maxLat,maxLng"');

  const result = await service.listIncidents({
    bbox,
    from: req.query.from,
    to: req.query.to,
    category: req.query.category,
    minSeverity: req.query.minSeverity,
    limit: req.query.limit,
  });

  res.json({ success: true, data: result.incidents, count: result.count });
});

/** GET /api/v1/crime/heatmap?bbox=...&cellDeg=0.01 */
export const getHeatmap = asyncHandler(async (req, res) => {
  const bbox = parseBbox(req.query.bbox);
  if (req.query.bbox && !bbox) throw badRequest('bbox must be "minLat,minLng,maxLat,maxLng"');

  const result = await service.heatmap({
    bbox,
    cellDeg: req.query.cellDeg,
    from: req.query.from,
    to: req.query.to,
    category: req.query.category,
  });

  res.json({ success: true, data: result });
});

/** GET /api/v1/crime/categories */
export const getCategories = asyncHandler(async (_req, res) => {
  const data = await service.categories();
  res.json({ success: true, data });
});
