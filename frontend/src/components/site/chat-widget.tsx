import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MessageCircle, Mic, MicOff, Minimize2, Send } from "lucide-react";
import { askSafetyAssistant } from "@/lib/safety-chat";
import { FormattedMessage } from "./formatted-message";

type Msg = { role: "user" | "assistant"; content: string };

function Cube({ w, h, d, className, face }: { w: number; h: number; d: number; className: string; face?: ReactNode }) {
  const f = "absolute left-1/2 top-1/2 border border-foreground";
  const s = (W: number, H: number, t: string) => ({ width: W, height: H, marginLeft: -W / 2, marginTop: -H / 2, transform: t });
  return (
    <div className="mascot3d-part absolute left-1/2 top-1/2" style={{ width: 0, height: 0 }}>
      <div className={`${f} ${className} grid place-items-center`} style={s(w, h, `translateZ(${d / 2}px)`)}>{face}</div>
      <div className={`${f} ${className} brightness-75`} style={s(w, h, `rotateY(180deg) translateZ(${d / 2}px)`)} />
      <div className={`${f} ${className} brightness-90`} style={s(d, h, `rotateY(90deg) translateZ(${w / 2}px)`)} />
      <div className={`${f} ${className} brightness-90`} style={s(d, h, `rotateY(-90deg) translateZ(${w / 2}px)`)} />
      <div className={`${f} ${className} brightness-110`} style={s(w, d, `rotateX(90deg) translateZ(${h / 2}px)`)} />
      <div className={`${f} ${className} brightness-50`} style={s(w, d, `rotateX(-90deg) translateZ(${h / 2}px)`)} />
    </div>
  );
}

export function MascotFigure() {
  return (
    <div className="relative h-14 w-12" style={{ perspective: 300 }}>
      <div className="mascot3d-facing absolute inset-0" style={{ transformStyle: "preserve-3d" }}>
        {/* antenna */}
        <div className="absolute left-1/2 top-0" style={{ transformStyle: "preserve-3d", transform: "translate3d(0,4px,0)" }}>
          <Cube w={6} h={6} d={6} className="bg-mascot-leg animate-pulse" />
        </div>
        <div className="absolute left-1/2 top-0" style={{ transformStyle: "preserve-3d", transform: "translate3d(0,10px,0)" }}>
          <Cube w={2} h={8} d={2} className="bg-foreground" />
        </div>
        {/* head/body */}
        <div className="absolute left-1/2 top-0" style={{ transformStyle: "preserve-3d", transform: "translate3d(0,28px,0)" }}>
          <Cube w={38} h={30} d={26} className="bg-mascot-body" face={
            <div className="flex flex-col items-center gap-1.5">
              <div className="flex gap-2"><span className="mascot-blink size-1.5 bg-foreground" /><span className="mascot-blink size-1.5 bg-foreground" /></div>
              <span className="h-0.5 w-2 translate-x-1 bg-foreground" />
            </div>
          } />
        </div>
        {/* legs */}
        <div className="absolute left-1/2 top-0" style={{ transformStyle: "preserve-3d", transform: "translate3d(-8px,48px,0)" }}>
          <div className="mascot-leg-a" style={{ transformStyle: "preserve-3d" }}><Cube w={9} h={9} d={9} className="bg-mascot-leg" /></div>
        </div>
        <div className="absolute left-1/2 top-0" style={{ transformStyle: "preserve-3d", transform: "translate3d(8px,48px,0)" }}>
          <div className="mascot-leg-b" style={{ transformStyle: "preserve-3d" }}><Cube w={9} h={9} d={9} className="bg-mascot-leg" /></div>
        </div>
      </div>
    </div>
  );
}

function Mascot() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-14 h-14">
      <div className="mascot-walk absolute bottom-0">
        <div className="mascot-hop">
          <div className="mascot-face"><MascotFigure /></div>
        </div>
      </div>
    </div>
  );
}

export function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([{ role: "assistant", content: "Hi, I'm the Nirbhaya assistant. How can I help you stay safe?" }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, busy]);
  useEffect(() => { if (open) inputRef.current?.focus(); }, [open, busy]);

  const [listening, setListening] = useState(false);
  const recRef = useRef<{ stop: () => void } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [voiceOk, setVoiceOk] = useState(false);
  useEffect(() => {
    setVoiceOk(
      typeof navigator !== "undefined" &&
        !!navigator.mediaDevices?.getUserMedia &&
        typeof MediaRecorder !== "undefined",
    );
  }, []);

  async function toggleVoice() {
    if (listening) { recRef.current?.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setListening(false);
      return;
    }
    streamRef.current = stream;
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream);
    rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => {
      setListening(false);
      recRef.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size < 1200) return;
      void (async () => {
        try {
          const form = new FormData();
          form.append("audio", blob, "clip.webm");
          const r = await fetch("/api/transcribe", { method: "POST", body: form });
          if (!r.ok) return;
          const json = (await r.json()) as { original?: string };
          const text = (json.original || "").trim();
          if (text) { setInput(text); void submit(text, true); }
        } catch {
          // Transcription unavailable; nothing sensible to show in the input.
        }
      })();
    };
    rec.onerror = () => setListening(false);
    recRef.current = rec; setListening(true); rec.start();
  }

  function speak(text: string) {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    await submit(input, false);
  }

  async function submit(raw: string, fromVoice: boolean) {
    const text = raw.trim();
    if (!text || busy) return;
    const next = [...messages, { role: "user" as const, content: text }];
    setMessages(next); setInput(""); setBusy(true);
    try {
      const answer = await askSafetyAssistant({ messages: next.slice(1), context: "Dashboard chat widget" });
      setMessages((m) => [...m, { role: "assistant", content: answer }]);
      if (fromVoice) speak(answer);
    } catch (err) {
      setMessages((m) => [...m, { role: "assistant", content: err instanceof Error ? err.message : "Assistant unavailable right now." }]);
    } finally { setBusy(false); }
  }

  if (!mounted) return null;
  return createPortal(
    <div className="fixed bottom-5 right-5 z-[60]">
      <div className={`relative flex flex-col border-2 border-border-strong bg-background shadow-2xl transition-all duration-300 ease-out ${open ? "h-[min(600px,80vh)] w-[min(420px,calc(100vw-2.5rem))]" : "h-14 w-56"}`}>
        <Mascot />
        {!open ? (
          <button onClick={() => setOpen(true)} className="flex h-full w-full items-center gap-3 px-4 font-mono text-[11px] uppercase hover:bg-foreground hover:text-background" aria-label="Open chat">
            <MessageCircle className="size-4" /> Ask Nirbhaya
          </button>
        ) : (
          <>
            <div className="flex items-center justify-between border-b border-border-strong bg-foreground px-4 py-3 text-background">
              <span className="font-display text-xl uppercase leading-none">Nirbhaya Assistant</span>
              <button onClick={() => setOpen(false)} aria-label="Minimize chat"><Minimize2 className="size-4" /></button>
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.map((m, i) => (
                <div key={i} className={`max-w-[88%] rounded-sm p-3 text-sm leading-relaxed ${m.role === "user" ? "ml-auto bg-foreground text-background" : "bg-muted/40 border border-border text-foreground"}`}>
                  <FormattedMessage content={m.content} />
                </div>
              ))}
              {busy && <div className="flex gap-1"><span className="size-1.5 animate-bounce bg-foreground" /><span className="size-1.5 animate-bounce bg-foreground [animation-delay:.15s]" /><span className="size-1.5 animate-bounce bg-foreground [animation-delay:.3s]" /></div>}
              <div ref={endRef} />
            </div>
            <form onSubmit={send} className="flex border-t border-border-strong">
              {voiceOk && <button type="button" onClick={toggleVoice} className={`grid w-12 place-items-center border-r border-border-strong ${listening ? "animate-pulse bg-foreground text-background" : ""}`} aria-label={listening ? "Stop listening" : "Speak your message"}>{listening ? <MicOff className="size-4" /> : <Mic className="size-4" />}</button>}
              <input ref={inputRef} value={input} onChange={(e) => setInput(e.target.value)} placeholder={listening ? "Listening…" : "Type or tap the mic…"} className="flex-1 bg-transparent px-4 py-3 text-sm outline-none" />
              <button type="submit" disabled={busy || !input.trim()} className="grid w-12 place-items-center border-l border-border-strong disabled:opacity-40" aria-label="Send"><Send className="size-4" /></button>
            </form>
          </>
        )}
      </div>
    </div>
  , document.body);
}
