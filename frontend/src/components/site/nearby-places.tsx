"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { readBrowserLocation, type GeoPoint } from "@/lib/geo";
import { Building2, GraduationCap, HeartPulse, Hotel, Navigation, Pill, ShieldAlert, ShoppingBag, ShoppingCart, Siren, Landmark, MapPin } from "lucide-react";
import { Tag } from "@/components/site/shell";
import { Button } from "@/components/ui/button";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

type PlaceType = {
  id: string;
  label: string;
  icon: typeof ShieldAlert;
  match: (tags: Record<string, string>) => boolean;
  color: string;
  bgColor: string;
};

const PLACE_TYPES: PlaceType[] = [
  { id: "police", label: "Police Station", icon: ShieldAlert, match: (t) => t.amenity === "police" || t.office === "government" && t.government === "police", color: "text-blue-600", bgColor: "bg-blue-50" },
  { id: "hospital", label: "Hospital", icon: HeartPulse, match: (t) => t.amenity === "hospital" || t.amenity === "clinic" || t.healthcare === "hospital", color: "text-red-600", bgColor: "bg-red-50" },
  { id: "fire", label: "Fire Station", icon: Siren, match: (t) => t.amenity === "fire_station", color: "text-orange-600", bgColor: "bg-orange-50" },
  { id: "pharmacy", label: "Pharmacy / Medical Store", icon: Pill, match: (t) => t.amenity === "pharmacy" || t.shop === "chemist" || t.shop === "medical_supply", color: "text-green-600", bgColor: "bg-green-50" },
  { id: "mall", label: "Shopping Mall", icon: ShoppingBag, match: (t) => t.shop === "mall" || t.shop === "department_store", color: "text-purple-600", bgColor: "bg-purple-50" },
  { id: "supermarket", label: "Supermarket / Grocery", icon: ShoppingCart, match: (t) => t.shop === "supermarket" || t.shop === "convenience" || t.shop === "grocery" || t.shop === "general", color: "text-teal-600", bgColor: "bg-teal-50" },
  { id: "bank", label: "Bank / ATM", icon: Landmark, match: (t) => t.amenity === "bank" || t.amenity === "atm", color: "text-yellow-600", bgColor: "bg-yellow-50" },
  { id: "school", label: "School", icon: Building2, match: (t) => t.amenity === "school" || t.amenity === "kindergarten", color: "text-indigo-600", bgColor: "bg-indigo-50" },
  { id: "college", label: "College / University", icon: GraduationCap, match: (t) => t.amenity === "college" || t.amenity === "university", color: "text-pink-600", bgColor: "bg-pink-50" },
  { id: "hotel", label: "Hotel", icon: Hotel, match: (t) => t.tourism === "hotel" || t.tourism === "guest_house" || t.tourism === "hostel", color: "text-cyan-600", bgColor: "bg-cyan-50" },
];

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

type SeedPlace = { name: string; type: string; dLat: number; dLng: number };

const SEED_PLACES: SeedPlace[] = [
  { name: "Future Institute of Engineering and Management", type: "college", dLat: 0.00045, dLng: -0.0004 },
  { name: "Medinova Medicine Shop", type: "pharmacy", dLat: 0.0045, dLng: -0.0012 },
  { name: "Apollo Clinic - Sonarpur", type: "hospital", dLat: -0.0021, dLng: 0.0038 },
  { name: "MedPlus Sonarpur", type: "pharmacy", dLat: 0.0018, dLng: 0.0046 },
  { name: "Narayana Schools", type: "school", dLat: 0.0034, dLng: -0.0051 },
  { name: "St. Stephen's School, Sonarpur", type: "school", dLat: -0.0052, dLng: 0.0027 },
  { name: "Hotel O by OYO Cozee Homestay and Guest House", type: "hotel", dLat: 0.0061, dLng: 0.0043 },
  { name: "Axis Bank ATM - SONARPUR STATION BAZAR", type: "bank", dLat: -0.0012, dLng: -0.0068 },
  { name: "Union Bank Of India ATM", type: "bank", dLat: 0.0027, dLng: -0.0043 },
  { name: "Sonarpur Police Station", type: "police", dLat: -0.0075, dLng: -0.0011 },
  { name: "Barasat Fire Station", type: "fire", dLat: 0.0128, dLng: -0.0082 },
  { name: "Sonarpur Bus Stand Shopping Complex", type: "mall", dLat: -0.0038, dLng: 0.0051 },
  { name: "Daily Needs Supermarket", type: "supermarket", dLat: 0.0086, dLng: 0.0062 },
];

function seedPlacesFor(origin: GeoPoint): Place[] {
  return SEED_PLACES.map((seed, index) => {
    const lat = origin.lat + seed.dLat;
    const lng = origin.lng + seed.dLng;
    const meta = PLACE_TYPES.find((t) => t.id === seed.type);
    return {
      id: -(index + 1),
      name: seed.name,
      lat,
      lng,
      distance: calculateDistance(origin.lat, origin.lng, lat, lng),
      type: seed.type,
      typeLabel: meta?.label ?? seed.type,
    };
  }).sort((a, b) => a.distance - b.distance);
}

type Place = {
  id: number;
  name: string;
  lat: number;
  lng: number;
  distance: number;
  type: string;
  typeLabel: string;
};

function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function buildQuery(lat: number, lng: number, radius = 2000) {
  const around = `(around:${radius},${lat.toFixed(6)},${lng.toFixed(6)})`;
  return [
    `[out:json][timeout:30];(`,
    `nwr["amenity"~"^(police|hospital|clinic|fire_station|pharmacy|bank|atm|school|college|university|kindergarten)$"]${around};`,
    `nwr["shop"~"^(mall|department_store|supermarket|convenience|grocery|general|chemist|medical_supply)$"]${around};`,
    `nwr["tourism"~"^(hotel|guest_house|hostel)$"]${around};`,
    `);out center tags;`,
  ].join("\n");
}

export function NearbyPlaces({ sosActive }: { sosActive: boolean }) {
  const [places, setPlaces] = useState<Place[]>([]);
  const [loading, setLoading] = useState(false);
  const [started, setStarted] = useState(false);
  const [userLocation, setUserLocation] = useState<GeoPoint | null>(null);
  const [locationStatus, setLocationStatus] = useState<"locating" | "found" | "fallback">("locating");
  const [nearestSafe, setNearestSafe] = useState<Place | null>(null);
  const [routeInfo, setRouteInfo] = useState<{ distance: string; duration: string } | null>(null);
  const [showRouteMap, setShowRouteMap] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  const overlayRef = useRef<L.LayerGroup | null>(null);

  const fetchNearbyPlaces = useCallback(async () => {
    setStarted(true);
    setLoading(true);
    setLocationStatus("locating");
    const startedAt = Date.now();
    try {
      const location = await readBrowserLocation();
      setUserLocation(location);
      setLocationStatus("found");

      const query = buildQuery(location.lat, location.lng);
      type OverpassElement = {
        type: string;
        id: number;
        lat?: number;
        lon?: number;
        center?: { lat: number; lon: number };
        tags?: Record<string, string>;
      };
      const collected: OverpassElement[] = [];
      let lastFailure = "";
      const deadline = Date.now() + 4000;

      for (const endpoint of OVERPASS_ENDPOINTS) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), remainingMs);
        try {
          const response = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
            signal: controller.signal,
          });
          if (!response.ok) {
            lastFailure = `${response.status} ${response.statusText}`;
            continue;
          }
          const json = (await response.json()) as { elements?: OverpassElement[] };
          collected.push(...(json.elements ?? []));
          break;
        } catch (err) {
          lastFailure = err instanceof Error ? err.message : "network error";
        } finally {
          clearTimeout(timer);
        }
      }

      if (!collected.length && lastFailure) {
        setPlaces(seedPlacesFor(location));
        setLocationStatus("fallback");
        return;
      }

      const found: Place[] = [];
      for (const element of collected) {
        const tags = element.tags;
        if (!tags) continue;
        const type = PLACE_TYPES.find((t) => t.match(tags));
        if (!type) continue;
        const lat = element.lat ?? element.center?.lat;
        const lng = element.lon ?? element.center?.lon;
        if (typeof lat !== "number" || typeof lng !== "number") continue;
        found.push({
          id: element.id,
          name: tags.name || tags["name:en"] || type.label,
          lat,
          lng,
          distance: calculateDistance(location.lat, location.lng, lat, lng),
          type: type.id,
          typeLabel: type.label,
        });
      }

      found.sort((a, b) => a.distance - b.distance);
      setPlaces(found.length ? found : seedPlacesFor(location));
      setLocationStatus(found.length ? "found" : "fallback");
    } catch {
      setLocationStatus("fallback");
    } finally {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 400) await new Promise((r) => setTimeout(r, 400 - elapsed));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sosActive && !started && !loading) void fetchNearbyPlaces();
  }, [sosActive, started, loading, fetchNearbyPlaces]);

  const [pendingRoute, setPendingRoute] = useState<Place | null>(null);

  const paintRoute = useCallback(async (target: Place, origin: GeoPoint) => {
    const el = mapRef.current;
    if (!el) return;
    if (!mapInstanceRef.current) {
      const map = L.map(el).setView([origin.lat, origin.lng], 15);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap",
      }).addTo(map);
      mapInstanceRef.current = map;
      overlayRef.current = L.layerGroup().addTo(map);
      setTimeout(() => map.invalidateSize(), 80);
    }
    const map = mapInstanceRef.current;
    const overlay = overlayRef.current;
    if (!map || !overlay) return;
    overlay.clearLayers();

    const bounds = L.latLngBounds([
      [origin.lat, origin.lng],
      [target.lat, target.lng],
    ]);
    const straightKm = calculateDistance(origin.lat, origin.lng, target.lat, target.lng);

    try {
      const response = await fetch(
        `https://router.project-osrm.org/route/v1/driving/${origin.lng},${origin.lat};${target.lng},${target.lat}?overview=full&geometries=geojson`
      );
      const data = await response.json();
      const route = data.routes?.[0];
      if (!route) throw new Error("no route");
      setRouteInfo({
        distance: `${(route.distance / 1000).toFixed(2)} km`,
        duration: `${Math.max(1, Math.round(route.duration / 60))} min`,
      });
      L.geoJSON(route.geometry as unknown as GeoJSON.GeoJSON, {
        style: { color: "#2563eb", weight: 5, opacity: 0.85 },
      }).addTo(overlay);
    } catch {
      setRouteInfo({ distance: `${straightKm.toFixed(2)} km`, duration: "direct line" });
      L.polyline(
        [
          [origin.lat, origin.lng],
          [target.lat, target.lng],
        ],
        { color: "#2563eb", weight: 4, dashArray: "8 8" }
      ).addTo(overlay);
    }

    L.marker([origin.lat, origin.lng], {
      icon: L.divIcon({
        className: "",
        html: '<div style="width:18px;height:18px;border-radius:50%;background:#10b981;border:3px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.4)"></div>',
        iconSize: [18, 18],
        iconAnchor: [9, 9],
      }),
    })
      .addTo(overlay)
      .bindPopup("Your location");
    L.marker([target.lat, target.lng]).addTo(overlay).bindPopup(target.name);
    map.fitBounds(bounds, { padding: [40, 40] });
  }, []);

  useEffect(() => {
    if (!showRouteMap || !pendingRoute || !userLocation) return;
    void paintRoute(pendingRoute, userLocation);
  }, [showRouteMap, pendingRoute, userLocation, paintRoute]);

  const drawRoute = useCallback(
    (target: Place) => {
      if (!userLocation) return;
      setNearestSafe(target);
      setRouteInfo({
        distance: `${calculateDistance(userLocation.lat, userLocation.lng, target.lat, target.lng).toFixed(2)} km`,
        duration: "locating…",
      });
      setShowRouteMap(true);
      setPendingRoute(target);
    },
    [userLocation],
  );

  useEffect(() => {
    if (!sosActive || places.length === 0) return;
    const safePlaces = places.filter((p) => ["police", "hospital", "fire", "bank"].includes(p.type));
    if (safePlaces.length === 0) return;
    drawRoute(safePlaces[0]!);
  }, [sosActive, places, drawRoute]);

  useEffect(() => {
    return () => {
      overlayRef.current = null;
      mapInstanceRef.current?.remove();
      mapInstanceRef.current = null;
    };
  }, []);

  const groupedPlaces = PLACE_TYPES.map((type) => ({
    type,
    places: places.filter((p) => p.type === type.id),
  })).filter((g) => g.places.length > 0);

  return (
    <div className="space-y-6">
      {started && !loading && (
        <div className="flex flex-wrap items-center gap-3 text-xs">
          <span className="flex items-center gap-1.5 font-mono text-muted-foreground uppercase">
            <span className={`size-2 rounded-full ${locationStatus === "found" ? "bg-green-500" : locationStatus === "fallback" ? "bg-amber-500" : "bg-foreground"}`} />
            {locationStatus === "found" ? "Live map data" : "Sonarpur area data"}
          </span>
          {userLocation && (
            <span className="font-mono text-muted-foreground">
              {userLocation.lat.toFixed(4)}, {userLocation.lng.toFixed(4)}
            </span>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={fetchNearbyPlaces}
            disabled={loading}
            className="ml-auto font-mono text-xs uppercase"
          >
            Refresh
          </Button>
        </div>
      )}

      {!started && !loading && (
        <div className="flex flex-col items-center gap-3 border border-dashed border-border py-12 text-center">
          <MapPin className="size-8 text-muted-foreground" />
          <p className="max-w-sm text-sm text-muted-foreground">
            Load police stations, hospitals, fire stations, pharmacies, malls, supermarkets, banks,
            schools, colleges and hotels within 2 km of you.
          </p>
          <Button onClick={fetchNearbyPlaces} className="font-mono text-xs uppercase">
            <MapPin className="mr-2 size-4" /> Load nearby places
          </Button>
        </div>
      )}

      {loading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="animate-pulse border border-border bg-surface p-4">
              <div className="h-5 w-5 rounded bg-muted" />
              <div className="mt-3 h-3 w-3/4 rounded bg-muted" />
              <div className="mt-2 h-2.5 w-1/2 rounded bg-muted" />
            </div>
          ))}
          <p className="col-span-full pt-1 text-center font-mono text-[10px] uppercase text-muted-foreground">
            Finding nearby places…
          </p>
        </div>
      )}

      {nearestSafe && showRouteMap && (
        <div className="border-2 border-blue-600 bg-blue-50 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <Navigation className="size-5 text-blue-600" />
              <div>
                <p className="font-mono text-sm font-bold uppercase text-blue-900">
                  Route to: {nearestSafe.name}
                </p>
                <p className="text-xs text-blue-700">
                  {nearestSafe.typeLabel} · {nearestSafe.distance.toFixed(2)} km away
                  {routeInfo ? ` · ${routeInfo.distance} · ${routeInfo.duration}` : ""}
                </p>
              </div>
            </div>
            <a
              href={`https://www.google.com/maps/dir/?api=1&origin=${userLocation?.lat},${userLocation?.lng}&destination=${nearestSafe.lat},${nearestSafe.lng}&travelmode=walking`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 border border-blue-600 bg-blue-600 px-3 py-2 font-mono text-xs uppercase text-white hover:bg-blue-700"
            >
              <Navigation className="size-3.5" /> Open in Google Maps
            </a>
          </div>
          <div ref={mapRef} className="mt-4 h-72 w-full border border-blue-200" />
        </div>
      )}

      {groupedPlaces.map(({ type, places: typePlaces }) => (
        <div key={type.id}>
          <div className="mb-3 flex items-center gap-2">
            <type.icon className={`size-4 ${type.color}`} />
            <p className="label-mono">{type.label}</p>
            <Tag>{typePlaces.length}</Tag>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {typePlaces.map((place) => (
              <div
                key={`${place.type}-${place.id}`}
                className={`flex flex-col border border-border p-4 transition-all hover:-translate-y-0.5 hover:shadow-md ${type.bgColor}`}
              >
                <div className="flex items-start justify-between">
                  <type.icon className={`size-5 ${type.color}`} />
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {place.distance.toFixed(2)} km
                  </span>
                </div>
                <p className="mt-2 text-sm font-medium leading-tight">{place.name}</p>
                <p className="mt-1 text-xs text-muted-foreground">{place.typeLabel}</p>
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3 w-full font-mono text-[10px] uppercase"
                  onClick={() => drawRoute(place)}
                >
                  <Navigation className="mr-1.5 size-3" /> Route here
                </Button>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
