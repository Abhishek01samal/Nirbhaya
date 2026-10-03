import {
  JINA_API_KEY,
  JINA_EMBEDDING_MODEL,
  JINA_BASE_URL,
  JINA_BATCH_TOKEN_LIMIT,
  JINA_MAX_RETRIES,
  JINA_TIMEOUT_MS,
} from "../../config/env.js";

const MAX_INPUTS_PER_REQUEST = 32;
const CHARS_PER_TOKEN = 4;

class EmbeddingError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = "EmbeddingError";
    this.code = code;
    this.status = status;
  }
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / CHARS_PER_TOKEN);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildBatches(texts, tokenLimit) {
  const batches = [];
  let current = [];
  let currentTokens = 0;

  for (const text of texts) {
    const tokens = Math.max(1, estimateTokens(text));

    if (
      current.length > 0 &&
      (currentTokens + tokens > tokenLimit || current.length >= MAX_INPUTS_PER_REQUEST)
    ) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }

    current.push(text);
    currentTokens += tokens;
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

async function requestEmbeddings(input) {
  let lastError = null;

  for (let attempt = 1; attempt <= JINA_MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch(`${JINA_BASE_URL}/embeddings`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${JINA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: JINA_EMBEDDING_MODEL, input }),
        signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
      });
    } catch (err) {
      lastError = new EmbeddingError(
        "JINA_UNREACHABLE",
        `Failed to reach the Jina API: ${err.message}`,
        502
      );
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    if (response.ok) {
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new EmbeddingError("JINA_API_ERROR", "Jina API returned an unreadable response", 502);
      }

      const items = Array.isArray(payload?.data) ? payload.data : [];
      const ordered = items
        .slice()
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((item) => item.embedding);

      if (ordered.length !== input.length || ordered.some((v) => !Array.isArray(v))) {
        throw new EmbeddingError(
          "JINA_API_ERROR",
          "Jina API returned an unexpected number of embeddings",
          502
        );
      }

      return ordered;
    }

    const body = await response.text().catch(() => "");

    if (response.status === 429 || response.status >= 500) {
      lastError = new EmbeddingError(
        "JINA_API_ERROR",
        `Jina API request failed with status ${response.status}: ${body.slice(0, 200)}`,
        502
      );
      await sleep(500 * 2 ** (attempt - 1));
      continue;
    }

    throw new EmbeddingError(
      response.status === 401 || response.status === 403
        ? "JINA_NOT_AUTHORIZED"
        : "JINA_API_ERROR",
      `Jina API request failed with status ${response.status}: ${body.slice(0, 200)}`,
      response.status === 401 || response.status === 403 ? 500 : 502
    );
  }

  throw lastError || new EmbeddingError("JINA_API_ERROR", "Jina API request failed", 502);
}

async function embedTexts(texts) {
  if (!JINA_API_KEY) {
    throw new EmbeddingError("JINA_NOT_CONFIGURED", "JINA_API_KEY is not configured on the server", 500);
  }
  if (!Array.isArray(texts) || texts.length === 0) return [];

  const batches = buildBatches(texts, JINA_BATCH_TOKEN_LIMIT);
  const results = [];

  for (const batch of batches) {
    results.push(...(await requestEmbeddings(batch)));
  }

  return results;
}

async function embedQuery(query) {
  const [vector] = await embedTexts([String(query)]);
  return vector;
}

export {
  EmbeddingError,
  estimateTokens,
  embedTexts,
  embedQuery,
  buildBatches,
};
