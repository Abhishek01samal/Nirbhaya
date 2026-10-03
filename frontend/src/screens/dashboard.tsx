"use client";

import { ChatWidget } from "@/components/site/chat-widget";
import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, Flame, HeartPulse, Hospital, Mic, RotateCcw, ShieldAlert, Siren, Smartphone, Users, Vibrate, Zap } from "lucide-react";
import { Page, Section, Tag } from "@/components/site/shell";
import { SafetyMap } from "@/components/site/safety-map";
import { EcgMonitor } from "@/components/site/ecg";
import { LiveMic } from "@/components/site/live-mic";
import { Reveal } from "@/components/site/motion";
import { Button } from "@/components/ui/button";
import { guardians, vitals } from "@/lib/mock-data";
import { analyzeSpeech } from "@/lib/threat";
import { useSos } from "@/lib/sos-store";

const risk = Math.min(100, Math.round((78 / 180) * 30 + (2.4 / 10) * 30 + (38 / 120) * 20 + (4.2 / 10) * 20));

type Trigger = "heart" | "shake" | "offline";
const TRIGGERS: { id: Trigger; label: string; icon: typeof HeartPulse; detail: string }[] = [
  { id: "heart", label: "Heart rate", icon: HeartPulse, detail: "Reading above your threshold, verified over 3 samples" },
  { id: "shake", label: "Hand shake", icon: Vibrate, detail: "Configured vigorous shake pattern recognised" },
  { id: "offline", label: "Device offline", icon: Smartphone, detail: "Low-level alert; escalates only with prior signals" },
];

const SCRIPTS = [
  "Help me! Someone is following me and won't stop!",
  "Help! My house is on fire, there is smoke everywhere!",
  "I can't breathe, I think I'm bleeding, I need a doctor",
  "I'm just watching a movie about a fire, all good.",
];

const AGENTS = ["Trigger", "Location", "Voice recording", "Speech-to-text", "Threat detection", "Classification", "Guardian", "Emergency service", "Nearby services"];

export function Dashboard() {
  const { active, triggerSos, standDown, linked, lastError, sos: sosRecord } = useSos();
  const [running, setRunning] = useState(false);
  const sos = running || active;
  const [jitter, setJitter] = useState([0, 0, 0]);
  const [trigger, setTrigger] = useState<Trigger>("heart");
  const [threshold, setThreshold] = useState(120);
  const [bpm, setBpm] = useState(82);
  const [script, setScript] = useState<string>(SCRIPTS[0]!);
  const [tick, setTick] = useState(0);
  const [log, setLog] = useState<{ t: string; msg: string }[]>([]);
  const [transcript, setTranscript] = useState<{ original: string; english: string } | null>(null);
  const logged = useRef(new Set<number>());

  useEffect(() => {
    const id = window.setInterval(() => setJitter([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]), 1500);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setBpm((b) => {
      const target = sos && trigger === "heart" ? threshold + 18 : 80;
      return Math.round(b + (target - b) * 0.25 + (Math.random() - 0.5) * 4);
    }), 700);
    return () => window.clearInterval(id);
  }, [sos, trigger, threshold]);

  useEffect(() => {
    if (!sos) return;
    const id = window.setInterval(() => setTick((t) => (t >= 100 ? t : t + 1)), 120);
    return () => window.clearInterval(id);
  }, [sos]);

  // Live speech wins over the preset script: the English translation is what
  // analyzeSpeech can actually read, since its keywords are English-only.
  const spoken = transcript?.english.trim() ?? "";
  const analysis = useMemo(() => analyzeSpeech(spoken || script), [spoken, script]);
  const escalate = trigger !== "offline" || analysis.confidence > 50;
  const typed = script.slice(0, Math.max(0, Math.round(((tick - 30) / 20) * script.length)));

  const progress = (i: number) => {
    const start = i * 9;
    if (!escalate && i >= 6) return 0;
    if (analysis.category === "No emergency" && i >= 6) return 0;
    return Math.max(0, Math.min(100, Math.round(((tick - start) / 18) * 100)));
  };

  const events: [number, string][] = useMemo(() => [
    [2, `Trigger fired: ${TRIGGERS.find((x) => x.id === trigger)!.label}`],
    [10, "Location agent locked GPS ± 7 m"],
    [20, "Voice recording started (consent on file) — incident SP-" + new Date().getDate() + "0927"],
    [45, `Transcript ready: “${spoken || script}”`],
    [55, `Threat agent confidence ${analysis.confidence}% — ${analysis.category}`],
    [65, analysis.category === "No emergency" ? "False-alarm prevention: context indicates no emergency, SOS stood down" : `Guardian agent notifying ${guardians[0]!.name} (priority 1)`],
    [78, analysis.category === "No emergency" ? "Monitoring resumed" : `Emergency agent routing to ${analysis.services.join(", ")}`],
    [90, analysis.category === "No emergency" ? "Audit trail closed" : "Nearest services shared with guardians with live location"],
  ], [trigger, spoken, script, analysis]);

  useEffect(() => {
    events.forEach(([at, msg]) => {
      if (tick >= at && !logged.current.has(at)) {
        logged.current.add(at);
        setLog((l) => [{ t: new Date().toLocaleTimeString("en-GB"), msg }, ...l]);
      }
    });
  }, [tick, events]);

  // Each completed phrase is logged as it lands, outside the tick sequence.
  const micRef = useRef<((r: { original: string; english: string }) => void) | null>(null);
  useEffect(() => {
    micRef.current = (r) => {
      setTranscript(r);
      setLog((l) => [{ t: new Date().toLocaleTimeString("en-GB"), msg: `Speech captured: “${r.english}”` }, ...l]);
    };
  }, []);

  const start = () => { logged.current.clear(); setLog([]); setTick(0); setRunning(true); triggerSos(); };
  const reset = () => { setRunning(false); standDown(); setTick(0); setLog([]); setTranscript(null); logged.current.clear(); };
  const overall = Math.round(AGENTS.reduce((s, _, i) => s + progress(i), 0) / AGENTS.length);

  const onMicResult = (r: { original: string; english: string }) => micRef.current?.(r);
  const mapBlock = <SafetyMap emergency={sos} featured={sos} />;

  return <Page>
    {sos && (
      <div className="sticky top-16 z-40 flex flex-wrap items-center justify-between gap-4 border-b-2 border-red-600 bg-red-950/90 px-6 py-4 text-red-100 shadow-2xl backdrop-blur-md">
        <div className="flex items-center gap-3">
          <span className="flex size-4 items-center justify-center rounded-full bg-red-600 animate-ping">
            <Siren className="size-3 text-white" />
          </span>
          <span className="font-mono text-sm uppercase tracking-widest font-bold text-red-300">
            🚨 EMERGENCY ALERT ACTIVE — EMERGENCY ORCHESTRATION ENGAGED
          </span>
        </div>
        <div className="flex items-center gap-3">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => triggerSos({ reason: "Emergency dispatch requested from alert banner" })}
            className="font-mono text-xs uppercase tracking-wider bg-red-600 hover:bg-red-700 text-white font-bold animate-pulse"
          >
            <Siren className="mr-2 size-4" /> Dispatch Call & Alert Guardians
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={reset}
            className="border-red-500/50 bg-red-900/50 font-mono text-xs uppercase hover:bg-red-900 text-red-200"
          >
            <RotateCcw className="mr-1 size-3.5" /> Stand Down
          </Button>
        </div>
      </div>
    )}

    <div className={`border-b transition-colors duration-500 ${sos ? "border-red-800 bg-red-950/40" : "border-border-strong bg-surface"}`}>
      <div className="mx-auto flex max-w-[1600px] flex-col justify-between gap-5 px-4 py-7 md:flex-row md:items-end md:px-8 md:py-9">
        <div>
          <p className="label-mono flex items-center gap-2">
            <span className={`size-2 rounded-full ${sos ? "bg-red-500 animate-pulse" : "bg-foreground"}`} />
            Nirbhaya / Personal safety
          </p>
          <h1 className={`mt-2 font-display text-5xl uppercase leading-none md:text-7xl transition-colors ${sos ? "text-red-500" : ""}`}>
            Safety dashboard<span className={sos ? "text-red-400" : "text-muted-foreground"}>.</span>
          </h1>
          <p className="mt-3 max-w-xl text-sm text-muted-foreground">
            {sos ? "CRITICAL ALERT: Emergency response system activated. Live sensors and location telemetry streaming to guardians." : "A live view of your safety signals, location and emergency response orchestration."}
          </p>
        </div>
        <div className={`flex items-center gap-3 self-start border px-4 py-3 font-mono text-xs uppercase md:self-auto transition-all ${sos ? "border-red-600 bg-red-900/60 text-red-200 shadow-lg shadow-red-950/50 animate-pulse" : "border-border"}`}>
          <span className={`size-2 ${sos ? "animate-ping bg-red-500" : "bg-muted-foreground"}`} />
          {sos ? `EMERGENCY ACTIVE — PROGRESS ${overall}%` : "Monitoring active"}
        </div>
      </div>
      <div className="h-1 bg-muted"><div className={`h-full transition-all duration-300 ${sos ? "bg-red-600" : "bg-foreground"}`} style={{ width: `${sos ? overall : 0}%` }} /></div>
    </div>

    {sos && <Section title="Emergency location" note="Choose a known safe destination">
      {mapBlock}
    </Section>}

    <Section title="Your safety status" note={sos ? "SOS simulation active" : "Sensor preview"}>
      {sos ? (
        <div className="grid gap-4">
          <RiskCard sos={sos} onToggle={reset} />
          <VitalsGrid jitter={jitter} sos={sos} wide />
          <EcgMonitor />
          <LiveMic active={sos} onFinal={onMicResult} />
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)_300px]">
          <RiskCard sos={sos} onToggle={start} />
          <EcgMonitor />
          <VitalsGrid jitter={jitter} sos={sos} />
        </div>
      )}
    </Section>

    {!sos && <Section title="Location map" note="Always available">
      {mapBlock}
    </Section>}

    <Section title="Trigger mechanisms" note="Configurable thresholds">
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr_1fr_1.2fr]">
        {TRIGGERS.map((t, i) => <Reveal key={t.id} delay={i * 80}><button onClick={() => setTrigger(t.id)} className={`h-full w-full border p-5 text-left transition-all hover:-translate-y-1 ${trigger === t.id ? "border-foreground bg-foreground text-background" : "border-border bg-surface"}`}><t.icon className="size-5" /><p className="mt-4 font-display text-2xl uppercase">{t.label}</p><p className="mt-2 text-xs opacity-70">{t.detail}</p></button></Reveal>)}
        <Reveal delay={240}><div className="h-full border border-border bg-surface p-5"><div className="flex items-center justify-between"><p className="label-mono">Live heart rate</p><Tag inverse={bpm > threshold}>{bpm > threshold ? "ABOVE" : "NORMAL"}</Tag></div><p className="mt-3 font-mono text-5xl tabular-nums">{bpm}<span className="text-sm text-muted-foreground"> BPM</span></p><label htmlFor="thr" className="label-mono mt-4 block">Threshold {threshold} BPM</label><input id="thr" type="range" min={90} max={180} value={threshold} onChange={(e) => setThreshold(+e.target.value)} className="mt-2 w-full accent-foreground" /></div></Reveal>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="border border-border bg-surface p-5"><p className="label-mono">What the microphone hears</p><div className="mt-3 flex flex-wrap gap-2">{SCRIPTS.map((s) => <button key={s} onClick={() => setScript(s)} className={`border px-3 py-1.5 text-xs transition-colors ${script === s ? "border-foreground bg-foreground text-background" : "border-border hover:bg-muted"}`}>{s.slice(0, 34)}…</button>)}</div><input value={script} onChange={(e) => setScript(e.target.value)} aria-label="Custom phrase" className="mt-3 h-11 w-full border border-input bg-background px-3 text-sm" /></div>
        <div className="flex flex-col gap-2 md:w-60"><Button onClick={start} className="h-full min-h-14 font-mono uppercase"><Zap />Run SOS</Button><Button variant="outline" onClick={reset}><RotateCcw />Reset</Button></div>
      </div>
    </Section>

    <Section title="Active agents" note={sos ? "Orchestrator running" : "Idle"}>
      <div className="grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
        <div className="border border-border bg-surface">
          {AGENTS.map((a, i) => { const p = progress(i); const st = p === 100 ? "Completed" : p > 0 ? "Working" : "Waiting"; return <div key={a} className="grid grid-cols-[12px_minmax(0,1fr)_56px] items-center gap-4 border-b border-border p-4 last:border-0"><span className={`size-2 ${p === 100 ? "bg-foreground" : p > 0 ? "animate-pulse bg-foreground" : "bg-muted"}`} /><div><div className="flex justify-between text-sm"><span>{a} agent</span><span className="font-mono text-[10px] uppercase text-muted-foreground">{st}</span></div><div className="mt-2 h-1.5 bg-muted"><div className="h-full bg-foreground transition-all duration-200" style={{ width: `${p}%` }} /></div></div><span className="text-right font-mono text-xs tabular-nums">{p}%</span></div>; })}
        </div>
        <div className="flex flex-col gap-4">
          <div className="border border-border bg-surface p-5"><div className="flex items-center gap-2"><Mic className={`size-4 ${sos && tick > 20 && tick < 50 ? "animate-pulse" : ""}`} /><p className="label-mono">Live transcript</p>{transcript && <Tag inverse>MIC</Tag>}</div><div className="mt-3 flex h-10 items-end gap-0.5">{Array.from({ length: 40 }).map((_, i) => <span key={i} className="flex-1 bg-foreground transition-all" style={{ height: sos && tick > 20 && tick < 50 ? `${20 + Math.abs(Math.sin(tick * 0.7 + i)) * 80}%` : "8%" }} />)}</div><p className="mt-3 min-h-12 font-mono text-sm">{transcript ? highlight(transcript.english, analysis.hits) : tick > 30 ? highlight(typed, analysis.hits) : <span className="text-muted-foreground">Waiting for audio…</span>}</p>{transcript && transcript.original !== transcript.english && <p className="mt-2 border-t border-border pt-2 font-mono text-xs text-muted-foreground">Heard: {transcript.original}</p>}</div>
          <div className="border border-border bg-surface p-5"><p className="label-mono">Emergency confidence engine</p><p className="mt-2 font-mono text-5xl tabular-nums">{tick >= 55 ? analysis.confidence : 0}%</p><div className="mt-3 h-2 bg-muted"><div className="h-full bg-foreground transition-all duration-700" style={{ width: `${tick >= 55 ? analysis.confidence : 0}%` }} /></div><div className="mt-4 flex flex-wrap gap-2"><Tag inverse>{tick >= 65 ? analysis.category : "Classifying…"}</Tag>{tick >= 65 && analysis.services.map((s) => <Tag key={s}>{s}</Tag>)}</div><p className="mt-3 text-xs text-muted-foreground">{analysis.reason}</p></div>
        </div>
      </div>
    </Section>

    <Section title="Response dispatch" note="Guardian, police, hospital, fire">
      <div className="grid gap-4 md:grid-cols-4">
        {[{ k: "Guardians", icon: Users, on: tick >= 65 && analysis.category !== "No emergency" }, { k: "Police", icon: ShieldAlert, on: tick >= 78 && analysis.services.includes("Police") }, { k: "Hospital", icon: Hospital, on: tick >= 78 && analysis.services.includes("Hospital") }, { k: "Fire services", icon: Flame, on: tick >= 78 && analysis.services.includes("Fire") }].map((d) => <div key={d.k} className={`border p-5 transition-all duration-500 ${d.on ? "border-foreground bg-foreground text-background" : "border-border bg-surface opacity-60"}`}><d.icon className={`size-5 ${d.on ? "animate-pulse" : ""}`} /><p className="mt-4 font-display text-2xl uppercase">{d.k}</p><p className="mt-1 font-mono text-[10px] uppercase">{d.on ? "Alert prepared (demo)" : "Standby"}</p></div>)}
      </div>
    </Section>

    <Section title="Audit trail" note="Every action, timestamped">
      <div className="border border-border bg-surface p-5">{log.length ? log.map((l, i) => <div key={i} className="page-enter flex gap-4 border-b border-border py-2 font-mono text-xs last:border-0"><span className="text-muted-foreground">{l.t}</span><Activity className="size-3 shrink-0" /><span>{l.msg}</span></div>) : <p className="text-sm text-muted-foreground"><Siren className="mr-2 inline size-4" />Run an SOS to populate the audit trail.</p>}</div>
    </Section>
  <ChatWidget /></Page>;
}

function RiskCard({ sos, onToggle }: { sos: boolean; onToggle: () => void }) {
  return (
    <div className="flex flex-col justify-between border border-border bg-surface p-6">
      <div>
        <p className="label-mono">Combined risk / Demo</p>
        <p className="mt-5 font-mono text-7xl tabular-nums">
          {sos ? "100" : risk}
          <span className="text-2xl text-muted-foreground">/100</span>
        </p>
        <div className="mt-5 h-1.5 bg-muted">
          <div
            className="h-full bg-foreground transition-all duration-700"
            style={{ width: `${sos ? 100 : risk}%` }}
          />
        </div>
        <div className="mt-5">
          <Tag inverse={sos}>{sos ? "EMERGENCY PREVIEW" : "IDLE"}</Tag>
        </div>
      </div>
      <div className="mt-8">
        <Button onClick={onToggle} className="h-14 w-full font-mono text-sm uppercase">
          <Zap />
          {sos ? "End SOS preview" : "Trigger SOS preview"}
        </Button>
        <p className="mt-3 text-xs text-muted-foreground">
          No contacts or emergency services are notified.
        </p>
      </div>
    </div>
  );
}

function VitalsGrid({
  jitter,
  sos,
  wide = false,
}: {
  jitter: number[];
  sos: boolean;
  wide?: boolean;
}) {
  return (
    <div
      className={`grid grid-cols-2 gap-px border border-border bg-border ${
        wide ? "sm:grid-cols-3" : "xl:grid-cols-1"
      }`}
    >
      {vitals.slice(1).map((v, vi) => {
        const base = parseFloat(v.value) * (1 + (jitter[vi] ?? 0) * 0.12 + (sos ? 0.4 : 0));
        const val = base.toFixed(v.value.includes(".") ? 1 : 0);
        const lvl = Math.min(100, v.level * (1 + (jitter[vi] ?? 0) * 0.3 + (sos ? 0.6 : 0)));
        return (
          <div key={v.label} className="bg-surface p-5">
            <p className="label-mono">{v.label} / Demo</p>
            <p className="mt-3 font-mono text-3xl tabular-nums">
              {val}
              <span className="ml-1 text-xs text-muted-foreground">{v.unit}</span>
            </p>
            <div className="mt-3 h-1 bg-muted">
              <div
                className="h-full bg-foreground transition-all duration-1000"
                style={{ width: `${lvl}%` }}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function highlight(text: string, hits: string[]) {
  if (!hits.length) return text;
  const re = new RegExp(`(${hits.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
  return text.split(re).map((part, i) => hits.some((h) => h.toLowerCase() === part.toLowerCase()) ? <mark key={i} className="bg-foreground px-0.5 text-background">{part}</mark> : part);
}
