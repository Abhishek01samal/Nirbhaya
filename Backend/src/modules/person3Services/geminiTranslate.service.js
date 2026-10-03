import { GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_MODEL } from "../../config/env.js";

class TranslateError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const TRANSLATE_PROMPT = `You are a translator inside a personal safety application.
The input is a raw speech-to-text transcription of a voice recording. It may contain background conversation, multiple speakers, fragments, filler words, speech-to-text errors, and code-switching. It may be in any language (English, Hindi, Telugu, Tamil, Odia, etc.) or romanized (written with English letters).

Translate the entire transcription into natural English.

Rules:
- If the text is already English, return it unchanged.
- Preserve the exact meaning, urgency, fear, threats, and emotional tone. Do not soften, sanitize, summarize, rephrase away, or omit anything.
- Keep every sentence, fragment, speaker change, and noise marker exactly as heard.
- Keep names, places, and numbers as they are.
- Write English only inside translatedText.
- Never add explanations, commentary, or information that is not in the original.

Return ONLY a JSON object in this exact shape:
{"language":"<detected language>","translatedText":"<english translation>"}`;

const DETECT_LANGUAGE_PROMPT = `You are a language and script detector inside a personal safety application.
The input is a single user chat message. It may be short, code-mixed, slang, or ROMANIZED (a language written with English/Latin letters).

Rules:
- Identify the dominant language of the message AND the script it is written in.
- SCRIPT: return "latin" if the message is written with English/Latin letters. Return "native" if it is written in its own native script (Devanagari, Tamil, Telugu, Bengali, Arabic, Gurmukhi, etc.).
- CRITICAL HINGLISH RULE: If the message is Hindi expressed in Latin/English letters (romanized, e.g. "mai theek hu", "kya kar rahe ho", "bachao yaar"), return language "hinglish", languageName "Hinglish", script "latin". This is NOT Hindi (hi) and NOT English (en).
- ROMANIZED NON-HINDI RULE: Many other languages are also typed in English letters (romanized). If the message is such a language in Latin letters (e.g. Tamil "eppadi irukkeenga, enakku help venum", Telugu "ela unnaru, naku help kavali", Urdu "kya haal hai", Punjabi "ki haal ae"), return that language's own ISO 639-1 code (e.g. "ta", "te", "ur", "pa") with its English languageName and script "latin". Never invent tags like "tanglish" or "telugish".
- If the message is mostly English meaning, even with a few Hindi/regional words in Latin letters, return language "en", languageName "English", script "latin".
- If a language is written in its native script (e.g. Hindi in Devanagari, Tamil in Tamil script), return its ISO code with script "native".
- For any other language return its ISO 639-1 code and its English name (e.g. "ta"/"Tamil", "te"/"Telugu", "bn"/"Bengali", "mr"/"Marathi").
- If the message is empty, only numbers/symbols/emojis, or you cannot tell, return language "unknown", languageName "Unknown", script "unknown".

Return ONLY a JSON object in this exact shape:
{"language":"<tag>","languageName":"<English name>","script":"latin|native|unknown"}`;

function extractJson(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function translateToEnglish(text) {
  if (!GEMINI_API_KEY) {
    throw new TranslateError("GEMINI_NOT_CONFIGURED", "Gemini API key is not configured on the server", 500);
  }

  let response;
  try {
    response = await fetch(`${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${TRANSLATE_PROMPT}\n\nText to translate:\n${text}` }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new TranslateError("GEMINI_API_ERROR", "Failed to reach the Gemini API", 502);
  }

  if (!response.ok) {
    throw new TranslateError(
      "GEMINI_API_ERROR",
      `Gemini API request failed with status ${response.status}`,
      502
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new TranslateError("GEMINI_API_ERROR", "Gemini API returned an unreadable response", 502);
  }

  const raw = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  const parsed = extractJson(raw);

  const translatedText =
    parsed && typeof parsed.translatedText === "string" && parsed.translatedText.trim().length > 0
      ? parsed.translatedText.trim()
      : null;

  if (!translatedText) {
    throw new TranslateError(
      "INVALID_TRANSLATE_RESPONSE",
      "Gemini response could not be parsed into a translation",
      502
    );
  }

  const detectedLanguage =
    parsed && typeof parsed.language === "string" && parsed.language.trim().length > 0
      ? parsed.language.trim()
      : "unknown";

  return { translatedText, detectedLanguage };
}

async function detectLanguage(text) {
  if (!GEMINI_API_KEY) {
    throw new TranslateError("GEMINI_NOT_CONFIGURED", "Gemini API key is not configured on the server", 500);
  }

  let response;
  try {
    response = await fetch(`${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${DETECT_LANGUAGE_PROMPT}\n\nMessage:\n${text}` }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new TranslateError("GEMINI_API_ERROR", "Failed to reach the Gemini API", 502);
  }

  if (!response.ok) {
    throw new TranslateError(
      "GEMINI_API_ERROR",
      `Gemini API request failed with status ${response.status}`,
      502
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new TranslateError("GEMINI_API_ERROR", "Gemini API returned an unreadable response", 502);
  }

  const raw = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  const parsed = extractJson(raw);

  const language =
    parsed && typeof parsed.language === "string" && parsed.language.trim().length > 0
      ? parsed.language.trim().toLowerCase()
      : "unknown";

  const languageName =
    parsed && typeof parsed.languageName === "string" && parsed.languageName.trim().length > 0
      ? parsed.languageName.trim()
      : language === "unknown"
        ? "Unknown"
        : language;

  let script =
    parsed && typeof parsed.script === "string" &&
    ["latin", "native", "unknown"].includes(parsed.script.trim().toLowerCase())
      ? parsed.script.trim().toLowerCase()
      : "unknown";

  if (script === "unknown") {
    if (language === "hinglish" || language === "en") script = "latin";
    else if (language !== "unknown") script = "native";
  }

  return { language, languageName, script };
}

export { translateToEnglish, detectLanguage, TranslateError };
