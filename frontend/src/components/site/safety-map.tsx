import { useEffect, useState } from "react";
import { Compass, ExternalLink, LocateFixed, MapPin, Navigation, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";

type Position = { lat: number; lng: number; accuracy?: number };

export function SafetyMap({
  emergency = false,
  featured = false,
}: {
  emergency?: boolean;
  featured?: boolean;
}) {
  const [position, setPosition] = useState<Position | null>(null);
  const [message, setMessage] = useState("Initializing 5s live GPS auto-tracking...");
  const [destination, setDestination] = useState("");
  const [placeName, setPlaceName] = useState("");
  const center = position ?? { lat: 17.385, lng: 78.4867 };
  const { lat, lng } = center;
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

  return (
    <div className="grid border border-border bg-surface lg:grid-cols-[minmax(0,1.6fr)_minmax(290px,1fr)]">
      <div
        className={`relative bg-surface-2 ${
          featured ? "min-h-[420px] md:min-h-[560px] lg:min-h-[620px]" : "min-h-[320px] md:min-h-[430px]"
        }`}
      >
        <iframe
          title={position ? "Map of your live auto-updated location" : "Example map centered on Hyderabad"}
          src={mapUrl}
          loading="lazy"
          className="absolute inset-0 h-full w-full border-0"
          referrerPolicy="no-referrer"
        />
        <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2 border border-border bg-background px-3 py-2 font-mono text-[10px] uppercase text-foreground shadow-sm">
          <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
          {emergency ? "SOS PREVIEW / LIVE TRACKING" : "5S AUTO-LOCATION ACTIVE"}
        </div>
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