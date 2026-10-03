import { useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { Compass, ExternalLink, LocateFixed, MapPin, Navigation, Radio, X, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { CRIME_HOTSPOTS, getCityStats, nearestHotspots, type CrimeHotspot } from "@/lib/crime-hotspots";

type Position = { lat: number; lng: number; accuracy?: number };

export function SafetyMap({
  emergency = false,
  featured = false,
  crime = false,
}: {
  emergency?: boolean;
  featured?: boolean;
  crime?: boolean;
}) {
  const [position, setPosition] = useState<Position | null>(null);
  const [message, setMessage] = useState("Initializing 5s live GPS auto-tracking...");
  const [destination, setDestination] = useState("");
  const [placeName, setPlaceName] = useState("");
  const [selectedCrime, setSelectedCrime] = useState<CrimeHotspot | null>(null);
  const center = position ?? { lat: 17.385, lng: 78.4867 };
  const { lat, lng } = center;

  const mapElRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const userMarkerRef = useRef<L.CircleMarker | null>(null);
  const userMovedRef = useRef(false);

  const mapUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - 0.015}%2C${lat - 0.009}%2C${lng + 0.015}%2C${lat + 0.009}&layer=mapnik&marker=${lat}%2C${lng}`;
  const directions = position && destination.trim()
    ? `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(`${lat},${lng}`)}&destination=${encodeURIComponent(destination.trim())}&travelmode=walking`
    : null;

  const locate = () => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      setMessage("Your browser does not support location sharing.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        setPosition({ lat: coords.latitude, lng: coords.longitude, accuracy: coords.accuracy });
        setMessage("Live GPS position auto-updated (5s cycle).");
        try {
          localStorage.setItem(
            "Nirbhaya:live-position",
            JSON.stringify({ lat: coords.latitude, lng: coords.longitude }),
          );
        } catch {
          // Storage unavailable (private mode); destination input just stays manual.
        }
      },
      () => {
        setMessage("Location permission pending or unavailable. Map centered on active coordinates.");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Auto-trigger location fetching immediately on mount and every 5 seconds
  useEffect(() => {
    locate();
    const interval = setInterval(() => {
      locate();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  // Reverse-geocode the current coordinates into a real place name.
  useEffect(() => {
    let cancelled = false;
    setPlaceName("Resolving place...");
    fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&accept-language=en`,
    )
      .then((res) => res.json())
      .then((json: { display_name?: string; name?: string; address?: Record<string, string> }) => {
        if (cancelled) return;
        const parts = [
          json.address?.road || json.address?.neighbourhood || json.name,
          json.address?.suburb || json.address?.city_district,
          json.address?.city || json.address?.town || json.address?.village,
          json.address?.state,
        ].filter(Boolean);
        setPlaceName(parts.length ? Array.from(new Set(parts)).join(", ") : (json.display_name ?? "Unknown place"));
      })
      .catch(() => {
        if (!cancelled) setPlaceName("Place unavailable");
      });
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  // --- Crime mode: real Leaflet map so circles pan & zoom with the map ---
  useEffect(() => {
    if (!crime) return;
    const el = mapElRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, { zoomControl: true, attributionControl: true });
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(map);
    // Remember when the user pans/zooms by hand so we stop auto-following GPS.
    const markUserMoved = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.(".crime-circle")) return; // clicking a circle isn't a map move
      userMovedRef.current = true;
    };
    el.addEventListener("pointerdown", markUserMoved);
    el.addEventListener("wheel", markUserMoved, { passive: true });
    map.on("dragstart", () => {
      userMovedRef.current = true;
    });
    map.setView([lat, lng], 14);
    markersLayerRef.current = L.layerGroup().addTo(map);
    userMarkerRef.current = L.circleMarker([lat, lng], {
      radius: 7,
      color: "#ffffff",
      weight: 3,
      fillColor: "#10b981",
      fillOpacity: 1,
    }).addTo(map);
    mapRef.current = map;

    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);

    return () => {
      el.removeEventListener("pointerdown", markUserMoved);
      el.removeEventListener("wheel", markUserMoved);
      ro.disconnect();
      map.remove();
      mapRef.current = null;
      markersLayerRef.current = null;
      userMarkerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crime]);

  // Draw transparent-red crime circles (real map markers - they move with the map).
  useEffect(() => {
    if (!crime || !mapRef.current || !markersLayerRef.current) return;
    const map = mapRef.current;
    const layer = markersLayerRef.current;

    const near = CRIME_HOTSPOTS.filter(
      (h) => Math.abs(h.lat - lat) <= 0.1 && Math.abs(h.lng - lng) <= 0.16,
    );
    const framing = near.length ? near : nearestHotspots(lat, lng, 4);
    const min = Math.min(...framing.map((h) => h.cases));
    const maxRaw = Math.max(...framing.map((h) => h.cases));
    const max = maxRaw === min ? min + 1 : maxRaw;

    layer.clearLayers();
    for (const h of framing) {
      const ratio = (h.cases - min) / (max - min);
      const lightness = 55 - ratio * 22; // more crime -> deeper dark red
      const alpha = 0.28 + ratio * 0.34; // transparent red
      const marker = L.circleMarker([h.lat, h.lng], {
        radius: 11 + ratio * 15,
        color: `hsl(0 74% ${lightness}%)`,
        weight: 2,
        fillColor: `hsl(0 74% ${lightness}%)`,
        fillOpacity: alpha,
        className: "crime-circle",
      }).addTo(layer);
      marker.on("click", () => setSelectedCrime(h));
      if (selectedCrime?.id === h.id) {
        marker.setStyle({ color: "#ffffff", weight: 3, fillOpacity: Math.min(alpha + 0.2, 0.9) });
      }
    }

    if (!userMovedRef.current) {
      const bounds = L.latLngBounds([
        ...framing.map((h) => [h.lat, h.lng] as [number, number]),
        [lat, lng],
      ]);
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 15 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crime, lat, lng, selectedCrime]);

  // Keep the live GPS marker on the map; follow it only while the user hasn't dragged.
  useEffect(() => {
    if (!crime || !mapRef.current) return;
    userMarkerRef.current?.setLatLng([lat, lng]);
    if (!userMovedRef.current) mapRef.current.setView([lat, lng], mapRef.current.getZoom(), { animate: true });
  }, [crime, lat, lng]);

  const densityNote = useMemo(() => "transparent red = crime density", []);

  return (
    <div className="grid border border-border bg-surface lg:grid-cols-[minmax(0,1.6fr)_minmax(290px,1fr)]">
      <div
        className={`relative bg-surface-2 ${
          featured ? "min-h-[420px] md:min-h-[560px] lg:min-h-[620px]" : "min-h-[320px] md:min-h-[430px]"
        }`}
      >
        {crime ? (
          <div ref={mapElRef} className="absolute inset-0 z-0 h-full w-full" aria-label="Crime location map" />
        ) : (
          <iframe
            title={position ? "Map of your live auto-updated location" : "Example map centered on Hyderabad"}
            src={mapUrl}
            loading="lazy"
            className="absolute inset-0 h-full w-full border-0"
            referrerPolicy="no-referrer"
          />
        )}

        <div className="pointer-events-none absolute left-4 top-4 z-[1000] flex items-center gap-2 border border-border bg-background px-3 py-2 font-mono text-[10px] uppercase text-foreground shadow-sm">
          <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
          {emergency ? "SOS PREVIEW / LIVE TRACKING" : crime ? "CRIME MAP · 5S AUTO-LOCATION" : "5S AUTO-LOCATION ACTIVE"}
        </div>

        {crime && (
          <div className="pointer-events-none absolute inset-0 z-[1000]">
            <div className="pointer-events-none absolute right-3 bottom-3 flex items-center gap-2 border border-red-500/40 bg-background/90 px-2.5 py-1.5 font-mono text-[10px] uppercase text-muted-foreground">
              <span className="size-3 rounded-full bg-[hsl(0_74%_55%_/_0.3)]" />
              Low
              <span className="size-3 rounded-full bg-[hsl(0_74%_38%_/_0.65)]" />
              High crime
              <span className="text-foreground">· click circle</span>
            </div>

            {/* Info box - only appears when a red circle is clicked */}
            {selectedCrime && (() => {
              const city = getCityStats(selectedCrime.cityKey);
              return (
                <div className="pointer-events-auto absolute bottom-3 left-3 w-[calc(100%-1.5rem)] max-w-sm rounded-2xl border border-red-500/50 bg-background/95 p-4 shadow-xl backdrop-blur">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-display text-2xl uppercase leading-none text-red-600">{selectedCrime.area}</p>
                      <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        {city ? `${city.city}, ${city.state}` : "Bhubaneswar, Odisha"} · NCRB Crime in India 2024
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedCrime(null)}
                      aria-label="Close crime details"
                      className="grid size-7 shrink-0 place-items-center rounded-full border border-border hover:bg-surface"
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>

                  <div className="mt-3 grid grid-cols-3 gap-2 text-center font-mono">
                    <div className="rounded-xl bg-red-500/10 py-2">
                      <p className="text-lg leading-none font-bold text-red-600">{selectedCrime.cases}</p>
                      <p className="mt-1 text-[9px] uppercase text-muted-foreground">Cases</p>
                    </div>
                    <div className="rounded-xl bg-red-500/10 py-2">
                      <p className="text-lg leading-none font-bold text-red-600">{selectedCrime.severity}/5</p>
                      <p className="mt-1 text-[9px] uppercase text-muted-foreground">Severity</p>
                    </div>
                    <div className="rounded-xl bg-red-500/10 py-2">
                      <p className="text-lg leading-none font-bold text-red-600">{city ? city.crimeRate.toFixed(0) : "-"}</p>
                      <p className="mt-1 text-[9px] uppercase text-muted-foreground">Rate /1L</p>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {selectedCrime.categories.map((c) => (
                      <span key={c} className="rounded-full border border-red-500/40 bg-red-500/10 px-2 py-0.5 font-mono text-[10px] uppercase text-red-600">
                        {c}
                      </span>
                    ))}
                  </div>

                  {city && (
                    <p className="mt-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
                      {city.city} 2024: IPC {city.ipc.toLocaleString("en-IN")} · BNS {city.bns.toLocaleString("en-IN")} · Total cognizable {city.total.toLocaleString("en-IN")} ·
                      Crime rate {city.crimeRate}/1L · Charge-sheeting {city.chargeSheetingRate}% · Population {city.populationLakh}L
                    </p>
                  )}

                  <div className="mt-3 flex items-start gap-2 border-l-2 border-amber-500 bg-amber-950/15 p-2.5 text-xs">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                    <span>{selectedCrime.advice}</span>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
      <div className="flex flex-col justify-between border-t border-border p-5 lg:border-l lg:border-t-0 md:p-7">
        <div>
          <div className="flex items-center justify-between">
            <p className="label-mono flex items-center gap-2">
              <MapPin className="size-3" /> {position ? "Live GPS Coordinates" : "Default Location"}
            </p>
            <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase text-emerald-600 font-bold animate-pulse">
              <Radio className="size-3" /> Auto 5s Sync
            </span>
          </div>

          <p className="mt-4 font-mono text-2xl tabular-nums break-all">
            {lat.toFixed(5)}° N<br />
            {lng.toFixed(5)}° E
          </p>
          <p className="mt-2 flex items-center gap-1.5 text-sm font-semibold">
            <MapPin className="size-3.5 shrink-0" /> {placeName}
          </p>
          <p className="mt-3 text-sm text-muted-foreground">
            {message} {position?.accuracy ? `Accuracy: ±${Math.round(position.accuracy)} m.` : ""}
          </p>

          <div className="mt-4 flex items-center gap-2 border border-emerald-600/40 bg-emerald-950/20 p-3 font-mono text-xs text-emerald-400">
            <Radio className="size-4 animate-ping text-emerald-500" /> Auto-updating map every 5 seconds
          </div>

          {crime && (
            <div role="status" className="mt-6 border-l-2 border-red-600 bg-red-950/20 p-4">
              <p className="font-display text-2xl uppercase text-red-500">Crime density layer</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {densityNote}. Click any red circle for NCRB crime details of that area. Red circles move with the map as you pan or zoom.
              </p>
            </div>
          )}

          {emergency && (
            <div role="status" className="mt-6 border-l-2 border-red-600 bg-red-950/20 p-4">
              <p className="font-display text-2xl uppercase text-red-500">Find a safer place</p>
              <p className="mt-2 text-sm text-muted-foreground">
                Move away from immediate danger if you can. Contact local emergency services. A map cannot verify that a path is safe.
              </p>
            </div>
          )}
        </div>
        <div className="mt-7 border-t border-border pt-5">
          <label htmlFor="safe-destination" className="label-mono flex items-center gap-2">
            <Compass className="size-3" /> Destination or safe meeting point
          </label>
          <input
            id="safe-destination"
            value={destination}
            onChange={(event) => setDestination(event.target.value)}
            placeholder="Enter a known safe destination"
            className="mt-3 h-11 w-full border border-input bg-background px-3 text-sm outline-none focus:border-foreground"
          />
          {directions ? (
            <Button asChild className="mt-3 w-full">
              <a href={directions} target="_blank" rel="noopener noreferrer">
                <Navigation /> Open walking directions <ExternalLink className="ml-auto" />
              </a>
            </Button>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">
              Enter a destination to calculate escape routes.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
