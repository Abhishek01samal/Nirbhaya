import { GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL } from "../../config/env.js";

const THREAT_MIN = 0;
const THREAT_MAX = 100;

export class GroqError extends Error {
  constructor(code, message, status = 500) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const SYSTEM_PROMPT = `You are a threat-analysis classifier for a personal safety application.
You receive a transcription of a voice recording and you estimate how strongly the text indicates that a person in the recording may be in danger.

INPUT CHARACTERISTICS:
- The text may be in English, Hindi, or any other Indian language (Telugu, Tamil, Odia, Bengali, Marathi, etc.), possibly mixed together in one sentence.
- A regional language may appear in its native script OR romanized (written with English letters, e.g. "bachao", "kappom", "bayam", "jaauchi"). Both forms carry the same meaning - decode the romanized form.
- The text may be a background/conversation recording rather than someone speaking directly to the app: multiple speakers, overheard arguments, ambient noise artifacts, incomplete sentences, and speech-to-text errors are normal.
- Judge the actual situation being described or heard, not the transcription quality.

LANGUAGE RULES:
- Understand and analyze English, Hindi, and regional Indian languages equally well, in native script or romanized form.
- Do not lower or raise the score because of the language or script. The same real-world danger described in English, Hindi, Telugu, Tamil, or Odia must receive the same score.
- Translate mentally to compare meaning; never return the translation in your answer.

Consider contextual indications such as:
- direct threats
- violence or assault
- stalking or someone following the person who is recording
- coercion and intimidation
- kidnapping or forced confinement
- requests for help (e.g. "help", "bachao", "kappom", "bayatapadandi")
- expressions of fear connected to an actual real situation
- immediate physical danger
- harassment that indicates potential safety risk

Do not classify ordinary conversation as dangerous merely because words such as "kill", "fight", "attack", "maar dunga", "maarna", "champadam", "champestha", "kill pannu", or their equivalents in any language appear in a harmless context (movie talk, gaming, jokes, casual banter, sibling arguments, work complaints like "the deadline is killing me"). Analyze the meaning and context of the complete recording. In the background of a normal recording there may be arguments or loud words that are not a real safety threat - only score real danger to a person.

Respond with ONLY a JSON object in this exact shape and nothing else:
{"threatLevel": 0}

Where threatLevel is an integer from 0 to 100:
0 = no indication of threat
100 = extremely strong indication of threat

Do NOT return explanations, markdown, additional fields, recommendations, or emergency instructions.`;

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

function normalizeThreatLevel(raw) {
  const parsed = extractJson(raw);
  if (!parsed) return null;

  const value =
    typeof parsed.threatLevel === "number"
      ? parsed.threatLevel
      : typeof parsed.threatLevel === "string" && parsed.threatLevel.trim() !== "" && !Number.isNaN(Number(parsed.threatLevel))
        ? Number(parsed.threatLevel)
        : null;

  if (value === null || !Number.isFinite(value)) return null;

  const clamped = Math.min(THREAT_MAX, Math.max(THREAT_MIN, Math.round(value)));
  return clamped;
}

export async function analyzeThreat(transcription) {
  if (!GROQ_API_KEY) {
    throw new GroqError(
      "GROQ_NOT_CONFIGURED",
      "Groq API key is not configured on the server",
      500
    );
  }

  let response;
  try {
    response = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: transcription },
        ],
      }),
    });
  } catch {
    throw new GroqError("GROQ_API_ERROR", "Failed to reach the Groq API", 502);
  }

  if (!response.ok) {
    throw new GroqError(
      "GROQ_API_ERROR",
      `Groq API request failed with status ${response.status}`,
      502
    );
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new GroqError("GROQ_API_ERROR", "Groq API returned an unreadable response", 502);
  }

  const content = payload?.choices?.[0]?.message?.content;
  const threatLevel = normalizeThreatLevel(content);

  if (threatLevel === null) {
    throw new GroqError(
      "INVALID_MODEL_RESPONSE",
      "Model response could not be parsed into a valid threatLevel",
      502
    );
  }

  return threatLevel;
}
