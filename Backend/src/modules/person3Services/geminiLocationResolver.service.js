import { GEMINI_API_KEY, GEMINI_BASE_URL, GEMINI_MODEL } from "../../config/env.js";

class LocationResolveError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const LOCATION_PROMPT = `You convert GPS coordinates into human-readable transportation locations inside a safety app.

You are given two coordinate pairs:
- guardian coordinates (the SOURCE / starting point)
- victim coordinates (the DESTINATION / end point)

Resolve each coordinate pair to the most useful human-readable location for booking ground, rail, or air transport. Prefer city-level names (e.g. "Delhi", "Kolkata") over exact street addresses.

Rules:
- Return only structured location data. No advice, prices, routes, or commentary.
- Do not invent addresses; use widely known place names for the coordinates.
- If a coordinate pair cannot be resolved to any useful location, set "name", "city", "state", and "country" to empty strings for that side rather than guessing.

Return ONLY a JSON object in this exact shape:
{
  "source": { "name": "<place>", "city": "<city>", "state": "<state>", "country": "<country>" },
  "destination": { "name": "<place>", "city": "<city>", "state": "<state>", "country": "<country>" }
}`;

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

function normalizeSide(side) {
  if (!side || typeof side !== "object") return null;
  const name = typeof side.name === "string" ? side.name.trim() : "";
  const city = typeof side.city === "string" ? side.city.trim() : "";
  const state = typeof side.state === "string" ? side.state.trim() : "";
  const country = typeof side.country === "string" ? side.country.trim() : "";
  if (!name && !city) return null;
  return { name: name || city, city: city || name, state, country };
}

function validateLocations(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const source = normalizeSide(parsed.source);
  const destination = normalizeSide(parsed.destination);
  if (!source || !destination) return null;
  return { source, destination };
}

async function resolveLocations({ guardianLocation, victimLocation }) {
  if (!GEMINI_API_KEY) {
    throw new LocationResolveError("GEMINI_NOT_CONFIGURED", "Gemini API key is not configured on the server", 500);
  }

  const input = `Guardian (source) coordinates: lat ${guardianLocation.lat}, lng ${guardianLocation.lng}\nVictim (destination) coordinates: lat ${victimLocation.lat}, lng ${victimLocation.lng}`;

  let response;
  try {
    response = await fetch(`${GEMINI_BASE_URL}/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: `${LOCATION_PROMPT}\n\n${input}` }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new LocationResolveError("GEMINI_API_ERROR", "Failed to reach the Gemini API", 502);
  }

  if (!response.ok) {
    throw new LocationResolveError("GEMINI_API_ERROR", `Gemini API request failed with status ${response.status}`, 502);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new LocationResolveError("GEMINI_API_ERROR", "Gemini API returned an unreadable response", 502);
  }

  const raw = payload?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") ?? "";
  const locations = validateLocations(extractJson(raw));

  if (!locations) {
    throw new LocationResolveError(
      "INVALID_LOCATION_RESPONSE",
      "Gemini could not resolve the coordinates into usable locations",
      502
    );
  }

  return locations;
}

export { resolveLocations, validateLocations, LocationResolveError };
