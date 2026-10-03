import * as googleMaps from "../../integrations/googleMaps/googleMaps.js";
import { sortNearby } from "../../utils/distance.js";
import logger from "../../utils/logger.js";

/** Search presets: what the transport screen asks for → Places types. */
export const TRANSPORT_TYPES = {
  transit: ["transit_station", "train_station", "subway_station"],
  metro: ["subway_station", "transit_station"],
  bus: ["bus_station", "transit_station"],
  train: ["train_station", "transit_station"],
  taxi: ["taxi_stand"],
  auto: ["taxi_stand"],
  airport: ["airport"],
  all: ["transit_station", "taxi_stand", "airport"],
};

const MOCK_HUBS = [
  { type: "transit_station", name: "Central Transit Hub", vic: "Station Road" },
  { type: "taxi_stand", name: "City Taxi Stand", vic: "Market Square" },
  { type: "airport", name: "Domestic Airport", vic: "Airport Road" },
  { type: "train_station", name: "Main Junction", vic: "Railway Colony" },
  { type: "subway_station", name: "Metro Line 1", civic: true, vic: "Metro Bhavan" },
];

/**
 * Public transport / ride hubs near a point.
 * Google Places first (retrying with a single type if the batch is rejected),
 * deterministic mock as the last resort - the endpoint never 500s.
 */
export async function search({ lat, lng, type = "all", radiusM = 5000, limit = 20 }) {
  const wanted = TRANSPORT_TYPES[type] ?? TRANSPORT_TYPES.all;

  for (const types of [wanted, wanted.slice(0, 1)]) {
    try {
      const places = await googleMaps.placesNearby({ lat, lng, radiusM, types, maxResults: 20 });
      const valid = places.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
      if (valid.length > 0 || types === wanted.slice(0, 1)) {
        return {
          source: "google",
          type,
          places: sortNearby(valid, { lat, lng })
            .map((p) => ({ ...p, distanceM: Math.round(p.distanceM) }))
            .slice(0, limit),
        };
      }
    } catch (err) {
      logger.warn("transport", `places "${types.join(",")}" failed: ${err.message}`);
    }
  }

  logger.warn("transport", "google unavailable - mock fallback");
  return { source: "mock", type, places: mockHubs({ lat, lng, wanted, radiusM }).slice(0, limit) };
}

function mockHubs({ lat, lng, wanted, radiusM }) {
  return MOCK_HUBS.filter((h) => wanted.includes(h.type) || wanted.includes("transit_station"))
    .map((h, i) => ({
      placeId: `mock-hub-${i}`,
      name: h.name,
      lat: lat + 0.006 * (i + 1) * (i % 2 ? 1 : -1),
      lng: lng + 0.008 * (i + 1) * (i % 2 ? -1 : 1),
      types: [h.type],
      vicinity: `${h.vic} (demo)`,
      rating: null,
    }))
    .map((p) => ({ ...p, distanceM: Math.round(distance(lat, lng, p)) }))
    .filter((p) => p.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM);
}

function distance(lat, lng, point) {
  // small local helper avoids importing geo for one call in mock mode
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371008.8;
  const dLat = toRad(point.lat - lat);
  const dLng = toRad(point.lng - lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat)) * Math.cos(toRad(point.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
