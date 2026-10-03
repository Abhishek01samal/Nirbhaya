"use client";

import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { Activity, BatteryMedium, ShieldCheck, Siren, Wifi } from "lucide-react";
import { BootReveal, Reveal, RouteProgress } from "./motion";
import { useSos } from "@/lib/sos-store";
import { backendHealth } from "@/lib/api";

const NAV = [
  { to: "/", label: "Dashboard" },
  { to: "/assistant", label: "Assistant" },
  { to: "/guardians", label: "Guardians" },
  { to: "/ride", label: "Safe ride" },
  { to: "/routes", label: "Routes" },
  { to: "/insights", label: "Insights" },
  { to: "/settings", label: "Settings" },
] as const;

function Clock() {
  const [time, setTime] = useState("--:--:--");
  useEffect(() => {
    const tick = () => setTime(new Date().toLocaleTimeString("en-GB", { hour12: false }));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return <span className="font-mono text-[10px] tabular-nums">{time}</span>;
}

export function Header() {
  const location = useLocation();
  const pathname = location?.pathname ?? "/";
  const { active } = useSos();
  const [live, setLive] = useState(false);
  useEffect(() => {
    backendHealth().then(setLive).catch(() => setLive(false));
  }, []);
  const isActive = (to: string) => (pathname ? (to === "/" ? pathname === "/" : pathname.startsWith(to)) : false);
  return (
    <header className="sticky top-0 z-50 border-b border-border-strong bg-background/95 backdrop-blur-sm">
      {active ? (
        <div className="flex items-center justify-center gap-3 bg-red-700 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-white">
          <Siren className="size-3.5 animate-pulse" /> SOS live — guardians and responders are being notified
        </div>
      ) : null}
      <div className="mx-auto flex h-16 max-w-[1600px] items-center px-4 md:px-8">
        <Link to="/" className="flex items-center gap-3 border-r border-border pr-5">
          <span className="relative grid size-7 place-items-center border border-border-strong">
            <span className={`size-2 ${active ? "animate-pulse bg-red-700" : "bg-foreground"}`} />
            <span className="absolute -right-1 -top-1 size-1.5 bg-foreground" />
          </span>
          <span className="font-display text-2xl leading-none uppercase">Nirbhaya</span>
        </Link>
        <nav className="ml-5 hidden h-full items-stretch md:flex">
          {NAV.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              className={`group flex min-w-24 items-center gap-2 border-r border-border px-4 font-mono text-[10px] uppercase text-muted-foreground transition-colors hover:bg-foreground hover:text-background ${isActive(item.to) ? "!bg-foreground !text-background" : ""}`}
            >
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4 font-mono text-[10px] uppercase">
          <span className="hidden items-center gap-2 lg:flex"><Wifi className="size-3.5" />{live ? "API linked" : "API offline"}</span>
          <span className="hidden items-center gap-2 sm:flex"><BatteryMedium className="size-4" />Ready</span>
          <span className="flex items-center gap-2"><span className={`pulse-ring size-1.5 ${active ? "bg-red-700" : "bg-foreground"}`} />{active ? "Alert" : live ? "Live" : "Local"}</span>
          <Clock />
        </div>
      </div>
      <div className="flex h-9 items-center gap-6 overflow-x-auto border-t border-border px-4 md:hidden">
        {NAV.map((item) => <Link key={item.to} to={item.to} className={`label-mono whitespace-nowrap ${isActive(item.to) ? "!text-foreground underline underline-offset-4" : ""}`}>{item.label}</Link>)}
      </div>
    </header>
  );
}

const TICKER = ["Heart-rate agent · nominal", "Motion agent · listening", "Location lock ± 7 m", "Guardian relay · linked", "Threat context · clear", "Danger zones · mapped", "Audit trail · recording", "Backend orchestration · connected"];
const SOS_TICKER = ["SOS ACTIVE", "Location streaming", "Guardians notified", "Voice capture on", "Escalation running", "Stay visible if you can", "Emergency services queued"];

export function StatusRail() {
  const { active } = useSos();
  const items = active ? SOS_TICKER : TICKER;
  return (
    <div className={`overflow-hidden border-b border-border ${active ? "bg-red-700 text-white" : "bg-foreground text-background"}`}>
      <div className="marquee-track flex w-max gap-10 py-2">
        {[...items, ...items].map((t, i) => <span key={i} className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.18em] whitespace-nowrap"><Activity className="size-3" />{t}<ShieldCheck className="size-3 opacity-40" /></span>)}
      </div>
    </div>
  );
}

function Backdrop() {
  useEffect(() => {
    const move = (e: PointerEvent) => { document.documentElement.style.setProperty("--cx", `${e.clientX}px`); document.documentElement.style.setProperty("--cy", `${e.clientY}px`); };
    window.addEventListener("pointermove", move);
    return () => window.removeEventListener("pointermove", move);
  }, []);
  return <div aria-hidden className="pointer-events-none fixed inset-0 -z-0"><div className="bg-grid-anim absolute inset-0" /><div className="cursor-glow absolute inset-0" /><div className="scanline absolute inset-x-0 top-0 h-40" /></div>;
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="relative min-h-screen bg-background"><Backdrop /><BootReveal /><RouteProgress /><Header /><StatusRail /><main className="page-enter relative z-10">{children}</main></div>;
}

export function PageHeading({ title, note }: { index?: string; title: string; note: string }) {
  return (
    <div className="mx-auto flex max-w-[1600px] items-end justify-between gap-6 border-b-2 border-border-strong px-4 py-8 md:px-8 md:py-10">
      <div><span className="label-mono">Nirbhaya</span><h1 className="font-display mt-2 text-5xl leading-[0.82] uppercase md:text-7xl">{title}</h1></div>
      <p className="hidden max-w-xs text-right font-mono text-[9px] uppercase leading-relaxed text-muted-foreground md:block">{note}</p>
    </div>
  );
}

export function Section({ title, note, children }: { index?: string; title: string; note?: string; children: ReactNode }) {
  return <section className="border-b border-border"><div className="mx-auto max-w-[1600px] px-4 py-10 md:px-8"><div className="mb-5 flex items-end gap-4"><h2 className="font-display text-4xl uppercase leading-none md:text-5xl">{title}</h2><span className="mb-2 h-px flex-1 bg-border-strong/30" />{note ? <span className="label-mono ml-auto hidden sm:block">{note}</span> : null}</div><Reveal>{children}</Reveal></div></section>;
}

export function Tag({ children, inverse = false }: { children: ReactNode; inverse?: boolean }) {
  return <span className={`inline-flex border border-border-strong px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.12em] ${inverse ? "bg-foreground text-background" : "bg-background text-foreground"}`}>{children}</span>;
}
