const EARTH_RADIUS_M = 6371008.8;

export function toRadians(deg) {
  return (deg * Math.PI) / 180;
}

export function toDegrees(rad) {
  return (rad * 180) / Math.PI;
}

export function isValidLatLng(lat, lng) {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/** Great-circle distance in metres between two {lat,lng} points. */
export function haversineMeters(a, b) {
  const dLat = toRadians(b.lat - a.lat);
  const dLng = toRadians(b.lng - a.lng);
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Perpendicular (cross-track) distance in metres from point p to the
 * great-circle-ish segment a-b, using a local equirectangular projection.
 * Returns distance to the closest point on the segment (clamped to endpoints).
 */
export function pointToSegmentMeters(p, a, b) {
  const lat0 = toRadians(p.lat);
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos(lat0);

  const px = (p.lng - a.lng) * mPerDegLng;
  const py = (p.lat - a.lat) * mPerDegLat;
  const bx = (b.lng - a.lng) * mPerDegLng;
  const by = (b.lat - a.lat) * mPerDegLat;

  const segLenSq = bx * bx + by * by;
  if (segLenSq === 0) return Math.hypot(px, py);

  let t = (px * bx + py * by) / segLenSq;
  t = Math.max(0, Math.min(1, t));

  const dx = px - t * bx;
  const dy = py - t * by;
  return Math.hypot(dx, dy);
}

/** Shortest distance in metres from a point to a polyline [{lat,lng}, ...]. */
export function distanceToPolylineMeters(point, polyline) {
  if (!Array.isArray(polyline) || polyline.length === 0) return null;
  if (polyline.length === 1) return haversineMeters(point, polyline[0]);

  let min = Infinity;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (d < min) min = d;
    if (min === 0) break;
  }
  return min;
}

/** Index of the polyline segment closest to the point, plus distance. */
export function nearestSegment(point, polyline) {
  let min = Infinity;
  let index = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const d = pointToSegmentMeters(point, polyline[i], polyline[i + 1]);
    if (d < min) {
      min = d;
      index = i;
    }
  }
  return { index, distanceM: min };
}

/** Initial bearing in degrees from a to b. */
export function bearingDegrees(a, b) {
  const lat1 = toRadians(a.lat);
  const lat2 = toRadians(b.lat);
  const dLng = toRadians(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDegrees(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Decode a Google encoded polyline string into [{lat,lng}, ...].
 * https://developers.google.com/maps/documentation/utilities/polylinealgorithm
 */
export function decodePolyline(encoded, precision = 5) {
  if (typeof encoded !== "string" || encoded.length === 0) return [];
  const factor = 10 ** precision;
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / factor, lng: lng / factor });
  }
  return points;
}

/** Point at fraction t (0..1) along a polyline, using cumulative length. */
export function interpolateAlongPath(polyline, t) {
  if (!Array.isArray(polyline) || polyline.length === 0) return null;
  if (polyline.length === 1 || t <= 0) return polyline[0];
  if (t >= 1) return polyline[polyline.length - 1];

  const segments = [];
  let total = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const len = haversineMeters(polyline[i], polyline[i + 1]);
    segments.push(len);
    total += len;
  }
  if (total === 0) return polyline[0];

  let target = total * t;
  for (let i = 0; i < segments.length; i++) {
    if (target <= segments[i]) {
      const frac = segments[i] === 0 ? 0 : target / segments[i];
      const a = polyline[i];
      const b = polyline[i + 1];
      return { lat: a.lat + (b.lat - a.lat) * frac, lng: a.lng + (b.lng - a.lng) * frac };
    }
    target -= segments[i];
  }
  return polyline[polyline.length - 1];
}

/** Up to `count` evenly spaced points along a polyline (for along-route searches). */
export function samplesAlongPath(polyline, count = 8) {
  if (!Array.isArray(polyline) || polyline.length === 0 || count <= 0) return [];
  const out = [];
  for (let i = 1; i <= count; i++) {
    const p = interpolateAlongPath(polyline, i / (count + 1));
    if (p) out.push(p);
  }
  return out;
}

/** Bounding box that covers a circle of `radiusM` around a point. */
export function bboxAround(point, radiusM) {
  const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
  const cos = Math.max(Math.cos(toRadians(point.lat)), 0.01);
  const dLng = dLat / cos;
  return {
    minLat: point.lat - dLat,
    maxLat: point.lat + dLat,
    minLng: point.lng - dLng,
    maxLng: point.lng + dLng,
  };
}

/**
 * Parse a bbox query value: "minLat,minLng,maxLat,maxLng" → object.
 * Returns null when malformed.
 */
export function parseBbox(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLat, minLng, maxLat, maxLng] = parts;
  if (minLat > maxLat || minLng > maxLng) return null;
  return { minLat, minLng, maxLat, maxLng };
}

export function isValidBbox(bbox) {
  return (
    bbox &&
    [-90, 90].every((lim) => bbox.minLat >= -lim && bbox.maxLat <= lim) &&
    bbox.minLat <= bbox.maxLat &&
    bbox.minLng <= bbox.maxLng
  );
}
