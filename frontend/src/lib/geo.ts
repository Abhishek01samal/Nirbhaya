import type { GeoPoint } from "@/lib/api";

export type { GeoPoint };

export const HYDERABAD: GeoPoint = { lat: 17.385, lng: 78.4867, address: "Hyderabad" };

export function formatKm(meters?: number) {
  if (!Number.isFinite(meters)) return "—";
  if ((meters as number) < 1000) return `${Math.round(meters as number)} m`;
  return `${((meters as number) / 1000).toFixed(1)} km`;
}

export function formatDuration(seconds?: number) {
  if (!Number.isFinite(seconds)) return "—";
  const m = Math.round((seconds as number) / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function bboxAround(point: GeoPoint, delta = 0.08) {
  return `${point.lat - delta},${point.lng - delta},${point.lat + delta},${point.lng + delta}`;
}

export function objectIdFromKey(key: string) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const hex = `${hash.toString(16).padStart(8, "0")}${Array.from(key)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, "0"))
    .join("")}`.replace(/[^a-f0-9]/g, "a");
  return hex.padEnd(24, "0").slice(0, 24);
}

export async function geocode(query: string): Promise<GeoPoint | null> {
  const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
  const json = (await response.json()) as { results?: GeoPoint[] };
  return json.results?.[0] ?? null;
}

export function readBrowserLocation(): Promise<GeoPoint> {
  return new Promise((resolve) => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      resolve({ ...HYDERABAD });
      return;
    }
    const timer = setTimeout(() => resolve({ ...HYDERABAD }), 800);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        clearTimeout(timer);
        resolve({ lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy });
      },
      () => {
        clearTimeout(timer);
        resolve({ ...HYDERABAD });
      },
      { enableHighAccuracy: false, timeout: 800 },
    );
  });
}

export function offsetPoint(origin: GeoPoint, index: number, radiusKm = 1.4): GeoPoint {
  const angle = (index * 2.2) % (Math.PI * 2);
  const km = radiusKm + (index % 3) * 0.45;
  return {
    lat: origin.lat + (km / 111) * Math.cos(angle),
    lng: origin.lng + (km / (111 * Math.cos((origin.lat * Math.PI) / 180))) * Math.sin(angle),
  };
}

export function project(
  point: GeoPoint,
  bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number },
) {
  const x = (point.lng - bounds.minLng) / Math.max(0.00001, bounds.maxLng - bounds.minLng);
  const y = (bounds.maxLat - point.lat) / Math.max(0.00001, bounds.maxLat - bounds.minLat);
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

export function boundsFor(points: GeoPoint[], pad = 0.012) {
  if (!points.length) {
    return {
      minLat: HYDERABAD.lat - pad,
      maxLat: HYDERABAD.lat + pad,
      minLng: HYDERABAD.lng - pad,
      maxLng: HYDERABAD.lng + pad,
    };
  }
  const lats = points.map((p) => p.lat);
  const lngs = points.map((p) => p.lng);
  return {
    minLat: Math.min(...lats) - pad,
    maxLat: Math.max(...lats) + pad,
    minLng: Math.min(...lngs) - pad,
    maxLng: Math.max(...lngs) + pad,
  };
}

export function osmEmbed(bounds: { minLat: number; maxLat: number; minLng: number; maxLng: number }, marker?: GeoPoint) {
  const bbox = `${bounds.minLng}%2C${bounds.minLat}%2C${bounds.maxLng}%2C${bounds.maxLat}`;
  const mark = marker ? `&marker=${marker.lat}%2C${marker.lng}` : "";
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik${mark}`;
}
