import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Activity, ArrowRight, Check, ChevronRight, Circle, Command, HeartPulse, MapPin, Mic, Radio, Send, ShieldAlert, WifiOff, X } from "lucide-react";
import { MascotFigure } from "@/components/site/chat-widget";
import { Page, Tag } from "@/components/site/shell";
import { Button } from "@/components/ui/button";
import { askSafetyAssistant } from "@/lib/safety-chat.functions";
import { destinationFor, flows, identifyIntent, labelFor, type Intent } from "@/lib/chat-demo";

export const Route = createFileRoute("/assistant")({
  head: () => ({ meta: [{ title: "Safety Assistant — Nirbhaya" }, { name: "description", content: "An AI-powered conversation interface for the Nirbhaya safety preview. No emergency actions are performed." }] }),
  component: Assistant,
});

type Message = { id: string; role: "user" | "assistant"; text: string; time: string; intent?: Intent; preview?: boolean };
type Event = { id: string; text: string; time: string };
const stamp = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const uid = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const greeting: Message = { id: "welcome", role: "assistant", text: "I'm your Nirbhaya assistant. Ask about a route, your guardians, a ride, or your safety status. This is a preview: no live sensors, bookings, or emergency dispatch are connected.", time: "SYSTEM", preview: true };
const suggestions = ["Show my safety status", "Find a safer route", "Plan a safe ride", "Who are my guardians?"];

function Assistant() {
  const [messages, setMessages] = useState<Message[]>([greeting]);
  const [events, setEvents] = useState<Event[]>([]);
  const [input, setInput] = useState("");
  const [intent, setIntent] = useState<Intent>("general");
  const [step, setStep] = useState(-1);
  const [loading, setLoading] = useState(false);
  const [incident, setIncident] = useState(false);
  const [listening, setListening] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const contextRef = useRef<Intent>("general");
  const busyRef = useRef(false);
  const recognitionRef = useRef<{ stop: () => void } | null>(null);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" }); }, [messages, step]);
  useEffect(() => {
    if (!loading) return;
    const timer = window.setInterval(() => setStep(s => Math.min(s + 1, flows[contextRef.current].length - 1)), 850);
    return () => window.clearInterval(timer);
  }, [loading]);
  useEffect(() => () => recognitionRef.current?.stop(), []);

  const log = (text: string) => setEvents(current => [{ id: uid(), text, time: stamp() }, ...current].slice(0, 12));

  const send = async (raw: string, eventType?: string) => {
    const text = raw.trim();
    if (!text || busyRef.current) return;
    busyRef.current = true;
    const nextIntent = identifyIntent(text, contextRef.current);
    contextRef.current = nextIntent;
    setIntent(nextIntent); setStep(0); setLoading(true); setInput(""); setVoiceError("");
    const userMessage: Message = { id: uid(), role: "user", text, time: stamp() };
    setMessages(current => [...current, userMessage]);
    log(eventType ? `${eventType} / Demo event received` : `${nextIntent.toUpperCase()} intent detected`);
    if (nextIntent === "emergency") { setIncident(true); log("SOS preview created / No alerts sent"); }
    const prior = messages.filter(m => m.id !== "welcome").slice(-10).map(m => ({ role: m.role, content: m.text }));
    try {
      const answer = await askSafetyAssistant({ data: {
        messages: [...prior, { role: "user", content: text }],
        context: `Current intent: ${nextIntent}. SOS preview: ${nextIntent === "emergency" || incident}. This is a frontend simulation; no real agents or tools execute.`,
      } });
      setMessages(current => [...current, { id: uid(), role: "assistant", text: answer, time: stamp(), intent: nextIntent }]);
      log(`${flows[nextIntent].at(-1)?.name || "Assistant"} / Preview complete`);
    } catch {
      const fallback = nextIntent === "emergency"
        ? "If you are in immediate danger, call your local emergency number now and move to a safer place if you can. This preview has not sent an alert. You can explore the SOS workflow on the dashboard."
        : "I can't connect to the AI service right now. You can still explore this workflow using the button below. No live actions were taken.";
      setMessages(current => [...current, { id: uid(), role: "assistant", text: fallback, time: stamp(), intent: nextIntent, preview: true }]);
      log("AI connection unavailable / Showing fallback guidance");
    } finally { setStep(flows[nextIntent].length); setLoading(false); busyRef.current = false; }
  };

  const startVoice = async () => {
    if (listening) { recognitionRef.current?.stop(); setListening(false); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setVoiceError("Voice input isn't available in this browser. Please type your message."); return; }
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { setVoiceError("Microphone unavailable or permission denied. You can type instead."); setListening(false); return; }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => {
      setListening(false);
      recognitionRef.current = null;
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size < 1200) { setVoiceError("No speech captured. Hold the mic and speak, then stop."); return; }
      void (async () => {
        try {
          const form = new FormData();
          form.append("audio", blob, "clip.webm");
          const r = await fetch("/api/transcribe", { method: "POST", body: form });
          if (!r.ok) { setVoiceError("Transcription service unavailable. You can type instead."); return; }
          const json = (await r.json()) as { original?: string };
          const transcript = (json.original || "").trim();
          if (transcript) { setInput(transcript); setVoiceError("Voice transcribed. Review and press send to continue."); }
          else setVoiceError("No speech detected. Try again.");
        } catch { setVoiceError("Transcription service unreachable. You can type instead."); }
      })();
    };
    rec.onerror = () => { setVoiceError("Microphone unavailable or permission denied. You can type instead."); setListening(false); };
    recognitionRef.current = rec;
    try { rec.start(); setListening(true); setVoiceError(""); } catch { setVoiceError("Could not start voice input."); stream.getTracks().forEach((t) => t.stop()); }
  };

  const submit = (e: FormEvent) => { e.preventDefault(); void send(input); };
  const currentFlow = flows[intent];
  return <Page>
    <div className="assistant-hero border-b border-border-strong bg-foreground text-background">
      <div className="mx-auto grid max-w-[1600px] gap-8 px-4 py-10 md:px-8 lg:grid-cols-[1fr_auto] lg:items-end lg:py-12">
        <div><p className="font-mono text-[10px] uppercase tracking-[.25em] text-white/60">Nirbhaya — Conversation control center</p><h1 className="mt-4 font-display text-6xl uppercase leading-[.85] tracking-tight md:text-8xl">Ask. Act.<br /><span className="text-white/45">Stay aware.</span></h1><p className="mt-6 max-w-xl text-sm leading-relaxed text-white/65">One place to explore safety, travel, guardians and rides. The assistant understands your request; workflow activity is a visualization, not real agent execution.</p></div>
        <div className="flex items-center gap-3 border border-white/25 px-4 py-3 font-mono text-[10px] uppercase tracking-widest"><span className="pulse-ring size-2 bg-white" />AI conversation / Demo workflows</div>
      </div>
    </div>
    <div className="mx-auto max-w-[1600px] px-4 py-6 md:px-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><Command className="size-4" /><span className="label-mono !text-foreground">Assistant workspace</span><Tag>PREVIEW</Tag></div><span className="label-mono">No alerts sent · No bookings placed · No live monitoring</span></div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,.75fr)]">
        <div className="flex min-h-[660px] flex-col border border-border-strong bg-surface">
          <div className="flex items-center justify-between border-b border-border p-4 md:px-6"><div className="flex items-center gap-3"><span className="grid h-12 w-11 place-items-center pt-1"><MascotFigure /></span><div><p className="font-display text-xl uppercase leading-none">Nirbhaya AI</p><p className="mt-1 label-mono">Conversation / Context aware</p></div></div><span className="flex items-center gap-2 font-mono text-[10px] uppercase"><span className="size-1.5 bg-foreground" /> {loading ? "Thinking" : "Ready"}</span></div>
          {incident && <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border-strong bg-foreground p-4 text-background md:px-6"><div className="flex items-center gap-3"><ShieldAlert className="size-5 animate-pulse" /><div><p className="font-display text-xl uppercase leading-none">SOS preview mode</p><p className="mt-1 text-xs text-white/70">No alerts were sent. In real danger, call local emergency services.</p></div></div><button type="button" onClick={() => { setIncident(false); log("SOS preview closed"); }} aria-label="Close SOS preview" className="border border-white/40 p-2 hover:bg-white hover:text-black"><X className="size-4" /></button></div>}
          <div ref={scrollRef} aria-live="polite" className="assistant-scroll flex-1 space-y-5 overflow-y-auto p-4 md:p-6" style={{ maxHeight: 560 }}>
            <div className="flex items-center gap-3 label-mono"><span className="h-px flex-1 bg-border" />Session started / Today<span className="h-px flex-1 bg-border" /></div>
            {messages.map((m) => <div key={m.id} className={`chat-message flex ${m.role === "user" ? "justify-end" : "justify-start"}`}><div className={`max-w-[90%] border p-4 md:max-w-[78%] ${m.role === "user" ? "border-foreground bg-foreground text-background" : "border-border bg-surface-2"}`}><div className="mb-3 flex items-center justify-between gap-6 font-mono text-[9px] uppercase tracking-widest opacity-60"><span>{m.role === "user" ? "You" : "Nirbhaya / Assistant"}</span><span>{m.time}</span></div><p className="whitespace-pre-wrap text-sm leading-relaxed">{m.text}</p>{m.role === "assistant" && m.intent && destinationFor[m.intent] && <Link to={destinationFor[m.intent] as "/"} className="mt-4 inline-flex items-center gap-2 border-b border-current pb-1 font-mono text-[10px] uppercase tracking-widest hover:opacity-60">{labelFor[m.intent]} <ArrowRight className="size-3" /></Link>}{m.preview && m.id !== "welcome" && <p className="mt-3 font-mono text-[9px] uppercase opacity-60">Fallback response / Not AI generated</p>}</div></div>)}
            {loading && <div className="chat-message max-w-[85%] border border-border bg-surface-2 p-4"><p className="label-mono !text-foreground">Orchestrating preview</p><p className="mt-2 text-sm text-muted-foreground">{currentFlow[Math.min(step, currentFlow.length - 1)]?.detail}</p><div className="mt-3 h-1 bg-border"><div className="h-full bg-foreground transition-all duration-700" style={{ width: `${Math.round(((step + 1) / currentFlow.length) * 100)}%` }} /></div></div>}
          </div>
          <div className="border-t border-border p-4 md:p-6"><div className="mb-4 flex flex-wrap gap-2">{suggestions.map(s => <button key={s} type="button" disabled={loading} onClick={() => void send(s)} className="border border-border bg-background px-3 py-2 text-left font-mono text-[10px] uppercase tracking-wide transition-colors hover:border-foreground hover:bg-foreground hover:text-background disabled:opacity-50">{s} <ChevronRight className="ml-1 inline size-3" /></button>)}</div><form onSubmit={submit} className="flex items-end gap-2"><label htmlFor="assistant-input" className="sr-only">Message Nirbhaya assistant</label><textarea id="assistant-input" rows={2} maxLength={1200} value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (!loading) void send(input); } }} placeholder="Ask about your safety, routes, guardians or rides..." className="min-h-14 flex-1 resize-none border border-input bg-background px-4 py-3 text-sm outline-none focus:border-foreground" /><button type="button" onClick={startVoice} title="Dictate a message" aria-label={listening ? "Stop voice input" : "Start voice input"} className={`grid size-14 shrink-0 place-items-center border border-foreground transition-colors ${listening ? "bg-foreground text-background" : "hover:bg-foreground hover:text-background"}`}><Mic className={`size-5 ${listening ? "animate-pulse" : ""}`} /></button><Button type="submit" disabled={!input.trim() || loading} className="h-14 px-5"><Send className="size-4" /><span className="sr-only">Send message</span></Button></form>{voiceError && <p role="status" className="mt-2 text-xs text-muted-foreground">{voiceError}</p>}<p className="mt-3 font-mono text-[9px] uppercase tracking-wide text-muted-foreground">Voice input stays in your browser until you review and send · AI replies may be inaccurate</p></div>
        </div>
        <aside className="space-y-4">
          <div className="border border-border-strong bg-surface"><div className="flex items-center justify-between border-b border-border p-5"><div className="flex items-center gap-2"><Radio className="size-4" /><h2 className="font-display text-2xl uppercase">Agent activity</h2></div><Tag>SIMULATED</Tag></div><div className="p-5"><p className="mb-5 text-xs leading-relaxed text-muted-foreground">A visual explanation of what connected agents could do. These steps do not run external tools.</p><div className="space-y-5">{currentFlow.map((agent, i) => { const done = step > i, active = loading && step === i, percent = done ? 100 : active ? 64 : 0; return <div key={`${intent}-${agent.name}`}><div className="flex items-center gap-3"><span className={`grid size-7 shrink-0 place-items-center border ${done || active ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground"}`}>{done ? <Check className="size-3.5" /> : active ? <span className="size-1.5 animate-pulse bg-background" /> : <Circle className="size-2.5" />}</span><div className="min-w-0 flex-1"><div className="flex justify-between gap-2"><p className="text-sm font-semibold">{agent.name}</p><span className="font-mono text-[10px]">{percent}%</span></div><p className="mt-1 text-xs text-muted-foreground">{agent.detail}</p></div></div><div className="ml-10 mt-2 h-1 bg-muted"><div className="h-full bg-foreground transition-all duration-700" style={{ width: `${percent}%` }} /></div></div>; })}</div></div></div>
          <div className="border border-border bg-surface p-5"><div className="flex items-center gap-2"><Activity className="size-4" /><h2 className="font-display text-2xl uppercase">Incident timeline</h2></div><p className="mt-2 text-xs text-muted-foreground">Session events only. No incident record or guardian notification is created.</p><div className="mt-5 border-l border-border pl-4">{events.length ? events.map(ev => <div key={ev.id} className="relative border-b border-border pb-4 pt-1 last:border-b-0"><span className="absolute -left-[21px] top-2 size-2 bg-foreground" /><p className="font-mono text-[9px] text-muted-foreground">{ev.time}</p><p className="mt-1 text-xs">{ev.text}</p></div>) : <p className="text-xs text-muted-foreground">Start a conversation to see activity.</p>}</div></div>
          <div className="border border-border-strong bg-surface-2 p-5"><p className="label-mono !text-foreground">Test event triggers</p><p className="mt-2 text-xs text-muted-foreground">Manually fire simulated sensor events. Your device is not being monitored.</p><div className="mt-4 grid gap-2 sm:grid-cols-3 xl:grid-cols-1"><button disabled={loading} onClick={() => void send("Heart rate alert: show me what to do", "Heart rate")} className="flex items-center gap-3 border border-border bg-surface p-3 text-left text-xs transition-colors hover:border-foreground disabled:opacity-50"><HeartPulse className="size-4" /> Heart-rate spike <ArrowRight className="ml-auto size-3" /></button><button disabled={loading} onClick={() => void send("Shake alert: I may need help", "Motion")} className="flex items-center gap-3 border border-border bg-surface p-3 text-left text-xs transition-colors hover:border-foreground disabled:opacity-50"><Activity className="size-4" /> Motion trigger <ArrowRight className="ml-auto size-3" /></button><button disabled={loading} onClick={() => void send("Device offline alert: show my safety options", "Offline")} className="flex items-center gap-3 border border-border bg-surface p-3 text-left text-xs transition-colors hover:border-foreground disabled:opacity-50"><WifiOff className="size-4" /> Offline warning <ArrowRight className="ml-auto size-3" /></button></div></div>
          <div className="border border-border bg-foreground p-5 text-background"><MapPin className="size-5" /><h2 className="mt-4 font-display text-2xl uppercase">Need real help now?</h2><p className="mt-2 text-sm text-white/70">This experience cannot dispatch help. Contact local emergency services directly if you are in danger.</p></div>
        </aside>
      </div>
    </div>
  </Page>;
}