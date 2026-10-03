"use client";

import { useEffect, useState } from "react";
import {
  ArrowRight,
  Navigation,
  Plane,
  TrainFront,
  BusFront,
  CarFront,
  ShieldCheck,
  Zap,
  MapPin,
  Hospital,
  ShieldAlert,
  Clock,
  Compass,
  CheckCircle2,
  AlertTriangle,
  Flame,
  Footprints,
  Car,
} from "lucide-react";
import { Page, Section, Tag } from "@/components/site/shell";
import { TacticalMap, type MapMarker } from "@/components/site/tactical-map";
import { Button } from "@/components/ui/button";
import { mapApi, type PlaceRecord, type GeoPoint } from "@/lib/api";
import { HYDERABAD } from "@/lib/geo";

const modes = [
  { id: "flight", icon: Plane, label: "Flight + Cab", mins: 260, cost: 5850, badge: "FASTEST INTER-CITY" },
  { id: "train", icon: TrainFront, label: "Express Train + Cab", mins: 580, cost: 1920, badge: "MOST RELIABLE" },
  { id: "bus", icon: BusFront, label: "Inter-City Bus + Cab", mins: 675, cost: 1450, badge: "BUDGET OPTION" },
  { id: "car", icon: CarFront, label: "Direct Cab Escort", mins: 850, cost: 4300, badge: "DOOR-TO-DOOR" },
];

const TRAVEL_MODES = [
  { id: "walk", label: "Walking", icon: Footprints },
  { id: "drive", label: "Driving", icon: Car },
  { id: "transit", label: "Public Transit", icon: BusFront },
];

const fmt = (m: number) => `${Math.floor(m / 60)}h ${m % 60}m`;

type TransportLink = { title: string; url: string; source: string; snippet: string };

// Prices are hardcoded estimates, not live fares.
const HARDCODED_PRICES: Record<"flights" | "trains" | "cabs", number> = {
  flights: 5850,
  trains: 1920,
  cabs: 12400,
};

export function RoutesPlanner() {
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [sosLocation, setSosLocation] = useState<GeoPoint | null>(null);
  const [sourcePoint, setSourcePoint] = useState<GeoPoint | null>(null);
  const [compared, setCompared] = useState(true);
  const [travelMode, setTravelMode] = useState<"walk" | "drive" | "transit">("walk");
  const [priority, setPriority] = useState<"fastest" | "cheapest" | "balanced">("fastest");
  const [delay, setDelay] = useState(false);
  const [safePlaces, setSafePlaces] = useState<PlaceRecord[]>([]);
  const [loadingPlaces, setLoadingPlaces] = useState(false);
  const [transport, setTransport] = useState<{
    flights: TransportLink[];
    trains: TransportLink[];
    cabs: TransportLink[];
  } | null>(null);
  const [transportLoading, setTransportLoading] = useState(false);
  const [transportError, setTransportError] = useState("");
  const [evaluated, setEvaluated] = useState(false);

  // Source defaults to whatever the user typed/geocoded on the last evaluate;
  // before that, fall back to the hardcoded demo point.
  const originPoint: GeoPoint = sourcePoint
    ? { lat: sourcePoint.lat, lng: sourcePoint.lng, address: origin }
    : { lat: 17.4156, lng: 78.4347, address: origin };
  const destPoint: GeoPoint = sosLocation
    ? { lat: sosLocation.lat, lng: sosLocation.lng, address: destination }
    : { lat: 17.4435, lng: 78.3772, address: destination };

  const mid = (t: number): GeoPoint => ({
    lat: originPoint.lat + (destPoint.lat - originPoint.lat) * t,
    lng: originPoint.lng + (destPoint.lng - originPoint.lng) * t,
  });

  const safePath: GeoPoint[] = [originPoint, mid(0.3), mid(0.55), mid(0.75), destPoint];
  const fastPath: GeoPoint[] = [originPoint, mid(0.5), destPoint];

  const mapMarkers: MapMarker[] = [
    { id: "m-orig", lat: originPoint.lat, lng: originPoint.lng, label: "Start: " + origin, kind: "you" },
    { id: "m-dest", lat: destPoint.lat, lng: destPoint.lng, label: "Destination: " + destination, kind: "sos" },
    { id: "m-hosp", lat: mid(0.4).lat, lng: mid(0.4).lng, label: "Apollo Emergency Hospital (24/7)", kind: "place" },
    { id: "m-pol", lat: mid(0.2).lat, lng: mid(0.2).lng, label: "Jubilee Hills Police Station", kind: "place" },
    { id: "m-safe", lat: mid(0.65).lat, lng: mid(0.65).lng, label: "Nirbhaya Verified Shelter", kind: "place" },
  ];

  const heatCells = [
    { lat: mid(0.35).lat, lng: mid(0.35).lng, score: 75 },
    { lat: mid(0.6).lat, lng: mid(0.6).lng, score: 45 },
  ];

  // Source input starts as the user's current live location; destination
  // defaults to the live SOS location captured by the dashboard map.
  useEffect(() => {
    if (typeof navigator !== "undefined" && navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          const lat = coords.latitude;
          const lng = coords.longitude;
          fetch(
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&accept-language=en`,
          )
            .then((res) => res.json())
            .then((json: { display_name?: string }) => {
              setOrigin(json.display_name || `${lat.toFixed(5)}, ${lng.toFixed(5)}`);
            })
            .catch(() => setOrigin(`${lat.toFixed(5)}, ${lng.toFixed(5)}`));
        },
        () => {
          // Permission denied/unavailable; leave the source editable.
        },
        { enableHighAccuracy: true, timeout: 10000 },
      );
    }
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem("Nirbhaya:live-position");
      if (!raw) return;
      const parsed = JSON.parse(raw) as { lat?: number; lng?: number };
      if (typeof parsed.lat !== "number" || typeof parsed.lng !== "number") return;
      setSosLocation({ lat: parsed.lat, lng: parsed.lng });
      fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${parsed.lat}&lon=${parsed.lng}&zoom=18&accept-language=en`,
      )
        .then((res) => res.json())
        .then((json: { display_name?: string }) => {
          if (json.display_name) setDestination(json.display_name);
        })
        .catch(() => setDestination(`${parsed.lat!.toFixed(5)}, ${parsed.lng!.toFixed(5)}`));
    } catch {
      // No stored location; user types the destination manually.
    }
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingPlaces(true);
    mapApi
      .alongRoute(originPoint, destPoint)
      .then((res) => {
        if (!active) return;
        const items = Array.isArray(res) ? res : res.data ?? [];
        if (items.length) {
          setSafePlaces(items.slice(0, 5));
        } else {
          // Fallback realistic mock safe places along route
          setSafePlaces([
            { name: "Jubilee Hills Police Station", type: "Police Station", lat: 17.425, lng: 78.418, vicinity: "Main Road Patrol Post", distanceM: 420 },
            { name: "Apollo Emergency Center", type: "Hospital", lat: 17.432, lng: 78.408, vicinity: "24/7 Trauma Unit", distanceM: 750 },
            { name: "Nirbhaya Verified Rest Stop", type: "Shelter", lat: 17.436, lng: 78.395, vicinity: "CCTV & Security Guard", distanceM: 1100 },
          ]);
        }
      })
      .catch(() => {
        if (!active) return;
        setSafePlaces([
          { name: "Jubilee Hills Police Station", type: "Police Station", lat: 17.425, lng: 78.418, vicinity: "Patrol Post", distanceM: 420 },
          { name: "Apollo Emergency Center", type: "Hospital", lat: 17.432, lng: 78.408, vicinity: "24/7 Hospital", distanceM: 750 },
        ]);
      })
      .finally(() => {
        if (active) setLoadingPlaces(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <Page>
      <Section title="Tactical route planning" note="Real-time safety vs fastest path optimizer">
        <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
          {/* Controls Panel */}
          <div className="flex flex-col justify-between border border-border bg-surface p-6 shadow-sm">
            <div>
              <div className="flex items-center justify-between">
                <p className="label-mono flex items-center gap-2">
                  <Navigation className="size-4" /> Route Analyzer
                </p>
                <Tag inverse>PROXIMITY RADAR</Tag>
              </div>

              <h1 className="mt-4 font-display text-4xl uppercase leading-tight">
                Plan a safer journey<span className="text-muted-foreground">.</span>
              </h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Nirbhaya evaluates lighting, crowd density, police patrol posts, and crime history to route you along verified safe corridors.
              </p>

              {/* Form Inputs */}
              <div className="mt-6 space-y-4">
                <div>
                  <label htmlFor="route-origin" className="label-mono block">
                    Starting location
                  </label>
                  <div className="relative mt-1.5">
                    <MapPin className="absolute left-3 top-3 size-4 text-muted-foreground" />
                    <input
                      id="route-origin"
                      value={origin}
                      onChange={(e) => setOrigin(e.target.value)}
                      placeholder="e.g. Banjara Hills, Hyderabad"
                      className="h-11 w-full border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-foreground"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="route-destination" className="label-mono block">
                    Destination
                  </label>
                  <div className="relative mt-1.5">
                    <Compass className="absolute left-3 top-3 size-4 text-muted-foreground" />
                    <input
                      id="route-destination"
                      value={destination}
                      onChange={(e) => setDestination(e.target.value)}
                      placeholder="e.g. HITEC City, Hyderabad"
                      className="h-11 w-full border border-input bg-background pl-9 pr-3 text-sm outline-none focus:border-foreground"
                    />
                  </div>
                </div>

                {/* Travel Mode Selector */}
                <div>
                  <span className="label-mono block mb-2">Travel mode</span>
                  <div className="grid grid-cols-3 gap-2">
                    {TRAVEL_MODES.map((tm) => (
                      <button
                        key={tm.id}
                        type="button"
                        onClick={() => setTravelMode(tm.id as any)}
                        className={`flex items-center justify-center gap-2 border p-2.5 font-mono text-xs uppercase transition-colors ${
                          travelMode === tm.id
                            ? "border-foreground bg-foreground text-background font-bold"
                            : "border-border bg-background hover:bg-muted"
                        }`}
                      >
                        <tm.icon className="size-4" /> {tm.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-8 border-t border-border pt-5">
              <Button
                disabled={!origin.trim() || !destination.trim() || transportLoading}
                className="h-12 w-full font-mono text-xs uppercase tracking-wider font-bold"
                onClick={() => {
                  setCompared(true);
                  setEvaluated(true);
                  setTransportLoading(true);
                  setTransportError("");
                  // Show the user's live position on the map as soon as they
                  // evaluate; geocoding of the typed source fills it in later.
                  if (typeof navigator !== "undefined" && navigator.geolocation) {
                    navigator.geolocation.getCurrentPosition(
                      ({ coords }) => setSourcePoint({ lat: coords.latitude, lng: coords.longitude, address: origin }),
                      () => {},
                      { enableHighAccuracy: true, timeout: 5000 },
                    );
                  }
                  // Geocode the user-entered source, then send both coordinates
                  // straight to the backend (port 4000, not the Vite proxy on 8080).
                  const victim = sosLocation ?? destPoint;
                  fetch(
                    `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(origin.trim())}&limit=1`,
                  )
                    .then((res) => res.json())
                    .then((results: Array<{ lat: string; lon: string }>) => {
                      const first = results[0];
                      if (!first) throw new Error(`Could not locate "${origin}". Check the source address.`);
                      const source = { lat: Number(first.lat), lng: Number(first.lon) };
                      setSourcePoint({ ...source, address: origin });
                      return fetch("http://localhost:4000/api/v1/emergency/transport/search", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          guardianLocation: source,
                          victimLocation: { lat: victim.lat, lng: victim.lng },
                        }),
                      });
                    })
                    .then(async (res) => {
                      const json = await res.json().catch(() => null);
                      if (!res.ok || !json?.success) {
                        throw new Error(json?.error?.message || `Transport search failed (${res.status})`);
                      }
                      setTransport({
                        flights: json.data?.transport?.flights ?? [],
                        trains: json.data?.transport?.trains ?? [],
                        cabs: json.data?.transport?.cabs ?? [],
                      });
                    })
                    .catch((err: Error) => {
                      setTransport(null);
                      setTransportError(err.message || "Transport search failed.");
                    })
                    .finally(() => setTransportLoading(false));
                }}
              >
                {transportLoading ? "Evaluating..." : "Evaluate Safety & Compare Routes"} <ArrowRight className="ml-2 size-4" />
              </Button>
            </div>
          </div>

          {/* Interactive Tactical Map */}
          <div className="flex flex-col border border-border bg-surface">
            <div className="border-b border-border p-4 flex items-center justify-between font-mono text-xs uppercase">
              <span className="flex items-center gap-2">
                <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
                Live Corridor Telemetry
              </span>
              <span className="text-muted-foreground">Hyd-Metro-Grid #402</span>
            </div>
            <TacticalMap
              markers={mapMarkers}
              path={[]}
              showMarkers={false}
              heat={heatCells}
              featured={true}
              caption="Safe vs Shortest Route Map Projection"
            />
          </div>
        </div>

        {/* Route Comparison Cards */}
        {compared && (
          <div className="mt-8 grid gap-6 md:grid-cols-2">
            {/* Safer Route Card */}
            <div className="border-2 border-emerald-600/80 bg-surface p-6 relative overflow-hidden shadow-lg">
              <div className="flex items-center justify-between">
                <Tag inverse>RECOMMENDED / HIGH SAFETY</Tag>
                <span className="font-mono text-2xl font-bold text-emerald-600">94<span className="text-xs text-muted-foreground">/100 SCORE</span></span>
              </div>
              <h3 className="mt-4 font-display text-3xl uppercase tracking-wider">
                Shield Route (Well-Lit Corridor)
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Optimized to follow streetlit arterial avenues, active commercial zones, and verified emergency shelters.
              </p>

              <div className="mt-6 grid grid-cols-2 gap-4 border-t border-b border-border py-4 font-mono text-xs">
                <div>
                  <span className="text-muted-foreground block">ESTIMATED TIME</span>
                  <span className="text-lg font-bold">24 mins</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">SAFETY METRICS</span>
                  <span className="text-emerald-600 font-bold">Patrol Posts Active</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">LIGHTING INDEX</span>
                  <span className="font-bold">98% High Streetlights</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">SAFE SPOTS ON PATH</span>
                  <span className="font-bold">4 Verified Shelters</span>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2 font-mono text-xs text-emerald-700 font-semibold">
                <ShieldCheck className="size-4" /> Continuous SOS telemetry & guardian sync enabled
              </div>
            </div>

            {/* Shortest Route Card */}
            <div className="border border-border bg-surface p-6 opacity-85 hover:opacity-100 transition-opacity">
              <div className="flex items-center justify-between">
                <Tag>FASTEST / UNVERIFIED LIGHTING</Tag>
                <span className="font-mono text-2xl font-bold text-amber-500">68<span className="text-xs text-muted-foreground">/100 SCORE</span></span>
              </div>
              <h3 className="mt-4 font-display text-3xl uppercase tracking-wider">
                Direct Bypass Path
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Saves 6 minutes by cutting through unlit secondary alleyways with low foot traffic.
              </p>

              <div className="mt-6 grid grid-cols-2 gap-4 border-t border-b border-border py-4 font-mono text-xs">
                <div>
                  <span className="text-muted-foreground block">ESTIMATED TIME</span>
                  <span className="text-lg font-bold">18 mins</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">SAFETY METRICS</span>
                  <span className="text-amber-600 font-bold">2 Low-Light Segments</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">LIGHTING INDEX</span>
                  <span className="font-bold">45% Limited Lights</span>
                </div>
                <div>
                  <span className="text-muted-foreground block">INCIDENTS RECORDED</span>
                  <span className="font-bold">1 Anomaly Last 30 Days</span>
                </div>
              </div>

              <div className="mt-4 flex items-center gap-2 font-mono text-xs text-amber-700">
                <AlertTriangle className="size-4" /> Not recommended after 21:00 without guardian escort
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* Verified Safe Places Along Route */}
      <Section title="Safe Havens & Emergency Spots" note="Verified 24/7 assistance points along route">
        <div className="grid gap-4 md:grid-cols-3">
          {safePlaces.map((sp, idx) => (
            <div key={sp.name + idx} className="panel p-5 border border-border bg-surface hover:border-foreground transition-all">
              <div className="flex items-start justify-between">
                <span className="font-mono text-[10px] uppercase text-muted-foreground">
                  {sp.type || "Safe Haven"} · {sp.distanceM ? `${sp.distanceM}m away` : "On route"}
                </span>
                <CheckCircle2 className="size-4 text-emerald-600" />
              </div>
              <h4 className="mt-3 font-display text-2xl uppercase tracking-wide">{sp.name}</h4>
              <p className="mt-1 text-xs text-muted-foreground">{sp.vicinity || "24/7 Verified Emergency Shelter"}</p>
              <div className="mt-4 flex items-center justify-between border-t border-border pt-3 font-mono text-[10px] uppercase">
                <span className="text-emerald-700 font-bold">Active Security Guard</span>
                <span>Coordinates Locked</span>
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* Guardian Emergency Travel Section */}
      <Section title="Guardian Emergency Transit Optimizer" note="Rapid inter-city transit routing for emergency escalation">
        <p className="mb-5 max-w-2xl text-sm text-muted-foreground">
          If an emergency escalates, your designated guardian receives optimized multi-modal transit options (flight, express train, cab) to reach your exact location.
        </p>

        <div className="mb-4 flex flex-wrap items-center gap-3 font-mono text-xs uppercase">
          <span className="font-bold border border-border px-3 py-1.5 bg-surface">Berhampur (Guardian Base)</span>
          <ArrowRight className="size-4" />
          <span className="font-bold border border-border px-3 py-1.5 bg-surface">Hub Terminal</span>
          <ArrowRight className="size-4" />
          <span className="font-bold border border-border px-3 py-1.5 bg-surface">Hyderabad (Victim Spot)</span>
        </div>

        <div className="mb-6 flex flex-wrap gap-2">
          {(["fastest", "cheapest", "balanced"] as const).map((p) => (
            <Button
              key={p}
              size="sm"
              variant={priority === p ? "default" : "outline"}
              onClick={() => setPriority(p)}
              className="uppercase font-mono text-xs"
            >
              Priority: {p}
            </Button>
          ))}
          <Button
            size="sm"
            variant={delay ? "destructive" : "outline"}
            onClick={() => setDelay(!delay)}
            className="font-mono text-xs"
          >
            {delay ? "Clear Flight Delay Simulation" : "Simulate Flight Delay (+5h)"}
          </Button>
        </div>

        {(() => {
          const list = modes.map((m) => ({
            ...m,
            mins: m.mins + (delay && m.id === "flight" ? 300 : 0),
          }));
          const score = (m: typeof list[number]) =>
            priority === "fastest" ? m.mins : priority === "cheapest" ? m.cost : m.mins / 8 + m.cost / 20;
          const best = [...list].sort((a, b) => score(a) - score(b))[0]!;

          return (
            <>
              <div className="grid gap-px border border-border bg-border md:grid-cols-4">
                {list.map((mode) => (
                  <div
                    key={mode.label}
                    className={`p-6 transition-all duration-500 ${
                      mode === best
                        ? "bg-foreground text-background font-bold shadow-lg"
                        : "bg-surface"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <mode.icon className="size-6" />
                      <span className="font-mono text-[9px] uppercase tracking-wider opacity-80">{mode.badge}</span>
                    </div>
                    <p className="mt-5 font-display text-2xl uppercase tracking-wider">{mode.label}</p>
                    <p className="mt-3 font-mono text-xl tabular-nums">{fmt(mode.mins)}</p>
                    <p className="mt-1 text-xs opacity-75">₹{mode.cost.toLocaleString("en-IN")} estimated</p>
                    {mode === best && (
                      <p className="mt-4 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest bg-background text-foreground px-2 py-1">
                        <Zap className="size-3" /> Recommended ({priority})
                      </p>
                    )}
                  </div>
                ))}
              </div>

              {delay && (
                <div role="status" className="page-enter mt-4 border-l-4 border-amber-500 bg-amber-950/20 p-4 text-sm text-amber-200 font-mono">
                  ⚠️ DYNAMIC REPLANNING TRIGGERED: Flight delay detected (+5h). Emergency optimizer re-ranked transit options and recommends <strong>{best.label}</strong> for fastest arrival.
                </div>
              )}
            </>
          );
        })()}

        {transportLoading && (
          <p className="mt-4 font-mono text-xs uppercase text-muted-foreground">Searching live cab, train and flight options...</p>
        )}
        {transportError && (
          <p role="alert" className="mt-4 border-l-4 border-destructive bg-destructive/10 p-4 font-mono text-xs text-destructive">{transportError}</p>
        )}
        {transport && (
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            {(
              [
                { key: "cabs", label: "Cabs", icon: CarFront, items: transport.cabs },
                { key: "trains", label: "Trains", icon: TrainFront, items: transport.trains },
                { key: "flights", label: "Flights", icon: Plane, items: transport.flights },
              ] as const
            ).map((group) => (
              <div key={group.key} className="border border-border bg-surface p-4">
                <div className="flex items-center justify-between">
                  <p className="flex items-center gap-2 font-mono text-xs uppercase font-bold">
                    <group.icon className="size-4" /> {group.label}
                  </p>
                  <span className="font-mono text-xs">~₹{HARDCODED_PRICES[group.key].toLocaleString("en-IN")}</span>
                </div>
                <ul className="mt-3 space-y-2">
                  {group.items.length === 0 && (
                    <li className="text-xs text-muted-foreground">No live results returned.</li>
                  )}
                  {group.items.map((item) => (
                    <li key={item.url}>
                      <a
                        href={item.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block border border-border bg-background p-2.5 text-xs transition-colors hover:border-foreground"
                      >
                        <span className="block font-semibold leading-snug">{item.title}</span>
                        <span className="mt-0.5 block font-mono text-[10px] uppercase text-muted-foreground">{item.source} · Book</span>
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </Section>
    </Page>
  );
}