import * as googleMaps from "../../integrations/googleMaps/googleMaps.js";
import { distanceToPolylineMeters, haversineMeters, samplesAlongPath } from "../../utils/geo.js";
import { sortNearby } from "../../utils/distance.js";
import logger from "../../utils/logger.js";

const DEFAULT_TYPES = ["hospital", "police", "fire_station", "pharmacy"];

const MOCK_TEMPLATES = [
  { type: "hospital", name: "City General Hospital", vic: "Main Road" },
  { type: "police", name: "Central Police Station", vic: "Station Road" },
  { type: "fire_station", name: "Fire Station No. 3", vic: "Ring Road" },
  { type: "pharmacy", name: "24h Care Pharmacy", vic: "Market Street" },
  { type: "hospital", name: "Night Clinic", vic: "Lake Road" },
  { type: "police", name: "Transit Police Post", vic: "Railway Station" },
];

/**
 * Emergency services near a point.
 * Real data from Google Places, deterministic mock when the API is unavailable.
 */
export async function nearby({ lat, lng, radiusM = 5000, types }) {
  const wanted = Array.isArray(types) && types.length ? types : DEFAULT_TYPES;

  try {
    const places = await googleMaps.placesNearby({
      lat,
      lng,
      radiusM,
      types: wanted,
      maxResults: 20,
    });
    const withDistance = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
    return {
      source: "google",
      places: sortNearby(withDistance, { lat, lng }).map((p) => ({
        ...p,
        distanceM: Math.round(p.distanceM),
      })),
    };
  } catch (err) {
    logger.warn("safePlace", `nearby unavailable (${err.message}) - mock fallback`);
    return { source: "mock", places: mockNearby({ lat, lng, types: wanted, radiusM }) };
  }
}

/**
 * Emergency services along a planned route: samples the polyline, searches
 * around each sample and de-duplicates by place id.
 */
export async function alongRoute({ origin, destination, sampleCount = 8, radiusM = 1500 }) {
  let route;
  try {
    route = await googleMaps.directions(origin, destination);
  } catch (err) {
    logger.warn("safePlace", `alongRoute directions failed (${err.message}) - synthetic fallback`);
    return mockAlongRoute({ origin, destination, sampleCount, radiusM });
  }

  if (!route.polyline?.length) return { source: "google", route, places: [] };

  const samples = samplesAlongPath(route.polyline, sampleCount);
  const seen = new Map();

  for (const sample of samples) {
    try {
      const found = await googleMaps.placesNearby({
        lat: sample.lat,
        lng: sample.lng,
        radiusM,
        types: DEFAULT_TYPES,
        maxResults: 8,
      });
      for (const place of found) {
        if (Number.isFinite(place.lat) && !seen.has(place.placeId)) seen.set(place.placeId, place);
      }
    } catch (err) {
      logger.warn("safePlace", `alongRoute sample search failed: ${err.message}`);
      break;
    }
  }

  const places = [...seen.values()]
    .map((p) => ({
      ...p,
      distanceFromRouteM: Math.round(distanceToPolylineMeters(p, route.polyline) ?? 0),
    }))
    .sort((a, b) => a.distanceFromRouteM - b.distanceFromRouteM)
    .slice(0, 30);

  return {
    source: "google",
    route: { distanceM: route.distanceM, durationS: route.durationS, summary: route.summary },
    places,
  };
}

function mockAlongRoute({ origin, destination, sampleCount, radiusM }) {
  const route = googleMaps.syntheticRoute(origin, destination);
  const samples = samplesAlongPath(route.polyline, sampleCount);
  const places = samples
    .flatMap((sample, si) =>
      mockNearby({ lat: sample.lat, lng: sample.lng, types: DEFAULT_TYPES, radiusM }).map((p) => ({
        ...p,
        placeId: `${p.placeId}-s${si}`,
        name: si === 0 ? p.name : `${p.name} (leg ${si + 1})`,
      }))
    )
    .map((p) => ({
      ...p,
      distanceFromRouteM: Math.round(distanceToPolylineMeters(p, route.polyline) ?? 0),
    }))
    .sort((a, b) => a.distanceFromRouteM - b.distanceFromRouteM)
    .slice(0, 30);

  return {
    source: "mock",
    route: { distanceM: route.distanceM, durationS: route.durationS, summary: route.summary },
    places,
  };
}

function mockNearby({ lat, lng, types, radiusM = 5000 }) {
  return types
    .flatMap((type, ti) =>
      [0, 1].map((i) => {
        const template =
          MOCK_TEMPLATES.find((m) => m.type === type) ?? MOCK_TEMPLATES[ti % MOCK_TEMPLATES.length];
        const dLat = (0.008 + 0.006 * (ti + 1)) * (i === 0 ? 1 : -1) * (ti % 2 ? 1 : -1);
        const dLng = (0.010 + 0.007 * (ti + 1)) * (i === 0 ? -1 : 1);
        return {
          placeId: `mock-${type}-${i}`,
          name: i === 0 ? template.name : `Branch ${template.name}`,
          lat: lat + dLat,
          lng: lng + dLng,
          types: [type],
          vicinity: `${template.vic} (demo)`,
          rating: null,
        };
      })
    )
    .map((p) => ({ ...p, distanceM: Math.round(haversineMeters({ lat, lng }, p)) }))
    .filter((p) => p.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

export { DEFAULT_TYPES };
