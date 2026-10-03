"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Cloud, Languages, Mic, MicOff, Radio } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tag } from "@/components/site/shell";
import {
  DAILY_CAP_SECS,
  addAudioSecs,
  appendCapped,
  formatRemaining,
  isQuotaExhausted,
  isQuotaWarning,
  remainingAudioSecs,
} from "@/lib/quota";

// ---------------------------------------------------------------- types ----
// Browser-fallback types. SpeechRecognition is non-standard and absent from the
// DOM lib, so it is declared by hand (the assistant screen casts the same way).

type SpeechAlternative = { transcript: string };
type SpeechResult = { isFinal: boolean; length: number; 0: SpeechAlternative };
type SpeechEvent = { resultIndex: number; results: ArrayLike<SpeechResult> };
type SpeechErrorEvent = { error: string };
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: SpeechEvent) => null | void) | null;
  onerror: ((e: SpeechErrorEvent) => null | void) | null;
  onend: (() => null | void) | null;
  onstart: (() => null | void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type RecognitionCtor = new () => Recognition;

function getCtor(): RecognitionCtor | undefined {
  if (typeof window === "undefined") return undefined;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition;
}

// 2s chunking ensures instant transcript response
const SEG_MS = 2_000;
// Sub-second clips come back empty and waste quota, so drop them silently.
const MIN_BLOB = 1200;
// WebM container-header sizes, measured against real Chrome MediaRecorder output.
const HEADER_BYTES = 2048;
const RETRY_HEADER_BYTES = 8192;
// One upload at a time; if the service falls behind, drop the backlog rather
// than stacking requests until Groq rate-limits us.
const MAX_QUEUE = 6;
// Transient per-clip failures are silent. Only a sustained run is worth telling
// the user about, which is what stopped the panel jumping on every clip.
const FAIL_STREAK_LIMIT = 3;

type Engine = "groq" | "browser";
type Job = { payload: Blob; raw: Uint8Array<ArrayBuffer>; secs: number };

function pickMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]) {
    try {
      if (MediaRecorder.isTypeSupported(t)) return t;
    } catch {
      // Older engines throw instead of returning false; keep looking.
    }
  }
  return undefined;
}

const LANGS = [
  { code: "auto", label: "Auto detect", iso: "auto" },
  { code: "en-IN", label: "English (India)", iso: "en" },
  { code: "hi-IN", label: "हिन्दी Hindi", iso: "hi" },
  { code: "bn-IN", label: "বাংলা Bengali", iso: "bn" },
  { code: "te-IN", label: "తెలుగు Telugu", iso: "te" },
  { code: "ta-IN", label: "தமிழ் Tamil", iso: "ta" },
  { code: "mr-IN", label: "मराठी Marathi", iso: "mr" },
  { code: "kn-IN", label: "ಕನ್ನಡ Kannada", iso: "kn" },
  { code: "gu-IN", label: "ગુજરાતી Gujarati", iso: "gu" },
  { code: "pa-IN", label: "ਪੰਜਾਬੀ Punjabi", iso: "pa" },
  { code: "ml-IN", label: "മലയാളം Malayalam", iso: "ml" },
  { code: "or-IN", label: "ଓଡ଼ିଆ Odia", iso: "or" },
  { code: "bn-BD", label: "বাংলা (Bangladesh)", iso: "bn" },
  { code: "ur-PK", label: "اردو Urdu", iso: "ur" },
  { code: "ar-SA", label: "العربية Arabic", iso: "ar" },
  { code: "es-ES", label: "Español Spanish", iso: "es" },
  { code: "fr-FR", label: "Français French", iso: "fr" },
] as const;

const ISO_BY_CODE = new Map<string, string>(LANGS.map((l) => [l.code, l.iso]));

export type MicResult = { original: string; english: string };

// Any letter or combining mark that is not Latin, so every Indic, Arabic and
// other non-Latin script routes to translation instead of being shown raw.
const NON_LATIN = /(?!\p{Script=Latin})[\p{L}\p{M}]/u;

const ERRORS: Record<string, string> = {
  "not-allowed":
    "Microphone permission was denied. Allow mic access in your browser, then press Listen again.",
  "service-not-allowed":
    "The browser blocked the speech service. Microphone access is not permitted here.",
  "audio-capture": "No microphone was found. Connect an input device and try again.",
  network: "The browser's speech service is unreachable. Transcription needs a network connection.",
};

// The ERRORS table is a Record, so an index is `string | undefined` under
// noUncheckedIndexedAccess. Every call site wants a guaranteed string.
function errText(key: string, fallback: string): string {
  return ERRORS[key] ?? fallback;
}

export function LiveMic({
  active,
  onFinal,
}: {
  active: boolean;
  onFinal?: (r: MicResult) => void;
}) {
  // `null` until the probe answers. Starting the browser engine first and then
  // swapping to Whisper grabbed the microphone twice and made the panel jump on
  // every SOS activation, so nothing starts until we know which engine to use.
  const [engine, setEngine] = useState<Engine | null>(null);
  const [recording, setRecording] = useState(false);
  // Transcription activity, kept strictly separate from `recording` so the REC
  // badge never changes text while a clip is in flight.
  const [busy, setBusy] = useState(false);
  const [interim, setInterim] = useState("");
  const [original, setOriginal] = useState("");
  const [english, setEnglish] = useState("");
  const [detected, setDetected] = useState("");
  // Only conditions that need the user's attention land here, so the panel does
  // not resize on every dropped clip.
  const [fatal, setFatal] = useState("");
  const [lang, setLang] = useState<string>("auto");
  const [remaining, setRemaining] = useState(DAILY_CAP_SECS);
  const [mounted, setMounted] = useState(false);

  // Rolling transcript. Mirrored in a ref so the async paths can read the latest
  // value without waiting for a re-render.
  const rollRef = useRef({ original: "", english: "" });
  const onFinalRef = useRef(onFinal);
  onFinalRef.current = onFinal;

  const wantRef = useRef(false);
  const aliveRef = useRef(true);
  const langRef = useRef("auto");
  langRef.current = lang;

  // ---- browser engine ----
  const recRef = useRef<Recognition | null>(null);
  const restartRef = useRef<number | null>(null);
  const genRef = useRef(0);

  // ---- groq engine ----
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef(0);
  const lastFlushRef = useRef(0);
  const queueRef = useRef<Job[]>([]);
  const pumpingRef = useRef(false);
  const failStreakRef = useRef(0);
  // The first MediaRecorder fragment carries the WebM container header; every
  // later fragment is a bare cluster. Measured against real Chrome output:
  // 2KB of header makes a headerless fragment transcribe cleanly, while 4KB and
  // above starts bleeding the previous clip's audio into the result.
  const headerRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const barRefs = useRef<(HTMLSpanElement | null)[]>([]);

  useEffect(() => setMounted(true), []);

  // Ask the server whether a Groq key exists, so we never burn a clip to find out.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/transcribe", { method: "GET" })
      .then(() => {
        // Always capture with MediaRecorder, even if the transcription key is
        // missing: the level meter and recording must work without the browser
        // SpeechRecognition service, which needs a vendor network round-trip.
        if (!cancelled) setEngine("groq");
      })
      .catch(() => {
        if (!cancelled) setEngine("groq");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // --------------------------------------------------------- level meter ----
  // Reads real RMS from the live stream and writes bar heights straight to the
  // DOM. No React state per frame, so the meter never triggers a re-render and
  // cannot flicker the rest of the panel.
  const startMeter = useCallback((analyser: AnalyserNode) => {
    const samples = new Uint8Array(analyser.fftSize);
    const loop = (t: number) => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const v = (sample - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / samples.length);
      // High sensitivity gain so human voice drives active bar bounce
      const level = Math.min(1, rms * 14);
      const bars = barRefs.current;
      // Bars only bounce while voice is actually detected; ambient silence
      // settles them to the rest height instead of an idle wobble.
      const voiced = level > 0.06;
      for (let i = 0; i < bars.length; i++) {
        const el = bars[i];
        if (!el) continue;
        if (voiced) {
          const dynamicWave = 0.2 + 0.8 * Math.abs(Math.sin(t / 140 + i * 0.4));
          const finalHeight = Math.max(10, Math.min(100, (level * 85 + 15) * dynamicWave));
          el.style.height = `${finalHeight}%`;
        } else {
          el.style.height = "6%";
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(loop);
  }, []);

  const stopMeter = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    for (const el of barRefs.current) {
      if (el) el.style.height = "6%";
    }
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    setRemaining(remainingAudioSecs());
    return () => {
      aliveRef.current = false;
      wantRef.current = false;
      if (restartRef.current !== null) window.clearTimeout(restartRef.current);
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      recRef.current?.abort();
      recRef.current = null;
      const rec = recorderRef.current;
      if (rec && rec.state !== "inactive") {
        rec.ondataavailable = null;
        rec.onstop = null;
        try {
          rec.stop();
        } catch {
          // already stopped
        }
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      recorderRef.current = null;
      void audioCtxRef.current?.close().catch(() => {});
      audioCtxRef.current = null;
      headerRef.current = null;
    };
  }, []);

  // Shared by both engines: one place that turns a raw chunk into English so
  // threat classification always receives the same shape.
  const toEnglish = useCallback(async (text: string, from: string) => {
    try {
      const response = await fetch("/api/translate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, from }),
      });
      const json = (await response.json()) as { english?: string };
      return typeof json.english === "string" && json.english.trim() ? json.english.trim() : text;
    } catch {
      return text;
    }
  }, []);

  const pushResult = useCallback((originalChunk: string, englishChunk: string) => {
    rollRef.current.original = appendCapped(rollRef.current.original, originalChunk);
    rollRef.current.english = appendCapped(rollRef.current.english, englishChunk);
    setOriginal(rollRef.current.original);
    setEnglish(rollRef.current.english);
    onFinalRef.current?.({
      original: rollRef.current.original,
      english: rollRef.current.english,
    });
  }, []);

  // ------------------------------------------------------- groq: capture ----

  const releaseStream = useCallback(() => {
    stopMeter();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    void audioCtxRef.current?.close().catch(() => {});
    audioCtxRef.current = null;
    headerRef.current = null;
  }, [stopMeter]);

  // Hard stop: drop whatever is buffered and release the microphone. Used on
  // teardown and whenever the session is reset.
  const hardStopGroq = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.ondataavailable = null;
      rec.onstop = null;
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    }
    releaseStream();
    queueRef.current = [];
    setRecording(false);
    setBusy(false);
  }, [releaseStream]);

  const transcribeJob = useCallback(
    async (job: Job): Promise<boolean> => {
      if (!aliveRef.current) return false;

      if (isQuotaExhausted()) {
        setFatal(
          "Today's Whisper audio quota is used up. Recording has stopped so the remaining budget is not wasted.",
        );
        wantRef.current = false;
        hardStopGroq();
        return false;
      }

      const iso = ISO_BY_CODE.get(langRef.current) ?? "auto";
      const send = async (blob: Blob) => {
        const form = new FormData();
        form.append("audio", blob, "clip.webm");
        if (iso !== "auto") form.append("language", iso);
        return fetch("/api/transcribe", { method: "POST", body: form });
      };

      let response: Response;
      try {
        response = await send(job.payload);
      } catch {
        failStreakRef.current += 1;
        if (failStreakRef.current >= FAIL_STREAK_LIMIT) {
          setFatal("Transcription service is unreachable. Still recording; it will retry.");
        }
        return false;
      }

      if (response.status === 503) {
        // Keep recording with MediaRecorder; do not fall back to the browser
        // SpeechRecognition service, which is unreachable in offline builds.
        setFatal("Transcription key is not configured on the server, so speech is not being transcribed. Recording and level meter still work.");
        failStreakRef.current += 1;
        return false;
      }

      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { upstream?: number };
        failStreakRef.current += 1;
        if (failStreakRef.current >= FAIL_STREAK_LIMIT) {
          setFatal(
            body.upstream === 429
              ? "Whisper rate limit reached. Still recording; clips will resume shortly."
              : "Transcription is failing repeatedly. Still recording; check your connection.",
          );
        }
        // Only a container/decode rejection is worth retrying with a wider
        // header. Retrying a 429 or 503 would just burn the rate limit.
        if (headerRef.current && body.upstream && body.upstream < 500) {
          try {
            const retry = await send(
              new Blob([headerRef.current, job.raw], { type: "audio/webm" }),
            );
            if (retry.ok) {
              failStreakRef.current = 0;
              setFatal("");
              const json = (await retry.json()) as { original?: string; language?: string };
              const text = (json.original || "").trim();
              if (!text) return true;
              addAudioSecs(job.secs);
              setRemaining(remainingAudioSecs());
              if (json.language) setDetected(json.language);
              const eng = await toEnglish(text, json.language || "auto");
              if (!aliveRef.current) return false;
              pushResult(text, eng);
              return true;
            }
          } catch {
            // fall through, already counted as a failure
          }
        }
        return false;
      }

      const json = (await response.json()) as { original?: string; language?: string };
      failStreakRef.current = 0;
      setFatal(""); // a good clip clears any earlier warning

      const text = (json.original || "").trim();
      if (!text) return true; // silence, not a failure

      addAudioSecs(job.secs);
      setRemaining(remainingAudioSecs());
      if (json.language) setDetected(json.language);
      const eng = await toEnglish(text, json.language || "auto");
      if (!aliveRef.current) return false;
      pushResult(text, eng);
      return true;
    },
    [hardStopGroq, pushResult, toEnglish],
  );

  // Serial pump. Uploading one clip at a time is what stops requests stacking up
  // and tripping the rate limit.
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      while (queueRef.current.length > 0 && aliveRef.current) {
        const job = queueRef.current.shift();
        if (!job) break;
        if (aliveRef.current) setBusy(queueRef.current.length > 0);
        await transcribeJob(job);
      }
    } finally {
      pumpingRef.current = false;
      if (aliveRef.current) setBusy(false);
    }
  }, [transcribeJob]);

  const startGroq = useCallback(async () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setFatal("This browser cannot capture microphone audio. Chrome, Edge and Safari support MediaRecorder capture.");
      setRecording(false);
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
    } catch (err) {
      const name = (err as { name?: string })?.name;
      setFatal(
        name === "NotAllowedError"
          ? errText("not-allowed", "Microphone permission was denied.")
          : name === "NotFoundError"
            ? errText("audio-capture", "No microphone was found.")
            : "Could not open the microphone.",
      );
      setRecording(false);
      return;
    }
    if (!aliveRef.current || !wantRef.current) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    streamRef.current = stream;
    failStreakRef.current = 0;

    // Tap the live stream for real levels. The analyser is never connected to the
    // destination, so nothing feeds back.
    try {
      const Ctx = window.AudioContext;
      const ctx = new Ctx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      ctx.createMediaStreamSource(stream).connect(analyser);
      audioCtxRef.current = ctx;
      startMeter(analyser);
    } catch {
      // Meter is cosmetic; recording matters more.
    }

    try {
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recorderRef.current = rec;
      lastFlushRef.current = Date.now();

      rec.ondataavailable = (e) => {
        const blob = e.data;
        if (!blob || blob.size === 0) return;

        void (async () => {
          const raw = new Uint8Array(await blob.arrayBuffer());
          if (!aliveRef.current) return;

          // Grab the container header from the very first fragment that has any
          // bytes, even one too short to upload on its own.
          if (!headerRef.current && raw.length > 64) {
            headerRef.current = raw.subarray(0, RETRY_HEADER_BYTES).slice();
          }
          if (raw.length < MIN_BLOB) return;

          const payload = headerRef.current
            ? new Blob([headerRef.current.subarray(0, HEADER_BYTES), raw], {
                type: rec.mimeType || "audio/webm",
              })
            : blob;

          const now = Date.now();
          const secs = (now - lastFlushRef.current) / 1000;
          lastFlushRef.current = now;

          queueRef.current.push({ payload, raw, secs });
          // If the service falls behind, shed the oldest backlog rather than
          // queueing without bound.
          if (queueRef.current.length > MAX_QUEUE) {
            queueRef.current.splice(0, queueRef.current.length - MAX_QUEUE);
          }
          void pump();
        })();
      };

      rec.onstop = () => {
        if (aliveRef.current) releaseStream();
      };

      // One recorder for the entire SOS session. Each `dataavailable` carries
      // the audio since the previous event, so nothing is dropped between clips
      // and the encoder is never restarted.
      rec.start(SEG_MS);
      setRecording(true);
      setFatal("");
    } catch {
      setFatal("This browser could not start an audio recording.");
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);
    }
  }, [pump, releaseStream, startMeter]);

  // Flushes whatever is buffered before releasing the mic, so the last words of
  // an SOS are not thrown away. Chrome fires one final `dataavailable` on stop
  // and our handler enqueues it, then `onstop` releases the microphone.
  const finishGroq = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state === "recording") {
      try {
        rec.stop();
        return;
      } catch {
        // fall through
      }
    }
    releaseStream();
  }, [releaseStream]);

  // ----------------------------------------------------- browser engine ----

  // Declared before `build` so the `onend` re-arm path has a stable reference.
  const startBrowserRef = useRef<(() => void) | null>(null);

  const build = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) return;
    const gen = genRef.current;
    const rec = new Ctor();
    rec.lang = langRef.current === "auto" ? "en-IN" : langRef.current;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onstart = () => {
      if (aliveRef.current && gen === genRef.current) setRecording(true);
    };

    rec.onresult = (e) => {
      if (gen !== genRef.current) return;
      let finalText = "";
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (!r) continue;
        const t = r[0]?.transcript || "";
        if (r.isFinal) finalText += t;
        else interimText += t;
      }
      if (interimText.trim()) setInterim(interimText.trim());
      const phrase = finalText.trim();
      if (!phrase) return;
      setInterim("");
      void (async () => {
        const eng = await toEnglish(phrase, langRef.current);
        if (!aliveRef.current || gen !== genRef.current) return;
        pushResult(phrase, eng);
      })();
    };

    rec.onerror = (e) => {
      if (!aliveRef.current || gen !== genRef.current) return;
      // no-speech just means a quiet stretch; onend restarts us.
      if (e.error === "no-speech") return;
      if (
        e.error === "not-allowed" ||
        e.error === "service-not-allowed" ||
        e.error === "audio-capture"
      ) {
        setFatal(ERRORS[e.error] || `Voice input failed (${e.error}).`);
        wantRef.current = false;
        setRecording(false);
        return;
      }
      failStreakRef.current += 1;
      if (failStreakRef.current >= FAIL_STREAK_LIMIT) {
        setFatal(ERRORS[e.error] || `Voice input failed (${e.error}).`);
      }
    };

    rec.onend = () => {
      if (!aliveRef.current) return;
      if (gen !== genRef.current) return; // superseded by a newer start/stop
      if (!wantRef.current) {
        setRecording(false);
        return;
      }
      // Chrome ends a continuous session after a few seconds of silence. Re-arm
      // this same instance synchronously so the badge never drops to Idle.
      try {
        rec.start();
        return;
      } catch {
        if (restartRef.current !== null) return;
        restartRef.current = window.setTimeout(() => {
          restartRef.current = null;
          if (aliveRef.current && wantRef.current && gen === genRef.current) {
            startBrowserRef.current?.();
          }
        }, 150);
      }
    };

    recRef.current = rec;
    try {
      rec.start();
    } catch {
      if (aliveRef.current) setFatal("Could not start voice input.");
    }
  }, [pushResult, toEnglish]);

  const startBrowser = useCallback(() => {
    if (!getCtor()) {
      setFatal(
        "Live transcription is not available in this browser. Chrome or Edge support it; Firefox does not.",
      );
      return;
    }
    genRef.current += 1;
    setFatal("");
    build();
  }, [build]);

  startBrowserRef.current = startBrowser;

  const stopBrowser = useCallback(() => {
    wantRef.current = false;
    genRef.current += 1; // invalidate any pending onend restart
    if (restartRef.current !== null) {
      window.clearTimeout(restartRef.current);
      restartRef.current = null;
    }
    recRef.current?.abort();
    recRef.current = null;
    setRecording(false);
  }, []);

  // Single owner of the session. Merging the arm, language and engine effects
  // into one is what stops the double-start that left two recognisers running.
  useEffect(() => {
    stopBrowser();
    hardStopGroq();
    if (!active || !engine) {
      setRecording(false);
      return;
    }
    wantRef.current = true;
    if (engine === "groq") void startGroq();
    else startBrowser();
  }, [active, engine, startBrowser, startGroq, stopBrowser, hardStopGroq]);

  const clear = useCallback(() => {
    rollRef.current = { original: "", english: "" };
    setInterim("");
    setOriginal("");
    setEnglish("");
    setDetected("");
    setFatal("");
    failStreakRef.current = 0;
  }, []);

  const begin = useCallback(() => {
    if (!engine) return;
    wantRef.current = true;
    if (engine === "groq") void startGroq();
    else startBrowser();
  }, [engine, startBrowser, startGroq]);

  const end = useCallback(() => {
    wantRef.current = false;
    if (engine === "groq") finishGroq();
    else stopBrowser();
  }, [engine, finishGroq, stopBrowser]);

  const canGroq =
    mounted && typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
  const canBrowser = mounted && !!getCtor();
  const supported = engine === null ? true : engine === "groq" ? canGroq : canBrowser;

  if (mounted && !supported) {
    return (
      <div className="border border-border bg-surface p-5">
        <div className="flex items-center gap-2">
          <MicOff className="size-4" />
          <p className="label-mono">Live microphone / Unsupported</p>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          {engine === "groq"
            ? "This browser cannot capture microphone audio for transcription. Chrome, Edge and Safari support MediaRecorder; some privacy modes do not."
            : "This browser has no SpeechRecognition implementation and no Groq key is configured, so live transcription is unavailable."}
        </p>
      </div>
    );
  }

  const groqMode = engine === "groq";
  const quotaWarning = groqMode && isQuotaWarning() && remaining > 0;
  const langLabel = LANGS.find((l) => l.code === lang)?.label ?? lang;

  return (
    <div className="border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Mic className={`size-4 ${recording ? "animate-pulse" : ""}`} />
          <p className="label-mono">Live microphone / Surroundings</p>
          {/* REC/Idle only. Transcription activity must never rewrite this text,
              or the badge visibly flips on every clip. */}
          <Tag inverse={recording}>{recording ? "REC" : "Idle"}</Tag>
          {groqMode ? (
            <Tag>
              {/* Always mounted, opacity only: a mount/unmount here reflows the
                  header on every single clip. */}
              <span className={busy ? "opacity-100" : "opacity-30"}>●</span> Whisper
            </Tag>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="mic-lang" className="flex items-center gap-1.5">
            <Languages className="size-3.5" />
            <span className="sr-only">Spoken language</span>
          </label>
          <select
            id="mic-lang"
            value={lang}
            title={
              groqMode
                ? "Whisper detects the language on its own, or use this as a hint"
                : "Language hint for browser transcription"
            }
            onChange={(e) => setLang(e.target.value)}
            className="h-9 max-w-[13rem] border border-input bg-background px-2 font-mono text-[10px] uppercase outline-none focus:border-foreground"
          >
            {LANGS.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Real room levels, written by a rAF loop. Fixed height so it never
          contributes to layout shift. */}
      <div className="mt-4 flex h-12 items-end gap-0.5" aria-hidden="true">
        {Array.from({ length: 48 }).map((_, i) => (
          <span
            key={i}
            ref={(el) => {
              barRefs.current[i] = el;
            }}
            className={`mic-bar flex-1 ${recording ? "bg-foreground" : "bg-muted"}`}
          />
        ))}
      </div>

      {fatal ? (
        <p role="alert" className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {fatal}
        </p>
      ) : null}

      {/* Speak box: what was actually said, in the language it was said in. */}
      <div className="mt-4 border border-border bg-background p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="label-mono">Speak box / What was said</p>
          <span className="font-mono text-[9px] uppercase text-muted-foreground">
            {detected ? `Detected: ${detected}` : ""}
          </span>
        </div>
        <p className="mt-2 min-h-20 font-mono text-sm leading-relaxed" aria-live="polite">
          {original || interim ? null : (
            <span className="text-muted-foreground">
              {recording
                ? `Listening. The first words appear after about ${SEG_MS / 1000}s.`
                : "Not recording yet."}
            </span>
          )}
          {original}
          {interim ? <span className="text-muted-foreground"> {interim}</span> : null}
        </p>
      </div>

      {/* English bar, directly below the speak box. Drives threat analysis. */}
      <div className="mt-px border border-t-0 border-border bg-foreground p-4 text-background">
        <div className="flex items-center justify-between gap-2">
          <p className="label-mono !text-background">English / Translated for classification</p>
          {NON_LATIN.test(original) ? (
            <span className="font-mono text-[9px] uppercase opacity-60">Translated</span>
          ) : null}
        </div>
        <p className="mt-2 min-h-20 font-mono text-sm leading-relaxed" aria-live="polite">
          {english || (
            <span className="opacity-60">
              {recording
                ? "English appears here as clips are transcribed."
                : "English appears here once you speak."}
            </span>
          )}
        </p>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {recording ? (
          <Button variant="outline" onClick={end} className="font-mono text-xs uppercase">
            <MicOff /> Stop listening
          </Button>
        ) : (
          <Button onClick={begin} className="font-mono text-xs uppercase">
            <Mic /> Start listening
          </Button>
        )}
        <Button variant="outline" onClick={clear} className="font-mono text-xs uppercase">
          Clear
        </Button>
        <span className="ml-auto flex items-center gap-1.5 font-mono text-[9px] uppercase text-muted-foreground">
          <Radio className="size-3" />
          {groqMode
            ? "Audio is uploaded to Groq Whisper and not stored by this app"
            : "Audio is processed by your browser vendor, not stored here"}
        </span>
      </div>

      {groqMode ? (
        <p
          className={`mt-2 font-mono text-[9px] uppercase ${quotaWarning ? "text-foreground" : "text-muted-foreground"}`}
        >
          Language: {langLabel} · Whisper quota left today: {formatRemaining(remaining)} of{" "}
          {formatRemaining(DAILY_CAP_SECS)}
        </p>
      ) : null}
    </div>
  );
}
