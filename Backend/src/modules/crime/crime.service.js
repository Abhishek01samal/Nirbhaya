import { CrimeIncident, CRIME_CATEGORIES } from "./crime.model.js";
import { badRequest } from "../../middleware/error.js";
import logger from "../../utils/logger.js";

/**
 * Crime map queries - incidents in a bounding box + grid heatmap aggregation.
 * Data comes from the seed script (`npm run seed:crime`) or future reports.
 */
export async function listIncidents({
  bbox,
  from,
  to,
  category,
  minSeverity,
  limit = 500,
} = {}) {
  const filter = {};

  if (category) {
    if (!CRIME_CATEGORIES.includes(category)) throw badRequest(`Unknown category "${category}"`);
    filter.category = category;
  }
  if (minSeverity) filter.severity = { $gte: Number(minSeverity) };

  if (from || to) {
    filter.occurredAt = {};
    if (from) filter.occurredAt.$gte = new Date(from);
    if (to) filter.occurredAt.$lte = new Date(to);
  }

  if (bbox) {
    filter.lat = { $gte: bbox.minLat, $lte: bbox.maxLat };
    filter.lng = { $gte: bbox.minLng, $lte: bbox.maxLng };
  }

  const incidents = await CrimeIncident.find(filter)
    .sort({ occurredAt: -1 })
    .limit(Math.min(Number(limit) || 500, 2000))
    .select("category severity lat lng address area occurredAt count source");

  return { count: incidents.length, incidents };
}

/**
 * Grid heatmap: aggregates incidents into cells of `cellDeg` degrees.
 * Cell score = sum(count * severity) - drives radius/weight in the UI.
 */
export async function heatmap({ bbox, cellDeg = 0.01, from, to, category } = {}) {
  const filter = {};
  if (category) {
    if (!CRIME_CATEGORIES.includes(category)) throw badRequest(`Unknown category "${category}"`);
    filter.category = category;
  }
  if (from || to) {
    filter.occurredAt = {};
    if (from) filter.occurredAt.$gte = new Date(from);
    if (to) filter.occurredAt.$lte = new Date(to);
  }
  if (bbox) {
    filter.lat = { $gte: bbox.minLat, $lte: bbox.maxLat };
    filter.lng = { $gte: bbox.minLng, $lte: bbox.maxLng };
  }

  const cell = Math.max(0.001, Math.min(Number(cellDeg) || 0.01, 0.5));
  const docs = await CrimeIncident.find(filter)
    .limit(5000)
    .select("category severity lat lng count occurredAt");

  const cells = new Map();

  for (const doc of docs) {
    const row = Math.floor(doc.lat / cell);
    const col = Math.floor(doc.lng / cell);
    const key = `${row}:${col}`;

    let entry = cells.get(key);
    if (!entry) {
      entry = {
        lat: 0,
        lng: 0,
        incidents: 0,
        score: 0,
        severitySum: 0,
        severityCount: 0,
        categories: new Set(),
        latest: 0,
      };
      cells.set(key, entry);
    }

    const w = doc.count ?? 1;
    entry.lat += doc.lat;
    entry.lng += doc.lng;
    entry.incidents += w;
    entry.score += w * doc.severity;
    entry.severitySum += doc.severity;
    entry.severityCount += 1;
    entry.categories.add(doc.category);
    entry.latest = Math.max(entry.latest, new Date(doc.occurredAt).getTime());
  }

  const heatmapCells = [...cells.values()].map((e) => ({
    lat: Number((e.lat / (e.severityCount || 1)).toFixed(5)),
    lng: Number((e.lng / (e.severityCount || 1)).toFixed(5)),
    incidents: e.incidents,
    score: e.score,
    avgSeverity: Number((e.severitySum / e.severityCount).toFixed(2)),
    categories: [...e.categories],
    latest: new Date(e.latest).toISOString(),
  }));

  heatmapCells.sort((a, b) => b.score - a.score);

  logger.debug("crime", `heatmap ${heatmapCells.length} cells from ${docs.length} docs`);
  return { cellDeg: cell, totalIncidents: docs.length, cells: heatmapCells };
}

export async function categories() {
  const grouped = await CrimeIncident.aggregate([
    { $group: { _id: "$category", incidents: { $sum: "$count" }, avgSeverity: { $avg: "$severity" } } },
    { $sort: { incidents: -1 } },
  ]);
  return grouped.map((g) => ({
    category: g._id,
    incidents: g.incidents,
    avgSeverity: Number((g.avgSeverity ?? 0).toFixed(2)),
  }));
}
