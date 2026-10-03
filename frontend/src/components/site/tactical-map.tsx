import { useMemo } from "react";
import { osmEmbed, project, boundsFor, type GeoPoint } from "@/lib/geo";
import { MapPin } from "lucide-react";

export type MapMarker = GeoPoint & {
  id: string;
  label: string;
  kind?: "you" | "guardian" | "place" | "crime" | "hub" | "sos";
};

export function TacticalMap({
  markers = [],
  path = [],
  heat = [],
  featured = false,
  emergency = false,
  caption = "Live map",
  pathVariant = "default",
  showMarkers = true,
}: {
  markers?: MapMarker[];
  path?: GeoPoint[];
  heat?: Array<GeoPoint & { score?: number }>;
  featured?: boolean;
  emergency?: boolean;
  caption?: string;
  pathVariant?: "default" | "danger";
  showMarkers?: boolean;
}) {
  // Keyed on primitive coordinates, not array identity, so a re-render of the
  // parent never hands the iframe a "new" src and resets the user's pan position.
  const pointsKey = JSON.stringify([markers, path, heat].map((list) => list.map((p) => [p.lat, p.lng])));
  const { bounds, you, mapUrl } = useMemo(() => {
    const points = [...markers, ...path, ...heat];
    const b = boundsFor(points.length ? points : [{ lat: 17.385, lng: 78.4867 }], 0.018);
    const y = markers.find((m) => m.kind === "you") ?? markers[0];
    return { bounds: b, you: y, mapUrl: osmEmbed(b, y) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointsKey]);
  const poly = path.map((p) => project(p, bounds));
  const d = poly.length
    ? `M ${poly.map((p) => `${(p.x * 100).toFixed(2)} ${(p.y * 100).toFixed(2)}`).join(" L ")}`
    : "";

  return (
    <div className={`relative overflow-hidden border border-border bg-surface ${featured ? "min-h-[460px] md:min-h-[580px]" : "min-h-[340px] md:min-h-[420px]"}`}>
      <iframe title={caption} src={mapUrl} loading="lazy" className="absolute inset-0 h-full w-full border-0 grayscale contrast-125" referrerPolicy="no-referrer" />
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="pointer-events-none absolute inset-0 h-full w-full">
        {heat.map((cell, i) => {
          const p = project(cell, bounds);
          const r = Math.min(8, 1.6 + (cell.score ?? 1) / 18);
          return <circle key={`h-${i}`} cx={p.x * 100} cy={p.y * 100} r={r} className={emergency ? "fill-red-600/25" : "fill-foreground/15"} />;
        })}
        {d ? <path d={d} fill="none" className={pathVariant === "danger" ? "stroke-red-600" : emergency ? "stroke-red-700" : "stroke-foreground"} strokeWidth="1.1" vectorEffect="non-scaling-stroke" /> : null}
        {showMarkers
          ? markers.map((marker) => {
          const p = project(marker, bounds);
          const fill =
            marker.kind === "sos"
              ? "fill-red-700"
              : marker.kind === "you"
                ? "fill-foreground"
                : marker.kind === "guardian"
                  ? "fill-foreground"
                  : "fill-muted-foreground";
          return (
            <g key={marker.id}>
              {marker.kind === "sos" || (emergency && marker.kind === "you") ? (
                <circle cx={p.x * 100} cy={p.y * 100} r="4.2" className="fill-red-600/30 animate-pulse" />
              ) : null}
              <circle cx={p.x * 100} cy={p.y * 100} r={marker.kind === "you" || marker.kind === "sos" ? 1.5 : 1.05} className={fill} />
            </g>
          );
        })
          : null}
      </svg>
      <div className="pointer-events-none absolute left-4 top-4 border border-border bg-background px-3 py-2 font-mono text-[10px] uppercase shadow-sm">
        <span className="inline-flex items-center gap-2"><MapPin className="size-3 text-red-600" />{caption}</span>
      </div>
    </div>
  );
}
