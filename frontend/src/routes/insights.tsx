import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AlertTriangle, Flame, Hospital, MapPin, ShieldAlert, TrendingDown } from "lucide-react";
import { Page, Section, Tag } from "@/components/site/shell";
import { Reveal } from "@/components/site/motion";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/insights")({
  head: () => ({ meta: [
    { title: "Safety Insights — Nirbhaya" },
    { name: "description", content: "Danger zones, nearby emergency services and the weekly guardian safety report." },
    { property: "og:title", content: "Safety Insights — Nirbhaya" },
    { property: "og:description", content: "Danger-zone alerts, nearby services and weekly guardian reports (demo data)." },
    { property: "og:type", content: "website" }, { name: "twitter:card", content: "summary" },
  ] }),
  component: Insights,
});

const ZONES = [
  { name: "Old market underpass", risk: 82, reason: "Poor lighting after 21:00" },
  { name: "Station east exit", risk: 64, reason: "Reported harassment" },
  { name: "Lake road stretch", risk: 47, reason: "Low foot traffic" },
  { name: "Tech park gate", risk: 18, reason: "Well lit, security posted" },
];
const SERVICES = [
  { icon: ShieldAlert, type: "Police", name: "Central police station", km: 1.2 },
  { icon: Hospital, type: "Hospital", name: "City general hospital", km: 2.4 },
  { icon: Flame, type: "Fire", name: "Fire station no. 3", km: 3.1 },
  { icon: Hospital, type: "Clinic", name: "24h care clinic", km: 0.8 },
];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function Insights() {
  const [pos, setPos] = useState(0);
  const [week, setWeek] = useState([34, 28, 41, 22, 55, 61, 30]);
  useEffect(() => {
    const id = window.setInterval(() => setPos((p) => (p + 1) % 100), 150);
    return () => window.clearInterval(id);
  }, []);
  const near = ZONES.find((_, i) => Math.floor(pos / 25) === i)!;

  return <Page>
    <div className="border-b border-border-strong bg-surface"><div className="mx-auto max-w-[1600px] px-4 py-9 md:px-8"><p className="label-mono">Continuous awareness</p><h1 className="mt-2 font-display text-5xl uppercase leading-none md:text-7xl">Safety insights.</h1><p className="mt-3 max-w-xl text-sm text-muted-foreground">Danger-zone detection, nearby services and your weekly guardian report. Demo data.</p></div></div>

    <Section title="Danger zone detection" note="Live tracking simulation">
      <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
        <div className="relative h-72 overflow-hidden border border-border bg-surface-2">
          {ZONES.map((z, i) => <div key={z.name} className="absolute grid place-items-center" style={{ left: `${12 + i * 25}%`, top: `${30 + (i % 2) * 30}%` }}><span className="rounded-full bg-foreground/15" style={{ width: z.risk * 1.4, height: z.risk * 1.4 }} /><span className="absolute size-2 bg-foreground" /></div>)}
          <div className="absolute size-4 rounded-full border-2 border-background bg-foreground shadow-lg transition-all duration-150" style={{ left: `${pos}%`, top: `${45 + Math.sin(pos / 8) * 15}%` }} />
          <div className="absolute bottom-3 left-3 flex items-center gap-2 border border-border bg-background px-3 py-2 font-mono text-[10px] uppercase"><MapPin className="size-3" />Nearest: {near.name}</div>
        </div>
        <div className="border border-border bg-surface">{ZONES.map((z) => <div key={z.name} className={`border-b border-border p-4 transition-colors last:border-0 ${z === near ? "bg-foreground text-background" : ""}`}><div className="flex justify-between text-sm"><span>{z.name}</span><span className="font-mono">{z.risk}</span></div><p className="mt-1 text-xs opacity-70">{z.reason}</p>{z === near && z.risk > 60 && <p className="mt-2 flex items-center gap-1 font-mono text-[10px] uppercase"><AlertTriangle className="size-3" />Approaching high-risk zone — guardian notified (demo)</p>}</div>)}</div>
      </div>
    </Section>

    <Section title="Nearby emergency services" note="Sorted by distance">
      <div className="grid gap-4 md:grid-cols-4">{[...SERVICES].sort((a, b) => a.km - b.km).map((s, i) => <Reveal key={s.name} delay={i * 90}><div className="group h-full border border-border bg-surface p-5 transition-all hover:-translate-y-1 hover:border-foreground"><s.icon className="size-5 transition-transform group-hover:scale-125" /><p className="mt-4 label-mono">{s.type}</p><p className="mt-1 font-display text-2xl uppercase">{s.name}</p><p className="mt-2 font-mono text-sm">{s.km} km · {Math.round(s.km * 3)} min</p></div></Reveal>)}</div>
    </Section>

    <Section title="Weekly guardian report" note="Shared every Sunday">
      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="border border-border bg-surface p-6"><div className="flex h-48 items-end gap-3">{week.map((v, i) => <div key={i} className="flex flex-1 flex-col items-center gap-2"><span className="font-mono text-[10px]">{v}</span><div className="w-full bg-foreground transition-all duration-700" style={{ height: `${v * 2.4}px` }} /><span className="label-mono">{DAYS[i]}</span></div>)}</div><Button variant="outline" className="mt-5" onClick={() => setWeek(week.map(() => Math.round(15 + Math.random() * 55)))}>Regenerate week</Button></div>
        <div className="grid gap-px border border-border bg-border">{[["Trips monitored", "12"], ["SOS events", "1 (false alarm)"], ["Danger-zone passes", "3"], ["Avg. risk", `${Math.round(week.reduce((a, b) => a + b) / 7)}/100`]].map(([k, v]) => <div key={k} className="flex items-center justify-between bg-surface p-4"><span className="text-sm">{k}</span><span className="font-mono">{v}</span></div>)}<div className="flex items-center gap-2 bg-surface p-4 text-sm"><TrendingDown className="size-4" />Risk down 8% vs last week <Tag>DEMO</Tag></div></div>
      </div>
    </Section>
  </Page>;
}
