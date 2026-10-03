// Tracks how much audio has been sent to Groq Whisper today, so the demo stops
// honestly at the cap instead of eating a silent 429 mid-SOS.

const KEY = "Nirbhaya:groq-audio-secs";

// Groq documents 28,800 audio seconds/day (8h) on the free tier for
// whisper-large-v3. NOT re-verified against their live console -- if the plan
// changes this is the one number to correct.
export const DAILY_CAP_SECS = 28_800;

const WARN_RATIO = 0.8;
const MAX_KEEP = 600;

type Store = { day: string; secs: number };

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function read(): Store {
  const fresh: Store = { day: today(), secs: 0 };
  if (typeof window === "undefined") return fresh;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw) as Partial<Store>;
    if (parsed.day !== today()) return fresh;
    return { day: today(), secs: Math.max(0, Number(parsed.secs) || 0) };
  } catch {
    return fresh;
  }
}

function write(store: Store): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(store));
  } catch {
    // Private mode or a full quota: tracking is best-effort, never fatal.
  }
}

export function addAudioSecs(secs: number): void {
  if (!Number.isFinite(secs) || secs <= 0) return;
  const store = read();
  store.secs += secs;
  write(store);
}

export function usedAudioSecs(): number {
  return read().secs;
}

export function remainingAudioSecs(): number {
  return Math.max(0, DAILY_CAP_SECS - read().secs);
}

export function isQuotaExhausted(): boolean {
  return remainingAudioSecs() <= 0;
}

export function isQuotaWarning(): boolean {
  return read().secs >= DAILY_CAP_SECS * WARN_RATIO;
}

// "2h 36m" / "48m" -- reads faster than a raw seconds count for a cap this size.
export function formatRemaining(secs: number): string {
  const total = Math.max(0, Math.round(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${total}s`;
}

// Rolling transcript buffer: keeps the tail so a long SOS session cannot grow
// without bound, while staying under the 600-char window the translate route
// accepts.
export function appendCapped(prev: string, next: string, cap = MAX_KEEP): string {
  const joined = prev ? `${prev} ${next}`.trim() : next.trim();
  if (joined.length <= cap) return joined;
  return joined.slice(joined.length - cap);
}
