import { TAVILY_API_KEY, TAVILY_BASE_URL, TAVILY_MAX_RESULTS } from "../../config/env.js";

class TavilySearchError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const MAX_RESULTS_PER_CATEGORY = 4;

function isValidHttpUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function buildQueries(sourceName, destinationName) {
  return {
    flights: `flights from ${sourceName} to ${destinationName} booking`,
    trains: `trains from ${sourceName} to ${destinationName} booking`,
    cabs: `cabs from ${sourceName} to ${destinationName} booking`,
  };
}

function transportScore(result, category) {
  const keywords = {
    flights: ["flight", "flights", "airline", "airway", "air ticket", "fly"],
    trains: ["train", "trains", "rail", "railway", "irctc"],
    cabs: ["cab", "taxi", "taxicab", "ride", "uber", "ola", "outstation"],
  };
  const text = `${result.title || ""} ${result.content || ""}`.toLowerCase();
  let score = 0;
  for (const kw of keywords[category] || []) {
    if (text.includes(kw)) score += 2;
  }
  if (/book|ticket|search|fare|price|booking/.test(text)) score += 1;
  return score;
}

function normalizeResults(rawResults, category) {
  if (!Array.isArray(rawResults)) return [];
  const seen = new Set();
  const candidates = [];

  for (const r of rawResults) {
    if (!r || typeof r !== "object") continue;
    const url = typeof r.url === "string" ? r.url.trim() : "";
    const title = typeof r.title === "string" ? r.title.trim() : "";
    if (!isValidHttpUrl(url) || !title) continue;

    let host = "";
    try {
      host = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      continue;
    }

    const dedupeKey = url.split("#")[0].replace(/\/$/, "");
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    candidates.push({
      title,
      url,
      source: host,
      snippet: typeof r.content === "string" ? r.content.trim().slice(0, 300) : "",
      _score: transportScore(r, category),
    });
  }

  return candidates
    .sort((a, b) => b._score - a._score)
    .slice(0, MAX_RESULTS_PER_CATEGORY)
    .map(({ _score, ...rest }) => rest);
}

async function searchTransport(query, category) {
  if (!TAVILY_API_KEY) {
    throw new TavilySearchError("TAVILY_NOT_CONFIGURED", "Tavily API key is not configured on the server", 500);
  }

  let response;
  try {
    response = await fetch(`${TAVILY_BASE_URL}/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TAVILY_API_KEY}`,
      },
      body: JSON.stringify({
        query,
        search_depth: "basic",
        max_results: TAVILY_MAX_RESULTS,
        include_answer: false,
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new TavilySearchError("TAVILY_API_ERROR", "Failed to reach the Tavily API", 502);
  }

  if (!response.ok) {
    throw new TavilySearchError("TAVILY_API_ERROR", `Tavily API request failed with status ${response.status}`, 502);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new TavilySearchError("TAVILY_API_ERROR", "Tavily API returned an unreadable response", 502);
  }

  return normalizeResults(payload?.results, category);
}

export {
  searchTransport,
  buildQueries,
  normalizeResults,
  isValidHttpUrl,
  TavilySearchError,
  MAX_RESULTS_PER_CATEGORY,
};
