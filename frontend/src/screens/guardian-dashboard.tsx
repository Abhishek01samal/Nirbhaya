"use client";

import { useEffect, useState } from "react";
import { Bell, Phone, MessageCircle, Video, ShieldAlert, CheckCircle2, AlertTriangle, Clock, Activity, PhoneCall, PhoneIncoming } from "lucide-react";
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
  "SOS activated",
  "Guardian notified",
  "Location received",
  "Guardian acknowledged",
  "Emergency escalation started",
];

const SETTINGS = [
  "SOS alerts",
  "Major safety alerts",
  "Journey started",
  "Journey completed",
  "Route deviation",
  "Long stop",
];

const card = "rounded-2xl border border-border/70 bg-surface/70 p-5 shadow-sm backdrop-blur-sm";

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
          : "Not calling";

  return (
    <Page>
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-5xl uppercase leading-none tracking-tight md:text-6xl">Guardian</h1>
          <p className="mt-2 text-sm text-muted-foreground">Live view of Priya's safety state and journey.</p>
        </div>
        <span className={`inline-flex items-center gap-2 rounded-full px-4 py-2 font-mono text-[10px] uppercase tracking-widest ${active ? "bg-red-500/10 text-red-500" : "bg-emerald-500/10 text-emerald-500"}`}>
          <span className="relative flex size-2">
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${active ? "bg-red-500" : "bg-emerald-500"}`} />
            <span className={`relative inline-flex size-2 rounded-full ${active ? "bg-red-500" : "bg-emerald-500"}`} />
          </span>
          {active ? "Emergency" : "Safe"}
        </span>
      </div>

      {/* Status card */}
      <Reveal>
        <div className={`mt-6 rounded-2xl border p-6 ${active ? "border-red-500/40 bg-gradient-to-br from-red-950/40 to-red-900/10" : "border-emerald-500/30 bg-gradient-to-br from-emerald-950/20 to-emerald-900/5"}`}>
          <p className={`font-display text-4xl uppercase ${active ? "text-red-500" : "text-emerald-500"}`}>
            ● {active ? "Emergency" : "Safe"}
          </p>
          <p className="mt-2 text-sm">{active ? "Priya activated SOS." : "Priya is currently on a journey."}</p>
          <p className="mt-1 font-mono text-[10px] uppercase text-muted-foreground">Last update: {at ?? "10:42 PM"} · Location updated 12 sec ago</p>
        </div>
      </Reveal>

      {/* Emergency panel */}
      {active && (
        <Reveal>
          <div className="mt-4 rounded-2xl border-2 border-red-600 bg-red-950/30 p-6">
            <p className="flex items-center gap-2 font-display text-2xl uppercase text-red-500"><ShieldAlert className="size-5" /> Emergency</p>
            <p className="mt-2 text-sm">Priya activated SOS</p>
            <p className="mt-1 font-mono text-xs text-muted-foreground">
              Location: {sos?.location ? `${sos.location.lat.toFixed(2)}, ${sos.location.lng.toFixed(2)}` : "19.31, 84.79"} · Activated: {at ?? "10:21 PM"}
            </p>
            <div className="mt-5 flex gap-2">
              <Button size="sm" variant="destructive" className="rounded-full"><Phone className="mr-1 size-3" /> Call {guardian.name}</Button>
              <Button size="sm" variant="outline" className="rounded-full">View location</Button>
            </div>
          </div>
        </Reveal>
      )}

      {/* Guardian call status */}
      <Reveal delay={40}>
        <div className={`mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border p-6 ${callState === "answered" ? "border-emerald-500/40 bg-emerald-950/15" : "border-border/70 bg-surface/70 backdrop-blur-sm"}`}>
          <div className="flex items-center gap-4">
            <span className={`grid size-12 place-items-center rounded-full ${callState === "answered" ? "bg-emerald-500/15 text-emerald-500" : active ? "bg-red-500/15 text-red-500" : "bg-foreground/5 text-muted-foreground"}`}>
              {callState === "answered" ? <PhoneIncoming className="size-5" /> : <PhoneCall className="size-5" />}
            </span>
            <div>
              <p className="font-display text-2xl uppercase leading-none">{guardian.name}</p>
              <p className="mt-1.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Primary guardian · {guardian.relation} · {guardian.phone}</p>
            </div>
          </div>
          <span className={`inline-flex items-center gap-2 rounded-full px-4 py-2 font-mono text-[10px] uppercase tracking-widest ${callState === "answered" ? "bg-emerald-500/15 text-emerald-500" : active ? "bg-red-500/10 text-red-500" : "bg-foreground/5 text-muted-foreground"}`}>
            <span className={`size-2 rounded-full ${callState === "answered" ? "bg-emerald-500" : active ? "animate-pulse bg-red-500" : "bg-muted-foreground"}`} />
            {callLabel}
          </span>
        </div>
        {active && (
          <p className={`mt-2 font-mono text-xs ${callState === "answered" ? "text-emerald-500" : "text-muted-foreground"}`}>
            {callState === "answered"
              ? `SOS sent successfully — location & journey shared with ${guardian.name}.`
              : `Dialing ${guardian.name} · SOS will be delivered as soon as the call is picked up…`}
          </p>
        )}
      </Reveal>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <Reveal><SafetyMap emergency={active} /></Reveal>

        <div className="space-y-6">
          {/* Active journey */}
          <Reveal delay={80}>
            <div className={card}>
              <p className="label-mono">Active journey</p>
              <dl className="mt-4 space-y-2 text-sm">
                {([
                  ["From", JOURNEY.from],
                  ["To", JOURNEY.to],
                  ["Started", JOURNEY.started],
                  ["Transport", JOURNEY.transport],
                  ["Expected arrival", JOURNEY.eta],
                ] as const).map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-4 font-mono text-xs">
                    <dt className="text-muted-foreground">{k}</dt><dd className="text-right">{v}</dd>
                  </div>
                ))}
                <div className="flex justify-between font-mono text-xs"><dt className="text-muted-foreground">Status</dt><dd className="text-emerald-500">{JOURNEY.status}</dd></div>
              </dl>
              <p className="mt-4 border-t border-border/60 pt-3 font-mono text-[10px] uppercase text-muted-foreground">
                Driver: {JOURNEY.driver} · {JOURNEY.vehicle} · {JOURNEY.plate}
              </p>
            </div>
          </Reveal>

          {/* Contact */}
          <Reveal delay={140}>
            <div className={card}>
              <p className="label-mono">Contact · {guardian.name}</p>
              <div className="mt-4 grid grid-cols-3 gap-2">
                {[
                  { icon: Phone, label: "Call" },
                  { icon: MessageCircle, label: "Message" },
                  { icon: Video, label: "Video" },
                ].map(({ icon: Icon, label }) => (
                  <Button key={label} size="sm" variant="outline" className="rounded-xl font-mono text-[10px]">
                    <Icon className="size-3" /> {label}
                  </Button>
                ))}
              </div>
            </div>
          </Reveal>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        {/* Timeline */}
        <Reveal delay={60}>
          <div className={card}>
            <p className="label-mono flex items-center gap-2"><Activity className="size-3" /> SOS timeline</p>
            <ol className="mt-4 space-y-3">
              {TIMELINE.map((t, i) => (
                <li key={t} className="flex items-center gap-3 text-sm">
                  <span className="grid size-6 place-items-center rounded-full bg-foreground/5 font-mono text-[10px]">{i + 1}</span>
                  <Clock className="size-3 text-muted-foreground" />
                  {t}
                </li>
              ))}
            </ol>
          </div>
        </Reveal>

        {/* Alerts */}
        <Reveal delay={120}>
          <div className={card}>
            <p className="label-mono">Safety alerts</p>
            <ul className="mt-4 space-y-4">
              {ALERTS.map((a) => (
                <li key={a.title} className="flex items-start gap-3">
                  <span className="mt-0.5 grid size-8 place-items-center rounded-xl bg-amber-500/10"><AlertTriangle className="size-4 text-amber-500" /></span>
                  <div>
                    <p className="text-sm font-semibold">{a.title} <span className="ml-2 font-mono text-[10px] font-normal text-muted-foreground">{a.at}</span></p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{a.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>

      {/* Acknowledgement */}
      <Reveal delay={160}>
        <div className="mt-6 rounded-2xl border border-amber-500/40 bg-amber-950/10 p-6">
          <p className="font-display text-2xl uppercase">⚠ Safety alert</p>
          <p className="mt-2 text-sm text-muted-foreground">A possible safety issue was detected during Priya's journey. · 10:18 PM</p>
          <div className="mt-5 flex gap-2">
            <Button size="sm" className="rounded-full">Acknowledge</Button>
            <Button size="sm" variant="outline" className="rounded-full">View map</Button>
          </div>
        </div>
      </Reveal>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Reveal>
          <div className={card}>
            <p className="label-mono flex items-center gap-2"><Bell className="size-3" /> Notifications</p>
            <ul className="mt-4 space-y-3 text-sm">
              {NOTIFICATIONS.map((n) => (
                <li key={n.text} className="flex items-start gap-2.5">
                  <span className={`mt-1.5 size-2 shrink-0 rounded-full ${n.dot}`} />
                  <span><span className="font-semibold">{n.text}</span> <span className="font-mono text-[10px] text-muted-foreground">· {n.at}</span></span>
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={80}>
          <div className={card}>
            <p className="label-mono">Recent journeys</p>
            <ul className="mt-4 space-y-4">
              {JOURNEYS.map((j) => (
                <li key={j.route} className="flex items-center justify-between text-sm">
                  <div><p className="font-medium">{j.route}</p><p className="font-mono text-[10px] text-muted-foreground">{j.time}</p></div>
                  <CheckCircle2 className="size-4 text-emerald-500" />
                </li>
              ))}
            </ul>
          </div>
        </Reveal>

        <Reveal delay={140}>
          <div className={card}>
            <p className="label-mono">Notification settings</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {SETTINGS.map((s) => (
                <li key={s} className="flex items-center justify-between">
                  <span>{s}</span>
                  <label className="relative inline-flex h-5 w-9 cursor-pointer items-center rounded-full bg-foreground/15 transition-colors has-[:checked]:bg-emerald-500">
                    <input type="checkbox" defaultChecked aria-label={s} className="peer sr-only" />
                    <span className="size-4 translate-x-0.5 rounded-full bg-background shadow transition-transform peer-checked:translate-x-[18px]" />
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
