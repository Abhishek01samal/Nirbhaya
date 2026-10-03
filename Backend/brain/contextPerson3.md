# Nirbhaya Server — Complete Context

> Read this file first. It describes every endpoint, module, data flow, and convention in this server so you can work on it without re-reading the whole codebase.

## 1. What this is

**Nirbhaya** — a personal-safety / SOS app backend. Three capabilities:

1. **Voice threat analysis** — client sends a speech-to-text transcription → server returns a 0–100 threat score → client triggers SOS if > 50.
2. **Audio recording storage** — upload/list/stream 1-minute SOS voice recordings (Cloudinary-backed).
3. **RAG AI safety assistant** — multilingual chatbot grounded on local Markdown knowledge bases (Jina embeddings + MongoDB cosine search + Google Gemini generation).

**Stack:** Express 4 (CommonJS) + Mongoose (MongoDB) + Cloudinary (audio) + Groq (threat classification) + Google Gemini (translation, language detection, chat replies, summarization) + Jina (embeddings). No test framework, no TypeScript, no ORM beyond Mongoose.

## 2. Quick facts

| | |
|---|---|
| Run | `npm start` (= `node index.js`), dev same |
| Test | `npm test` (node:test, transport unit tests) |
| Port | `PORT` env, default **5000** |
| Health | `GET /health` → `{status:"ok"}` |
| DB | `MONGODB_URI`, default `mongodb://127.0.0.1:27017/Nirbhaya` |
| Knowledge ingest | `npm run knowledge:ingest` (must run once after editing knowledge `.md` files) |
| Ingest sources | `knowledge_for_chatbot/*.md`, `knowledge/*.md` |
| Env file | `.env` (loaded by `config/env.js`), see `.env.example` |
| Required keys | `GEMINI_API_KEY`, `JINA_API_KEY`, `GROQ_API_KEY`, `TAVILY_API_KEY`, `MONGODB_URI`; Cloudinary keys only for recordings |
| Node | v22, fetch/AbortSignal used natively (no axios) |

## 3. Directory map (one line per file)

```
index.js                          app entry: cors, json body, route mounts, /api/sos-transcript, /health, listen
config/env.js                     loads .env, exports ALL tunables (see §9)
config/db.js                      connectDB(), isDbConnected()
config/cloudinary.js              cloudinary instance, isCloudinaryConfigured()
routes/voice.routes.js            mounts voice endpoints + middleware chains
routes/assistant.routes.js        mounts POST /chat
routes/transport.routes.js        mounts POST /search (emergency transport)
controllers/voice.controller.js   analyzeVoice, record/list/stream recordings
controllers/assistant.controller.js  chat() = the entire RAG pipeline
controllers/transport.controller.js   searchTransport() = coord validation + Gemini resolve + Tavily search
tests/emergencyTransport.test.js  node:test unit tests (validation, query gen, URL filtering, dedupe, partial failure)
middleware/translate.middleware.js   translateToEnglishMiddleware (voice analyze only)
middleware/upload.middleware.js   multer memory upload, field name "audio", 100MB, audio mime filter
services/geminiTranslate.service.js  translateToEnglish(), detectLanguage() (LLM-based, JSON out)
services/geminiChat.service.js    generateChatReply(), summarizeConversation(), SYSTEM_INSTRUCTIONS, buildLanguageInstruction()
services/groqThreat.service.js    analyzeThreat() → int 0..100
services/jinaEmbedding.service.js embedTexts(), embedQuery(), estimateTokens(); EmbeddingError
services/vectorStore.service.js   cosine search over KnowledgeChunk collection, upsert/remove helpers
services/contextBuilder.service.js build() → bounded prompt {prompt, stats}
services/knowledgeChunker.service.js chunkMarkdown() semantic Markdown chunker
services/knowledgeIngest.service.js  idempotent ingestion pipeline (sha256 docHash → skip unchanged)
services/cloudinary.service.js    uploadVoiceRecording(), deleteVoiceRecording()
services/geminiLocationResolver.service.js resolveLocations() → {source, destination} from guardian/victim coords (Gemini JSON)
services/tavilyTransport.service.js searchTransport(), buildQueries(), normalizeResults(); TavilySearchError
services/emergencyTransport.service.js searchEmergencyTransport() → Promise.allSettled flights/trains/cabs
models/chatSession.model.js       sessionId, summary, summaryCoveredCount, language, script
models/chatMessage.model.js       sessionId, role(user|assistant), content, language, script
models/knowledgeChunk.model.js    _id(string), source, knowledgeType(PROJECT|SAFETY|OTHER), topic/section/subsection, chunkIndex, docHash, content, vector[1024], embeddingModel
models/voiceRecording.model.js    sessionId(unique), type(ride|other), fileName, audioUrl, cloudinaryPublicId
scripts/ingest-knowledge.js       CLI wrapper for ingestKnowledge()
knowledge_for_chatbot/            aboutproject.md, WOMENS_SAFETY_KNOWLEDGE_BASE.md
RAG_ARCHITECTURE.md               deeper RAG design doc + error codes
TEST_CASES.md                     Postman test cases for the language feature
TEST_CASES_PROMPT.md              prompt to regenerate test cases with an LLM
VOICE_*_TEST.md                   voice endpoint test docs
```

## 4. Endpoints

Standard success shape: `{ "success": true, "data": ... }`
Standard error shape: `{ "success": false, "error": { "code": "...", "message": "..." } }`
Validation errors → 400 `VALIDATION_ERROR`; DB down → 500 `DATABASE_UNAVAILABLE`; external API → 502 `*_API_ERROR`.

### 4.1 `POST /api/v1/voice/analyze` — threat classification

- **Chain:** `translateToEnglishMiddleware` → `analyzeVoice` (voice.routes.js:13)
- **Middleware behavior:** if `TRANSLATE_ENABLED` and Gemini key exist, translates `req.body.transcription` → English via `translateToEnglish()`, replaces it in place, sets `req.body.sourceLanguage = detectedLanguage` (currently unused downstream). On any failure it silently continues with the original text. Handles any language incl. romanized. Max 5000 chars.
- **Input JSON:** `{ "transcription": string }` (non-empty, ≤5000 chars)
- **Process:** `analyzeThreat()` → Groq `chat/completions`, temp 0, system prompt (groqThreat.service.js:14–48) returns `{"threatLevel": 0}` JSON, normalized/clamped to integer 0–100.
- **Output 200:** `{ success:true, data:{ threatLevel: number, sosTriggered: boolean } }` — `sosTriggered = threatLevel > 50`.
- **Errors:** 400 `VALIDATION_ERROR`; 500 `GROQ_NOT_CONFIGURED`; 502 `GROQ_API_ERROR` / `INVALID_MODEL_RESPONSE`.
- **Note:** threat prompt itself also handles native script + romanized text natively (no dependency on the middleware).

### 4.2 `POST /api/v1/voice/recordings` — upload recording

- **Chain:** `uploadAudioMiddleware` → `recordVoiceRecording`
- **Input:** `multipart/form-data`: file field **`audio`** (≤100MB, audio mime), fields `sessionId` (string), `type` (`"ride"` | `"other"`).
- **Behavior:** rejects duplicate `sessionId` (409 `DUPLICATE_SESSION`), uploads to Cloudinary folder `voice/{type}/{sessionId}`, saves `VoiceRecording` doc; on DB failure it deletes the Cloudinary asset (compensation).
- **Output 201:** `{ data:{ sessionId, type, fileName, audioUrl, recordingId } }`
- **Errors:** 400 `VALIDATION_ERROR` (missing file/field, wrong type, >100MB, wrong field name), 409 `DUPLICATE_SESSION`, 500 `CLOUDINARY_NOT_CONFIGURED`/`DATABASE_ERROR`, 502 `CLOUDINARY_API_ERROR`.

### 4.3 `GET /api/v1/voice/recordings?sessionId=...` — list

- Optional query `sessionId` (validated non-empty). Returns newest-first array of `{ recordingId, sessionId, type, fileName, audioUrl, createdAt }`.

### 4.4 `GET /api/v1/voice/recordings/:recordingId/audio` — stream

- Validates ObjectId (404 if invalid/not found), fetches Cloudinary URL server-side, pipes stream back with content-type + Content-Disposition. Errors: 404 `NOT_FOUND`, 502 `AUDIO_FETCH_FAILED`, 500 `DATABASE_*`.

### 4.5 `POST /api/sos-transcript` — SOS log sink (index.js:17)

- **Input:** `{ timestamp, transcript, durationSeconds }` — just console-logs the transcript; no DB. Returns `{ status:"success", message:"Audio transcript received", receivedAt }`.

### 4.6 `GET /health`

- Returns `{ status:"ok", service:"Nirbhaya SOS Audio Server" }`. Use to check server is up.

### 4.7 `POST /api/v1/assistant/chat` — RAG chatbot (main endpoint)

- **Handler:** `chat()` in controllers/assistant.controller.js:84+ — **no middleware chain**.
- **Input JSON:**
  ```json
  { "sessionId": "string (≤128 chars, auto-created if new)", "message": "string (1..4000 chars)" }
  ```
- **Output 200:**
  ```json
  { "success": true, "data": { "sessionId": "...", "reply": "...", "replyLanguage": "en|hi|hinglish|ta|te|...|unknown", "replyScript": "latin|native|unknown", "knowledgeUsed": 10, "contextTokens": 4321 } }
  ```
- **Errors:** 400 `VALIDATION_ERROR`; 500 `DATABASE_UNAVAILABLE`/`DATABASE_ERROR`; 502/500 `GEMINI_*` / `EMBEDDING_*` (embedding failure aborts the request; vector-store failure only logs and continues without knowledge).

#### Chat pipeline (exact order, assistant.controller.js)

1. Validate `sessionId`/`message` (lengths above).
2. `isDbConnected()` → else 500.
3. **Start two promises in parallel** (fires before session load):
   - `languagePromise = detectLanguage(cleanMessage)` — Gemini JSON call; on failure resolves `null` (logged, never blocks).
   - `queryPromise = embedQuery(cleanMessage)` — Jina embedding of the RAW multilingual message (1024-dim). A dummy `.catch()` is attached to avoid unhandled-rejection warnings; real await happens later.
4. `loadOrCreateSession(sid)` — creates `{sessionId, summary:"", summaryCoveredCount:0}` if missing (duplicate-key race → re-fetch).
5. **Resolve reply language:**
   - If detection returned a language ≠ `unknown` → use it (`replyLanguage`, `replyLanguageName`, `replyScript`).
   - Else fall back to `session.language`/`session.script` (old sessions without `script`: hinglish/en → latin, else native).
   - Persist language+script back onto the session doc if changed (`session.save()`, failure only warned).
6. Store user `ChatMessage` with `{sessionId, role:"user", content, language, script}`.
7. Load full history `ChatMessage.find({sessionId}).sort(createdAt,_id)` (lean).
8. `splitRecentAndOlder(history, CHAT_RECENT_MESSAGE_TOKEN_LIMIT=5000)` → `recent` (newest, kept verbatim) + `older` (assistant.controller.js:29–45; walks backward accumulating `estimateTokens`).
9. `maybeUpdateSummary(session, older)` (lines 47–70): if tokens in older messages **not yet covered** by the summary (`summaryCoveredCount`) ≥ `CHAT_SUMMARY_TRIGGER_TOKEN_LIMIT` (6000) → call `summarizeConversation()` (Gemini temp 0, English-only output by instruction), save `session.summary` + advance `summaryCoveredCount`. Errors are swallowed (chat continues). **Language-blind**: raw multilingual messages go in; only facts preserved.
10. Await `queryPromise` → `search(queryVector, {topK: RAG_TOP_K})` — loads ALL chunks, cosine similarity in JS, top-K. (EmbeddingError → 502 abort; VectorStoreError → log, continue with `knowledge=[]`.)
11. `contextBuilder.build({sessionSummary, recentMessages, retrievedKnowledge, currentMessage})` → bounded prompt:
    - Budget = `CHAT_PROMPT_TOKEN_LIMIT` (12000 tok, 4 chars/token estimate).
    - Sections in order: `[SESSION SUMMARY]` (≤ min(400tok, 15%)) → `[RECENT CONVERSATION]` → `[RETRIEVED APPLICATION KNOWLEDGE]` + `[RETRIEVED SAFETY KNOWLEDGE]` (≤ 45% combined; overflow chunks dropped) → `[CURRENT USER MESSAGE]` (always). Empty sections omitted.
12. `generateChatReply({prompt, language, languageName, script})` — Gemini, temp 0.3, max `CHAT_GENERATION_MAX_TOKENS` (1024), 45s timeout. System instruction = `SYSTEM_INSTRUCTIONS` (knowledge-grounded safety rules, geminiChat.service.js:19–37) **+ `buildLanguageInstruction()`** (see §5).
13. Store assistant `ChatMessage` with same `language`/`script` (failure logged, reply still returned).
14. Respond with §4.7 output shape.

### 4.8 `POST /api/v1/emergency/transport/search` — emergency transport links

- **Chain:** `searchTransport` (controllers/transport.controller.js), mounted at `/api/v1/emergency/transport` (index.js).
- **Input JSON:** `{ "victimLocation": {"lat","lng"}, "guardianLocation": {"lat","lng"} }` — lat ∈ [-90,90], lng ∈ [-180,180].
- **Process:** Gemini resolves guardian coords → source, victim coords → destination (`resolveLocations`), then three concurrent Tavily searches (`Promise.allSettled`) with queries `buildQueries()`: flights/trains/cabs. `normalizeResults()` dedupes URLs, filters non-HTTP/untitled, prefers transport+booking keywords, max 3 per category.
- **Output 200:** `{ success:true, data:{ source:{coordinates,name,city,state,country}, destination:{...}, transport:{flights[],trains[],cabs[]}, transportErrors:{flights,trains,cabs} } }` — each result `{title,url,source,snippet}`.
- **Partial failure:** a failed category → empty array + non-null `transportErrors.<category>`; others still succeed.
- **Errors:** 400 `VALIDATION_ERROR`; 500 `GEMINI_NOT_CONFIGURED`/`TAVILY_NOT_CONFIGURED`; 502 `GEMINI_API_ERROR`/`INVALID_LOCATION_RESPONSE`/`TAVILY_API_ERROR`.
- **Not verified:** prices/availability/live data are NOT confirmed by this service; snippets are raw search text only.
- **Tests:** `npm test` (node:test, no external calls). Smoke-tested real against Gemini + Tavily on 2026-10-02.
- **Doc:** dedicated `EMERGENCY_TRANSPORT_SEARCH.md` not yet written; this section is the source of truth.

## 5. Language feature (how replies match user's language AND script)

- **Detector:** `detectLanguage(text)` in geminiTranslate.service.js — one Gemini call, temp 0, `responseMimeType: application/json`, 15s timeout. Prompt `DETECT_LANGUAGE_PROMPT` returns:
  ```json
  { "language": "en|hi|hinglish|ta|te|ur|pa|...|unknown", "languageName": "English|Hindi|Hinglish|...", "script": "latin|native|unknown" }
  ```
  Key rules baked into the prompt: Hindi in Latin letters → tag **`hinglish`** (not `hi`, not `en`); any other language typed in Latin/English letters (Tanglish, Telugish, romanized Urdu/Punjabi…) → its own ISO tag + `script:"latin"` (no invented tags like "tanglish"); native script → `script:"native"`; mostly-English → `en`; emoji/numbers/unclear → `unknown`.
- **Post-parse fallbacks** (detectLanguage): missing/invalid `script` → hinglish/en ⇒ `latin`, other known languages ⇒ `native`, unknown ⇒ `unknown`.
- **Instruction injected per reply** (`buildLanguageInstruction(language, languageName, script)`, geminiChat.service.js:115+):
  - `hinglish` → Latin letters ONLY, never Devanagari, casual romanized style examples, natural English code-mixing allowed.
  - `en` → plain English regardless of conversation context language.
  - non-English + `script=latin` → reply in that language in **romanized/Latin form**, never native script, knowledge translated in meaning.
  - non-English + `native`/other → reply in that language using its native script.
  - All branches append a switch-rule: current message's language overrides earlier turns (mid-session switches supported).
  - `unknown` → no instruction appended; falls back to base rule "Keep responses in the language the user writes in."
- **Storage:** `language` + `script` fields on both `ChatMessage` docs and on `ChatSession` (session = last detected, used as fallback when detection fails).
- **Client-facing:** response includes `replyLanguage` + `replyScript`.
- **Voice endpoint is separate:** it only translates TO English for threat scoring; output is a number, so no translation back ever.

## 6. Models / collections (Mongoose)

| Collection | Fields (defaults) | Indexes |
|---|---|---|
| `chatsessions` | sessionId(unique), summary(""), summaryCoveredCount(0), language(""), script(""), timestamps | unique sessionId |
| `chatmessages` | sessionId(index), role(user\|assistant), content, language("unknown"), script("unknown"), timestamps | {sessionId, createdAt} |
| `knowledgechunks` | _id **string** (sha256 of source\|docHash\|chunkIndex), source, knowledgeType(PROJECT\|SAFETY\|OTHER), topic, section, subsection, chunkIndex, docHash, content, vector[Number×1024], embeddingModel, timestamps | {source,docHash}, {knowledgeType} |
| `voicerecordings` | sessionId(**unique**), type(ride\|other), fileName, audioUrl, cloudinaryPublicId, timestamps | unique sessionId |

## 7. Services reference (exports + external API)

| Service | Exports | External call | Behavior notes |
|---|---|---|---|
| geminiTranslate | `translateToEnglish(text)` → `{translatedText, detectedLanguage}`; `detectLanguage(text)` → `{language, languageName, script}`; `TranslateError` | `POST {GEMINI_BASE_URL}/models/{GEMINI_MODEL}:generateContent`, header `x-goog-api-key` | temp 0, JSON mime, `extractJson()` strips ``` fences; translate 20s / detect 15s timeout; errors carry `code`+`status` (500/502) |
| geminiChat | `generateChatReply({prompt, language, languageName, script})`, `summarizeConversation({existingSummary, messages})`, `SYSTEM_INSTRUCTIONS`, `buildLanguageInstruction`, `ChatAIError`, `estimatePromptTokens` | same Gemini endpoint | `callGemini()` internal helper: systemInstruction via `body.systemInstruction`, 45s timeout, throws `GEMINI_NOT_CONFIGURED`(500)/`GEMINI_API_ERROR`(502)/`GEMINI_EMPTY_RESPONSE`(502). Summary temp 0 → English plain text (SUMMARY_INSTRUCTIONS explicitly pinned to English) |
| groqThreat | `analyzeThreat(text)` → int 0..100, `GroqError` | `POST {GROQ_BASE_URL}/chat/completions`, Bearer key | temp 0, parses `{"threatLevel": n}`, clamps/rounds; system prompt is language/romanization-aware |
| jinaEmbedding | `embedQuery(q)` → vector, `embedTexts(arr)` → vectors[], `estimateTokens(t)` = ceil(len/4), `EmbeddingError` | `POST {JINA_BASE_URL}/embeddings`, model `jina-embeddings-v3` | batched by `JINA_BATCH_TOKEN_LIMIT` (6000), `JINA_MAX_RETRIES` (3) w/ backoff, `JINA_TIMEOUT_MS` (60s); errors have code/status |
| vectorStore | `search(queryVector,{topK,knowledgeTypes})`, `upsertChunks`, `removeStaleChunks`, `getChunksBySource`, `countChunks`, `countChunksBySource`, `cosineSimilarity`, `VectorStoreError` | none (Mongo only) | **brute-force cosine over the whole collection in JS** — fine at current scale, replace with $vectorSearch/Atlas if chunk count grows |
| contextBuilder | `build({sessionSummary, recentMessages, retrievedKnowledge, currentMessage})`, `formatKnowledge` | none | 4 chars/token heuristic; formats chunks with header `[SAFETY KNOWLEDGE \| source \| topic > section]` |
| knowledgeChunker | `chunkMarkdown(md, options)`, `knowledgeTypeFor(fileName)`, `parseSections` | none | knowledgeType: filename contains "aboutproject" → PROJECT, else SAFETY; parses `#` headings into topic/section/subsection, chunk ≈ `RAG_CHUNK_SIZE` 600 tok with `RAG_CHUNK_OVERLAP` 80 |
| knowledgeIngest | `ingestKnowledge({log})`, `discoverKnowledgeFiles`, `chunkIdFor`, `KNOWLEDGE_DIRS` | Jina embedTexts | idempotent: sha256 file → skip if docHash+chunks identical, else re-embed + upsert + `removeStaleChunks`; collects per-file errors |
| cloudinary | `uploadVoiceRecording({buffer,type,sessionId})` → `{audioUrl, cloudinaryPublicId}`, `deleteVoiceRecording`, `CloudinaryError` | Cloudinary upload | folder `voice/{type}/{sessionId}`; `CLOUDINARY_NOT_CONFIGURED` if keys missing |
| translate.middleware | `translateToEnglishMiddleware(req,res,next)` | via geminiTranslate | only touches `req.body.transcription`; graceful skip on `!TRANSLATE_ENABLED \|\| !GEMINI_API_KEY` or any error |
| upload.middleware | `uploadAudioMiddleware` | multer memoryStorage | field must be `audio`, 100MB, audio mime whitelist; maps multer errors to 400 JSON |

## 8. Error codes (chat + shared)

| Code | Status | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | bad/missing field, length limit, bad JSON |
| `DATABASE_UNAVAILABLE` | 500 | `isDbConnected()` false |
| `DATABASE_ERROR` | 500 | Mongo op failed |
| `GEMINI_NOT_CONFIGURED` | 500 | no `GEMINI_API_KEY` |
| `GEMINI_API_ERROR` | 502 | Gemini HTTP/network failure |
| `GEMINI_EMPTY_RESPONSE` | 502 | Gemini returned empty/blocked |
| `GROQ_NOT_CONFIGURED` / `GROQ_API_ERROR` / `INVALID_MODEL_RESPONSE` | 500/502 | threat service |
| `INTERNAL_ERROR` | 500 | unexpected |
| embedding failure (any `EmbeddingError` code) | per err.status | chat aborts with it |
| `NOT_FOUND` / `AUDIO_FETCH_FAILED` / `CLOUDINARY_*` / `DUPLICATE_SESSION` / `UPLOAD_ERROR` | 404/502/500/409/400 | recording endpoints |

Full RAG error catalog also in `RAG_ARCHITECTURE.md`.

## 9. Config tunables (config/env.js)

`PORT`, `GROQ_API_KEY/BASE_URL/MODEL` (default `openai/gpt-oss-120b`), `GEMINI_API_KEY/BASE_URL/MODEL` (default `gemini-3.5-flash-lite`), `TAVILY_API_KEY/BASE_URL` (default `https://api.tavily.com`), `TAVILY_MAX_RESULTS` (5), `TRANSLATE_ENABLED` (default true; `!== "false"`), `MONGODB_URI`, `CLOUDINARY_*`, `JINA_API_KEY/EMBEDDING_MODEL/BASE_URL/BATCH_TOKEN_LIMIT/MAX_RETRIES/TIMEOUT_MS`, `RAG_TOP_K` (5), `RAG_CHUNK_SIZE` (600), `RAG_CHUNK_OVERLAP` (80), `CHAT_RECENT_MESSAGE_TOKEN_LIMIT` (5000), `CHAT_SUMMARY_TRIGGER_TOKEN_LIMIT` (6000), `CHAT_PROMPT_TOKEN_LIMIT` (12000), `CHAT_MAX_MESSAGE_CHARS` (4000), `CHAT_SUMMARY_MAX_TOKENS` (400), `CHAT_GENERATION_MAX_TOKENS` (1024).

## 10. Conventions & gotchas (follow these when editing)

- **CommonJS** (`require`/`module.exports`), 2-space indent, no comments unless asked, no TypeScript.
- Every service throws a **custom Error subclass** carrying `{code, status}`; controllers map them to the standard `{success:false,error:{code,message}}` JSON. Mirror this pattern for new services.
- **Graceful degradation is the house style:** translation failure → continue with original text; language detection failure → unknown + session fallback; summarization failure → chat continues; vector-store failure → chat continues without knowledge. Never fail a safety reply for a non-critical enhancement.
- Language detection & query embedding are **started early and awaited later** (`languagePromise`/`queryPromise`) — keep them concurrent; don't serialize them.
- The reply's language is enforced by `buildLanguageInstruction` appended to `SYSTEM_INSTRUCTIONS`; if you add new generation paths (e.g. streaming), carry that instruction along.
- `estimateTokens` is `chars/4` — undercounts Indic scripts; budgets are approximate but `contextBuilder` hard-clamps the prompt, so context never overflows.
- Vector search loads all chunks per query — acceptable now; revisit if `knowledgechunks` grows large.
- `req.body.sourceLanguage` (voice) is set but unused — intentional dead field today.
- After editing `knowledge_for_chatbot/*.md`, run `npm run knowledge:ingest` or retrieval won't reflect changes.
- Startup: server listens even if Mongo is down (`connectDB().finally(...)`); endpoints then return `DATABASE_UNAVAILABLE`.
- Test docs: `TEST_CASES.md` (Postman, language feature), `TEST_CASES_PROMPT.md` (LLM prompt to regenerate cases), `VOICE_THREAT_API_TEST.md`, `VOICE_EDGE_CASE_TEST.md`, `VOICE_RECORDING_UPLOAD_TEST.md`, deeper design in `RAG_ARCHITECTURE.md`.



write the prompt to test the flight and train api tell it to edit env file with place holders then i will paste the api there then it will test it by running script