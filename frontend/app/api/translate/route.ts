import { NextResponse } from "next/server";

import { hindiToEnglish, isNonLatinScript } from "@/lib/hindi-fallback";

// Translates a speech transcript into English. Runs with no configuration at
// all: without an API key it falls back to the built-in Hindi/Hinglish safety
// dictionary so emergency classification still works in the demo.
const SYSTEM = `You are a translation layer for a personal safety app. Translate the user's speech into natural, plain English. Preserve the speaker's intent and urgency exactly. If the text is already English, return it unchanged. Reply with the translation only, no quotes, no preamble, no explanation.`;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { text?: string; from?: string };
    const text = (body.text || "").slice(0, 600).trim();
    const from = (body.from || "auto").slice(0, 12);

    if (!text) {
      return NextResponse.json({ error: "Text required" }, { status: 400 });
    }

    // Already English: nothing to do. Avoids a pointless round trip.
    if (!isNonLatinScript(text)) {
      return NextResponse.json({ english: text, source: "passthrough" });
    }

    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      const gloss = hindiToEnglish(text);
      if (!gloss) {
        return NextResponse.json(
          {
            english: text,
            source: "untranslated",
            error: "No translation available. Set OPENAI_API_KEY for live translation.",
          },
          { status: 200 },
        );
      }
      return NextResponse.json({ english: gloss, source: "dictionary" });
    }

    const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 200,
        messages: [
          {
            role: "system",
            content:
              from === "auto" ? SYSTEM : `${SYSTEM} The speaker's language code is "${from}".`,
          },
          { role: "user", content: text },
        ],
      }),
      signal: AbortSignal.timeout(12000),
    });

    if (!response.ok) {
      // Degrade to the dictionary rather than losing the transcript entirely.
      const gloss = hindiToEnglish(text);
      return NextResponse.json({
        english: gloss || text,
        source: gloss ? "dictionary" : "untranslated",
      });
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const english = String(json.choices?.[0]?.message?.content || "").trim();
    return NextResponse.json({ english: english || hindiToEnglish(text) || text, source: "model" });
  } catch {
    return NextResponse.json({ error: "Translation unavailable right now." }, { status: 500 });
  }
}
