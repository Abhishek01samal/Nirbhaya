import 'dotenv/config';

const parsePort = (value, fallback) => {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
};

const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const parseBool = (value, fallback) => {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: (process.env.NODE_ENV || 'development') === 'production',
  port: parsePort(process.env.PORT, 4000),

  mongodbUri: process.env.MONGODB_URI || '',

  jwtSecret: process.env.JWT_SECRET || '',

  corsOrigin: process.env.CORS_ORIGIN || '*',
  socketCorsOrigin: process.env.SOCKET_CORS_ORIGIN || process.env.CORS_ORIGIN || '*',

  // Uppercase aliases consumed by Person 2 socket/model files.
  CORS_ORIGIN: process.env.CORS_ORIGIN || '*',
  JWT_SECRET: process.env.JWT_SECRET || '',

  // Monitoring / location tuning (Person 2).
  LOCATION_TTL_DAYS: parsePositiveInt(process.env.LOCATION_TTL_DAYS, 7),
  OFF_ROUTE_THRESHOLD_M: parsePositiveInt(process.env.OFF_ROUTE_THRESHOLD_M, 150),
  OFF_ROUTE_DEBOUNCE_POINTS: parsePositiveInt(process.env.OFF_ROUTE_DEBOUNCE_POINTS, 3),
  OFF_ROUTE_COOLDOWN_S: parsePositiveInt(process.env.OFF_ROUTE_COOLDOWN_S, 120),
  STOP_RADIUS_M: parsePositiveInt(process.env.STOP_RADIUS_M, 50),
  STOP_SECONDS: parsePositiveInt(process.env.STOP_SECONDS, 300),

  livekit: Object.freeze({
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
    tokenTtlSeconds: parsePositiveInt(process.env.LIVEKIT_TOKEN_TTL_SECONDS, 600),
  }),

  escalation: Object.freeze({
    guardianTimeoutSeconds: parsePositiveInt(
      process.env.GUARDIAN_ESCALATION_TIMEOUT_SECONDS,
      60
    ),
    responderTimeoutSeconds: parsePositiveInt(
      process.env.RESPONDER_ESCALATION_TIMEOUT_SECONDS,
      60
    ),
  }),
});

export const isProduction = env.isProduction;

export const MONGODB_URI = env.mongodbUri;
export const JWT_SECRET = env.jwtSecret;
export const CORS_ORIGIN = env.corsOrigin;

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
export const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

export const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
export const GROQ_BASE_URL = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
export const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

export const JINA_API_KEY = process.env.JINA_API_KEY || '';
export const JINA_EMBEDDING_MODEL = process.env.JINA_EMBEDDING_MODEL || 'jina-embeddings-v3';
export const JINA_BASE_URL = process.env.JINA_BASE_URL || 'https://api.jina.ai/v1';
export const JINA_BATCH_TOKEN_LIMIT = parsePositiveInt(process.env.JINA_BATCH_TOKEN_LIMIT, 8192);
export const JINA_MAX_RETRIES = parsePositiveInt(process.env.JINA_MAX_RETRIES, 3);
export const JINA_TIMEOUT_MS = parsePositiveInt(process.env.JINA_TIMEOUT_MS, 20000);

export const TAVILY_API_KEY = process.env.TAVILY_API_KEY || '';
export const TAVILY_BASE_URL = process.env.TAVILY_BASE_URL || 'https://api.tavily.com';
export const TAVILY_MAX_RESULTS = parsePositiveInt(process.env.TAVILY_MAX_RESULTS, 4);

export const TRANSLATE_ENABLED = parseBool(process.env.TRANSLATE_ENABLED, true);

export const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
export const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
export const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';

export const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

export const RAG_TOP_K = parsePositiveInt(process.env.RAG_TOP_K, 5);
export const RAG_CHUNK_SIZE = parsePositiveInt(process.env.RAG_CHUNK_SIZE, 1000);
export const RAG_CHUNK_OVERLAP = parsePositiveInt(process.env.RAG_CHUNK_OVERLAP, 200);

export const CHAT_RECENT_MESSAGE_TOKEN_LIMIT = parsePositiveInt(process.env.CHAT_RECENT_MESSAGE_TOKEN_LIMIT, 2000);
export const CHAT_SUMMARY_TRIGGER_TOKEN_LIMIT = parsePositiveInt(process.env.CHAT_SUMMARY_TRIGGER_TOKEN_LIMIT, 3000);
export const CHAT_PROMPT_TOKEN_LIMIT = parsePositiveInt(process.env.CHAT_PROMPT_TOKEN_LIMIT, 8000);
export const CHAT_MAX_MESSAGE_CHARS = parsePositiveInt(process.env.CHAT_MAX_MESSAGE_CHARS, 4000);
export const CHAT_SUMMARY_MAX_TOKENS = parsePositiveInt(process.env.CHAT_SUMMARY_MAX_TOKENS, 512);
export const CHAT_GENERATION_MAX_TOKENS = parsePositiveInt(process.env.CHAT_GENERATION_MAX_TOKENS, 1024);

export function validateEnv() {
  const missing = [];
  if (!env.mongodbUri) missing.push('MONGODB_URI');
  if (!env.jwtSecret) missing.push('JWT_SECRET');

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  return env;
}
