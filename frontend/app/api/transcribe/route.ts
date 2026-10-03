import { NextResponse } from "next/server";

// Transcribes one SOS audio clip with Groq's Whisper. Deliberately returns the
// speech in its ORIGINAL language plus the detected language code: English is
// produced downstream by /api/translate, which already has a zero-config
// dictionary fallback. That keeps a transcript even if Groq is unreachable.

const MAX_BYTES = 12 * 1024 * 1024;

// Lets the client pick an engine up front instead of burning a 15s clip to
// discover there is no key.
export async function GET() {
  return NextResponse.json({ enabled: Boolean(process.env.GROQ_API_KEY) });
}

export async function POST(request: Request) {
  try {
    // Validate before touching config, so a malformed upload fails the same way
    // whether or not a key is present.
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { error: "Expected multipart form data with an audio file" },
        { status: 400 },
      );
    }
    const file = form.get("audio");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Audio required" }, { status: 400 });
    }
    if (!file.type.startsWith("audio/")) {
      return NextResponse.json({ error: "Unsupported media type" }, { status: 400 });
    }
    if (file.size === 0) {
      return NextResponse.json({ error: "Empty audio clip" }, { status: 400 });
    }
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: "Audio clip too large" }, { status: 413 });
    }

    // Optional ISO-639-1 hint. Omitted entirely when the caller is on auto, so
    // Whisper runs its own language detection.
    const language = String(form.get("language") || "auto")
      .trim()
      .slice(0, 8);

    const key = process.env.GROQ_API_KEY;
    if (!key) {
      return NextResponse.json({ reason: "no_key" }, { status: 503 });
    }

    const base = (process.env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
    // whisper-large-v3 is the Whisper variant Groq documents for the
    // transcriptions endpoint; the turbo model is transcription-only.
    const model = process.env.GROQ_MODEL || "whisper-large-v3";

    const upstream = new FormData();
    upstream.append("file", file, file.name || "clip.webm");
    upstream.append("model", model);
    upstream.append("response_format", "verbose_json");
    if (language && language !== "auto") {
      upstream.append("language", language);
    }

    const response = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body: upstream,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      // Surface the upstream status so the client can back off on 429 but keep
      // recording on a transient 5xx.
      return NextResponse.json(
        { error: "Transcription service unavailable", upstream: response.status },
        { status: 502 },
      );
    }

    const json = (await response.json()) as { text?: string; language?: string };
    const original = String(json.text || "").trim();
    if (!original) {
      return NextResponse.json({ original: "", language: "unknown", source: "groq" });
    }
    return NextResponse.json({
      original,
      language: String(json.language || "unknown"),
      source: "groq",
    });
  } catch {
    return NextResponse.json({ error: "Transcription unavailable right now." }, { status: 500 });
  }
}
