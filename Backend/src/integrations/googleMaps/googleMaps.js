import { GOOGLE_MAPS_API_KEY } from "../../config/env.js";
import { haversineMeters, haversineMeters as hms } from "../../utils/geo.js";

const BASE = "https://maps.googleapis.com/maps/api";

export function isGoogleMapsConfigured() {
  return Boolean(GOOGLE_MAPS_API_KEY);
}

export async function geocode(address) {
  if (!GOOGLE_MAPS_API_KEY) throw new Error("GOOGLE_MAPS_API_KEY is not configured");
  const url = `${BASE}/geocode/json?address=${encodeURIComponent(address)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK" || !data.results?.length) {
    throw new Error(`geocode failed: ${data.status}`);
  }
  const first = data.results[0];
  return {
    lat: first.geometry.location.lat,
    lng: first.geometry.location.lng,
    formattedAddress: first.formatted_address,
  };
}

/** Decode Google encoded polyline into [{lat,lng}]. */
function decodePolyline(encoded) {
  const points = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    let b;
    let shift = 0;
    let result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

export async function directions(origin, destination) {
  if (!GOOGLE_MAPS_API_KEY) throw new Error("GOOGLE_MAPS_API_KEY is not configured");
  const o = `${origin.lat},${origin.lng}`;
  const d = `${destination.lat},${destination.lng}`;
  const url = `${BASE}/directions/json?origin=${o}&destination=${d}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  const leg = data.routes?.[0]?.legs?.[0];
  if (data.status !== "OK" || !data.routes?.length || !leg) {
    throw new Error(`directions failed: ${data.status}`);
  }
  return {
    polyline: decodePolyline(data.routes[0].overview_polyline.points),
    distanceM: leg.distance.value,
    durationS: leg.duration.value,
    summary: data.routes[0].summary ?? "",
    steps: (leg.steps ?? []).map((s) => ({
      instruction: (s.html_instructions ?? "").replace(/<[^>]+>/g, ""),
      distanceM: s.distance?.value ?? 0,
      durationS: s.duration?.value ?? 0,
    })),
    source: "google",
    fetchedAt: new Date(),
  };
}

/** Offline fallback: straight line between endpoints. */
export function syntheticRoute(origin, destination) {
  const distanceM = Math.round(hms(origin, destination));
  const durationS = Math.round(distanceM / 8.33); // ~30km/h
  return {
    polyline: [
      { lat: origin.lat, lng: origin.lng },
      { lat: destination.lat, lng: destination.lng },
    ],
    distanceM,
    durationS,
    summary: "synthetic",
    steps: [],
    source: "manual",
    fetchedAt: new Date(),
  };
}

export async function placesNearby({ lat, lng, radiusM = 5000, types = [], maxResults = 20 }) {
  if (!GOOGLE_MAPS_API_KEY) throw new Error("GOOGLE_MAPS_API_KEY is not configured");
  const type = (types[0] ?? "hospital");
  const url = `${BASE}/place/nearbysearch/json?location=${lat},${lng}&radius=${radiusM}&type=${encodeURIComponent(type)}&key=${GOOGLE_MAPS_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  if (data.status !== "OK" && data.status !== "ZERO_RESULTS") {
    throw new Error(`placesNearby failed: ${data.status}`);
  }
  return (data.results ?? []).slice(0, maxResults).map((p) => ({
    name: p.name,
    lat: p.geometry.location.lat,
    lng: p.geometry.location.lng,
    address: p.vicinity ?? "",
    rating: p.rating ?? null,
    types: p.types ?? [],
    placeId: p.place_id,
  }));
}
