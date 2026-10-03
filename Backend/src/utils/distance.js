import { haversineMeters } from "./geo.js";

/** Human friendly distance: 450 m / 1.2 km. */
export function formatDistance(meters) {
  if (meters == null || !Number.isFinite(meters)) return "n/a";
  if (meters < 1000) return `${Math.round(meters)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

/** Human friendly duration from seconds: 45s / 12 min / 2h 05m. */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "n/a";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

/** Speed in m/s between two points with timestamps. Returns null when unknown. */
export function speedMetersPerSecond(from, to) {
  if (!from || !to) return null;
  const t1 = new Date(from.recordedAt ?? from.createdAt).getTime();
  const t2 = new Date(to.recordedAt ?? to.createdAt).getTime();
  const dt = (t2 - t1) / 1000;
  if (!Number.isFinite(dt) || dt <= 0) return null;
  return haversineMeters(from, to) / dt;
}

/** Attach distanceFromOrigin (metres) to each item and sort ascending. */
export function sortNearby(items, origin) {
  return items
    .map((item) => ({ ...item, distanceM: haversineMeters(origin, item) }))
    .sort((a, b) => a.distanceM - b.distanceM);
}

/** Box-car average of a numeric array (drops null/undefined). */
export function average(values) {
  const clean = values.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (clean.length === 0) return null;
  return clean.reduce((s, v) => s + v, 0) / clean.length;
}
