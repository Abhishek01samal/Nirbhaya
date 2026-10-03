"use client";

import { useEffect, useState } from "react";
import {
  Bell,
  Phone,
  MessageCircle,
  Video,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Activity,
  Navigation,
  Radio,
  Gauge,
  ChevronRight,
  Siren,
  MapPinned,
} from "lucide-react";
import { Page } from "@/components/site/shell";
import { SafetyMap } from "@/components/site/safety-map";
import { Button } from "@/components/ui/button";
import { Reveal } from "@/components/site/motion";
import { useSos } from "@/lib/sos-store";
import { guardians as mockGuardians } from "@/lib/mock-data";

type PrimaryGuardian = { name: string; relation: string; phone: string };

const DEFAULT_GUARDIAN: PrimaryGuardian = {
  name: mockGuardians[0]?.name ?? "Anika Rao",
  relation: mockGuardians[0]?.relation ?? "Sister",
  phone: mockGuardians[0]?.phone ?? "+91 98765 43210",
};

function readPrimaryGuardian(): PrimaryGuardian {
  try {
    const saved = window.localStorage.getItem("Nirbhaya-guardians");
    if (saved) {
      const list = JSON.parse(saved) as Array<PrimaryGuardian & { id?: string; priority?: number }>;
      const primary = list.find((g) => g.priority === 1) ?? list[0];
      if (primary?.name) return { name: primary.name, relation: primary.relation ?? "", phone: primary.phone ?? "" };
    }
  } catch {
    /* fall back to default */
  }
  return DEFAULT_GUARDIAN;
}

const JOURNEY = {
  from: "Bhubaneswar Railway Station",
  to: "Home",
  started: "9:48 PM",
  transport: "Cab",
  eta: "10:35 PM",
  minsAway: 13,
  status: "On expected route",
  driver: "Rahul",
  vehicle: "White Swift",
  plate: "OD-02-AB-1234",
};

const JOURNEYS = [
  { route: "Home → Office", time: "8:15 AM – 8:52 AM" },
  { route: "College → Home", time: "6:10 PM – 6:48 PM" },
  { route: "Home → Station", time: "4:20 PM – 4:55 PM" },
];

const ALERTS = [
  { title: "Route deviation", at: "10:14 PM", detail: "User has moved away from the expected route." },
  { title: "Extended stop", at: "10:08 PM", detail: "Vehicle has remained stationary for 6 minutes." },
];

const NOTIFICATIONS = [
  { at: "10:21 PM", text: "SOS activated", dot: "bg-red-500" },
  { at: "10:18 PM", text: "Possible safety concern detected", dot: "bg-amber-500" },
  { at: "10:14 PM", text: "Route deviation detected", dot: "bg-amber-400" },
  { at: "9:42 PM", text: "Journey completed", dot: "bg-emerald-500" },
];

const TIMELINE = [
  { at: "10:21:03", text: "SOS activated", tone: "red" },
  { at: "10:21:08", text: "Guardian notified", tone: "red" },
  { at: "10:21:15", text: "Live location shared", tone: "amber" },
  { at: "10:21:42", text: "Guardian acknowledged", tone: "emerald" },
  { at: "10:22:10", text: "Emergency escalation started", tone: "emerald" },
] as const;

const SETTINGS = [
  "SOS alerts",
  "Major safety alerts",
  "Journey started",
  "Journey completed",
  "Route deviation",
  "Long stop",
];

const toneMap = {
  red: "bg-red-500 text-red-500",
  amber: "bg-amber-500 text-amber-500",
  emerald: "bg-emerald-500 text-emerald-500",
} as const;

const card = "rounded-3xl border border-border/70 bg-gradient-to-b from-surface/90 to-surface/60 p-6 shadow-[0_1px_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-24px_rgba(0,0,0,0.6)] backdrop-blur-sm transition-colors hover:border-border";

function StatTile({ icon: Icon, label, value, hint, tone = "default" }: {
  icon: typeof Activity;
  label: string;
  value: string;
  hint: string;
  tone?: "default" | "red" | "emerald";
}) {
  const tones = {
    default: "text-foreground from-foreground/5",
    red: "text-red-500 from-red-500/10",
    emerald: "text-emerald-500 from-emerald-500/10",
  } as const;
  return (
    <div className={`group relative overflow-hidden rounded-2xl border border-border/60 bg-gradient-to-br ${tones[tone]} to-transparent p-4`}>
      <div className="flex items-center justify-between">
        <span className="label-mono">{label}</span>
        <Icon className={`size-4 ${tones[tone].split(" ")[0]}`} />
      </div>
      <p className="mt-3 font-display text-3xl leading-none">{value}</p>
      <p className="mt-1.5 font-mono text-[11px] uppercase tracking-widest text-foreground/70">{hint}</p>
    </div>
  );
}

export function GuardianDashboard() {
  const { active, sos } = useSos();
  const [guardian, setGuardian] = useState<PrimaryGuardian>(DEFAULT_GUARDIAN);
  const [callState, setCallState] = useState<"idle" | "dialing" | "ringing" | "answered">("idle");
  const at = sos?.createdAt
    ? new Date(sos.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
    : null;

  useEffect(() => {
    setGuardian(readPrimaryGuardian());
    const onStorage = (e: StorageEvent) => {
      if (e.key === "Nirbhaya-guardians") setGuardian(readPrimaryGuardian());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    if (!active) {
      setCallState("idle");
      return;
    }
    setCallState("dialing");
    const ring = setTimeout(() => setCallState("ringing"), 1800);
    const answer = setTimeout(() => setCallState("answered"), 4500);
    return () => {
      clearTimeout(ring);
      clearTimeout(answer);
    };
  }, [active]);

  const callLabel =
    callState === "dialing"
      ? `Calling ${guardian.name}…`
      : callState === "ringing"
        ? "Ringing…"
        : callState === "answered"
          ? `${guardian.name} picked up the call`
          : "Standby";
  const steps = ["Dialing", "Ringing", "Picked up"];
  const stepIndex = callState === "dialing" ? 0 : callState === "ringing" ? 1 : callState === "answered" ? 2 : -1;
  const initials = guardian.name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <Page>
      {/* Hero banner */}
      <Reveal>
        <div className="relative overflow-hidden rounded-[28px] border border-red-500/40 bg-[radial-gradient(120%_140%_at_0%_0%,rgba(220,38,38,0.35),rgba(127,29,29,0.12)_45%,transparent_75%),linear-gradient(180deg,rgba(23,3,3,0.9),rgba(10,2,2,0.75))] p-7 md:p-9">
          <div className="pointer-events-none absolute -top-16 -right-10 size-64 rounded-full bg-red-600/20 blur-3xl" />
          <div className="pointer-events-none absolute right-24 bottom-0 size-40 rounded-full bg-orange-500/10 blur-3xl" />

          <div className="relative flex flex-wrap items-start justify-between gap-6">
            <div>
              <span className="inline-flex items-center gap-2 rounded-full border border-red-500/50 bg-red-500/15 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-red-400">
                <span className="relative flex size-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                  <span className="relative inline-flex size-2 rounded-full bg-red-500" />
                </span>
                SOS active
              </span>
              <h1 className="mt-5 font-display text-6xl leading-[0.9] tracking-tight text-white uppercase md:text-7xl">
                Emergency<span className="text-red-500">.</span>
              </h1>
              <p className="mt-4 max-w-xl text-sm text-red-100/70">
                Priya activated SOS. Live location, journey and vitals are streaming to her guardian circle.
                Escalation is running automatically until acknowledged.
              </p>
              <div className="mt-5 flex flex-wrap gap-2 font-mono text-[11px] uppercase">
                {[
                  { k: "Activated", v: at ?? "10:21 PM" },
                  { k: "Trigger", v: sos?.triggerType ?? "MANUAL" },
                  { k: "GPS", v: "live · 12s ago" },
                  { k: "Escalation", v: "Level 2" },
                ].map((chip) => (
                  <span key={chip.k} className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-red-100/80 backdrop-blur">
                    <span className="text-red-300/60">{chip.k}:</span> {chip.v}
                  </span>
                ))}
              </div>
            </div>

            <div className="relative grid size-28 shrink-0 place-items-center md:size-36">
              <span className="absolute inset-0 animate-ping rounded-full border border-red-500/40" style={{ animationDuration: "2.4s" }} />
              <span className="absolute inset-3 animate-ping rounded-full border border-red-500/30" style={{ animationDuration: "1.6s" }} />
              <span className="absolute inset-6 rounded-full bg-red-500/20 blur-xl" />
              <span className="relative grid size-16 place-items-center rounded-full bg-red-600 shadow-[0_0_50px_rgba(220,38,38,0.7)] md:size-20">
                <Siren className="size-8 text-white md:size-9" />
              </span>
            </div>
          </div>
        </div>
      </Reveal>

      {/* Quick stats */}
      <div className="mt-5 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Reveal delay={40}><StatTile icon={Clock} label="Response" value="00:42" hint="since SOS" tone="red" /></Reveal>
        <Reveal delay={80}><StatTile icon={Bell} label="Guardians" value="3 / 3" hint="notified instantly" /></Reveal>
        <Reveal delay={120}><StatTile icon={Radio} label="Location" value="±7 m" hint="gps accuracy" tone="emerald" /></Reveal>
        <Reveal delay={160}><StatTile icon={Navigation} label="Route" value="98%" hint="on expected path" tone="emerald" /></Reveal>
      </div>

      {/* Guardian call card */}
      <Reveal delay={80}>
        <div className={`mt-6 rounded-3xl border p-6 backdrop-blur-sm transition-all md:p-7 ${callState === "answered" ? "border-emerald-500/40 bg-gradient-to-r from-emerald-950/40 via-surface/80 to-surface/50 shadow-[0_0_50px_-20px_rgba(16,185,129,0.5)]" : "border-border/70 bg-surface/80"}`}>
          <div className="flex flex-wrap items-center justify-between gap-6">
            <div className="flex items-center gap-5">
              <div className="relative">
                {active && callState !== "answered" && (
                  <span className="absolute -inset-1.5 animate-ping rounded-full border-2 border-red-500/50" style={{ animationDuration: "1.4s" }} />
                )}
                <span className={`relative grid size-16 place-items-center rounded-full font-display text-xl md:size-18 ${callState === "answered" ? "bg-emerald-500/15 text-emerald-500 ring-2 ring-emerald-500/50" : "bg-red-500/15 text-red-500 ring-2 ring-red-500/40"}`}>
                  {initials}
                </span>
              </div>
              <div>
                <p className="label-mono">Primary guardian · {guardian.relation}</p>
                <p className="mt-1.5 font-display text-3xl uppercase leading-none md:text-4xl">{guardian.name}</p>
                <p className="mt-2 font-mono text-xs text-foreground/70">{guardian.phone}</p>
              </div>
            </div>

            <span className={`inline-flex items-center gap-2 rounded-full px-4 py-2.5 font-mono text-xs uppercase tracking-widest ${callState === "answered" ? "bg-emerald-500/15 text-emerald-500" : active ? "bg-red-500/10 text-red-500" : "bg-foreground/5 text-foreground/70"}`}>
              <span className={`size-2 rounded-full ${callState === "answered" ? "bg-emerald-500" : active ? "animate-pulse bg-red-500" : "bg-muted-foreground"}`} />
              {callLabel}
            </span>
          </div>

          {/* Call progress steps */}
          <div className="mt-6 grid grid-cols-3 gap-2">
            {steps.map((s, i) => (
              <div key={s}>
                <div className={`h-1.5 rounded-full transition-all duration-500 ${stepIndex >= i ? (callState === "answered" ? "bg-emerald-500" : "bg-red-500") : "bg-foreground/10"}`} />
                <p className={`mt-2 font-mono text-[11px] uppercase tracking-widest ${stepIndex >= i ? (callState === "answered" ? "text-emerald-500" : "text-red-500") : "text-foreground/70"}`}>
                  {i + 1}. {s}
                </p>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button size="sm" className="rounded-full bg-red-600 text-white hover:bg-red-700"><Phone className="mr-1.5 size-3.5" /> Call {guardian.name}</Button>
            <Button size="sm" variant="outline" className="rounded-full"><MessageCircle className="mr-1.5 size-3.5" /> Message</Button>
            <Button size="sm" variant="outline" className="rounded-full"><Video className="mr-1.5 size-3.5" /> Video</Button>
            <p className={`ml-auto font-mono text-xs ${callState === "answered" ? "text-emerald-500" : "text-foreground/70"}`}>
              {callState === "answered"
                ? `SOS sent successfully — location & journey shared with ${guardian.name}.`
                : active
                  ? `Dialing ${guardian.name} · SOS delivers the moment the call is picked up…`
                  : "No active call."}
            </p>
          </div>
        </div>
      </Reveal>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        {/* Live map */}
        <Reveal>
          <div className="overflow-hidden rounded-3xl border border-border/70">
            <div className="flex items-center justify-between border-b border-border/70 bg-surface/80 px-5 py-3.5 backdrop-blur">
              <p className="label-mono flex items-center gap-2"><MapPinned className="size-3.5 text-red-500" /> Live location</p>
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] uppercase text-emerald-500">
                <Radio className="size-3 animate-pulse" /> streaming
              </span>
            </div>
            <div className="bg-surface">
              <SafetyMap emergency={active} />
            </div>
          </div>
        </Reveal>

        <div className="space-y-6">
          {/* Active journey */}
          <Reveal delay={80}>
            <div className={card}>
              <div className="flex items-center justify-between">
                <p className="label-mono">Active journey</p>
                <span className="rounded-full bg-emerald-500/10 px-2.5 py-1 font-mono text-[11px] uppercase text-emerald-500">{JOURNEY.status}</span>
              </div>

              <div className="mt-5 flex items-stretch gap-4">
                <div className="flex flex-col items-center pt-1.5">
                  <span className="size-3 rounded-full bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.8)]" />
                  <span className="my-1 w-px flex-1 bg-gradient-to-b from-emerald-500/70 via-border to-red-500/70" />
                  <span className="size-3 rounded-full bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.8)]" />
                </div>
                <div className="flex-1 space-y-5">
                  <div>
                    <p className="font-mono text-[11px] uppercase text-foreground/70">From</p>
                    <p className="mt-0.5 font-display text-xl uppercase leading-tight">{JOURNEY.from}</p>
                    <p className="font-mono text-[11px] text-foreground/70">Departed {JOURNEY.started}</p>
                  </div>
                  <div>
                    <p className="font-mono text-[11px] uppercase text-foreground/70">To</p>
                    <p className="mt-0.5 font-display text-xl uppercase leading-tight">{JOURNEY.to}</p>
                    <p className="font-mono text-[11px] text-foreground/70">Expected {JOURNEY.eta}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-mono text-[11px] uppercase text-foreground/70">ETA</p>
                  <p className="font-display text-4xl leading-none text-emerald-500">{JOURNEY.minsAway}<span className="text-sm"> min</span></p>
                </div>
              </div>

              <div className="mt-5 grid grid-cols-3 gap-2 border-t border-border/60 pt-4 font-mono text-center text-[11px] uppercase">
                <div><p className="text-foreground/70">Transport</p><p className="mt-1 text-sm text-foreground">{JOURNEY.transport}</p></div>
                <div><p className="text-foreground/70">Driver</p><p className="mt-1 text-sm text-foreground">{JOURNEY.driver}</p></div>
                <div><p className="text-foreground/70">Vehicle</p><p className="mt-1 text-sm text-foreground">{JOURNEY.plate}</p></div>
              </div>
            </div>
          </Reveal>

          {/* Contact */}
          <Reveal delay={140}>
            <div className={card}>
              <p className="label-mono">Quick contact</p>
              <div className="mt-4 grid grid-cols-3 gap-3">
                {[
                  { icon: Phone, label: "Call", tint: "hover:border-red-500/50 hover:text-red-500" },
                  { icon: MessageCircle, label: "Message", tint: "hover:border-emerald-500/50 hover:text-emerald-500" },
                  { icon: Video, label: "Video", tint: "hover:border-sky-500/50 hover:text-sky-500" },
                ].map(({ icon: Icon, label, tint }) => (
                  <button key={label} type="button" className={`flex flex-col items-center gap-2.5 rounded-2xl border border-border/60 bg-background/40 py-5 transition-all hover:-translate-y-0.5 ${tint}`}>
                    <span className="grid size-10 place-items-center rounded-full bg-foreground/5"><Icon className="size-4" /></span>
                    <span className="font-mono text-[11px] uppercase tracking-widest">{label}</span>
                  </button>
                ))}
              </div>
              <p className="mt-4 text-center font-mono text-[11px] uppercase text-foreground/70">Calling priority 1 · {guardian.name}</p>
            </div>
          </Reveal>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Timeline */}
        <Reveal delay={60}>
          <div className={card}>
            <p className="label-mono flex items-center gap-2"><Activity className="size-3" /> SOS timeline</p>
            <ol className="relative mt-5 space-y-5 pl-1">
              <span className="absolute top-1 bottom-1 left-[7px] w-px bg-gradient-to-b from-red-500 via-amber-500/70 to-emerald-500" />
              {TIMELINE.map((t, i) => (
                <li key={t.text} className="relative flex items-start gap-4 pl-6">
                  <span className={`absolute left-0 top-1.5 size-[15px] rounded-full border-4 border-background ${toneMap[t.tone]} shadow-[0_0_10px_rgba(0,0,0,0.4)]`} />
                  <div className="flex flex-1 items-center justify-between gap-3">
                    <p className="text-sm font-medium">{t.text}</p>
                    <span className="font-mono text-[11px] text-foreground/70">{t.at}</span>
                  </div>
                  {i === TIMELINE.length - 1 && <ChevronRight className="size-4 text-emerald-500" />}
                </li>
              ))}
            </ol>
          </div>
        </Reveal>

        {/* Alerts */}
        <Reveal delay={120}>
          <div className={card}>
            <p className="label-mono">Safety alerts</p>
            <ul className="mt-5 space-y-4">
              {ALERTS.map((a) => (
                <li key={a.title} className="flex items-start gap-3.5 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 transition-colors hover:border-amber-500/40">
                  <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-amber-500/15"><AlertTriangle className="size-4 text-amber-500" /></span>
                  <div>
                    <p className="text-sm font-semibold">{a.title} <span className="ml-2 font-mono text-[11px] font-normal text-foreground/70">{a.at}</span></p>
                    <p className="mt-1 text-xs text-foreground/70">{a.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-5 rounded-2xl border border-red-500/30 bg-red-950/20 p-4">
              <p className="flex items-center gap-2 font-display text-xl uppercase text-red-500"><Siren className="size-4" /> Emergency panel</p>
              <p className="mt-1.5 font-mono text-xs text-foreground/70">
                Location: {sos?.location ? `${sos.location.lat.toFixed(2)}, ${sos.location.lng.toFixed(2)}` : "19.31, 84.79"} · Activated: {at ?? "10:21 PM"}
              </p>
              <div className="mt-3.5 flex gap-2">
                <Button size="sm" variant="destructive" className="rounded-full"><Phone className="mr-1 size-3" /> Call {guardian.name}</Button>
                <Button size="sm" variant="outline" className="rounded-full">View location</Button>
              </div>
            </div>
          </div>
        </Reveal>
      </div>

      {/* Acknowledgement */}
      <Reveal delay={160}>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-5 rounded-3xl border border-amber-500/40 bg-[linear-gradient(120deg,rgba(146,64,14,0.25),rgba(69,26,3,0.12))] p-6 backdrop-blur">
          <div className="flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-amber-500/15"><AlertTriangle className="size-5 text-amber-500" /></span>
            <div>
              <p className="font-display text-2xl uppercase leading-none">⚠ Safety alert</p>
              <p className="mt-2 text-sm text-amber-100/70">A possible safety issue was detected during Priya's journey. · 10:18 PM</p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button size="sm" className="rounded-full bg-amber-500 text-black hover:bg-amber-400"><CheckCircle2 className="mr-1.5 size-3.5" /> Acknowledge</Button>
            <Button size="sm" variant="outline" className="rounded-full">View map</Button>
          </div>
        </div>
      </Reveal>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Reveal>
          <div className={`${card} h-full`}>
            <p className="label-mono flex items-center gap-2"><Bell className="size-3" /> Notifications</p>
            <ul className="mt-5 space-y-3.5 text-sm">
              {NOTIFICATIONS.map((n) => (
                <li key={n.text} className="flex items-start gap-3 rounded-xl px-2 -mx-2 py-1.5 transition-colors hover:bg-foreground/[0.03]">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.dot}`} />
                  <span><span className="font-semibold">{n.text}</span> <span className="font-mono text-[11px] text-foreground/70">· {n.at}</span></span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={80}>
          <div className={`${card} h-full`}>
            <p className="label-mono">Recent journeys</p>
            <ul className="mt-5 space-y-3">
              {JOURNEYS.map((j) => (
                <li key={j.route} className="group flex items-center justify-between rounded-xl border border-border/50 bg-background/30 px-4 py-3 transition-all hover:border-emerald-500/40">
                  <div><p className="text-sm font-medium">{j.route}</p><p className="font-mono text-[11px] text-foreground/70">{j.time}</p></div>
                  <span className="grid size-8 place-items-center rounded-full bg-emerald-500/10 transition-transform group-hover:scale-110"><CheckCircle2 className="size-4 text-emerald-500" /></span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={140}>
          <div className={`${card} h-full`}>
            <p className="label-mono flex items-center gap-2"><Gauge className="size-3" /> Notification settings</p>
            <ul className="mt-5 space-y-3 text-sm">
              {SETTINGS.map((s) => (
                <li key={s} className="flex items-center justify-between">
                  <span>{s}</span>
                  <label className="relative inline-flex h-6 w-11 cursor-pointer items-center rounded-full bg-foreground/15 transition-colors has-[:checked]:bg-emerald-500">
                    <input type="checkbox" defaultChecked aria-label={s} className="peer sr-only" />
                    <span className="size-5 translate-x-0.5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-[22px]" />
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </Page>
  );
}
