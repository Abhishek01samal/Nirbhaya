# Nirbhaya Backend — Integration Context (context.md)

**Stack:** Node.js (>=20), Express 5, Mongoose 9 (MongoDB), Socket.IO 4, Zod 4, Cloudinary, Tesseract.js, JWT, Groq (via fetch), Google Maps HTTP APIs.
**Base URL:** `http://localhost:<PORT>/api/v1` (default PORT 8000).
**Type:** ES modules (`"type": "module"`), no TypeScript.

This file is the single source of truth for integrating with this backend. It lists every route, model, service, socket event, job, and third-party integration, what each expects (input), what it returns (output), and what that output is used for downstream.

---

## 1. Conventions & Cross-Cutting Concerns

### 1.1 Auth (`src/middleware/auth.js`)
- Most HTTP routes require `Authorization: Bearer <JWT>` signed with `JWT_SECRET`.
- JWT payload: `{ sub | userId | id, ... }` → `req.user = { id, userId: String(id), ...decoded }`.
- **Dev-only fallback:** `x-user-id: <id>` header (ignored when `NODE_ENV=production`).
- `requireOwner(req, resourceUserId)` → 403 in production when the authenticated user doesn't own the resource, 401 if `req.user` missing.
- Socket.IO auth: `auth: { token }` (JWT) or dev-only `auth: { userId }`. On connect, socket joins room `user:{userId}`.
- **Owner:** Person 3 replaces `verifyToken` internals only; keep exports `requireAuth / optionalAuth / verifyToken`.

### 1.2 Validation (`src/middleware/validate.js`)
- `validateBody(zodSchema)`, `validateQuery(...)`, `validateParams(...)` replace `req.body`/`req.query` with parsed (coerced) values.
- Failures → 400 with `{ success:false, error:{ code:"VALIDATION_ERROR", details:[{path,message}] } }`.

### 1.3 Errors (`src/middleware/error.js`)
- `AppError(message, statusCode, code, details)`.
- `asyncHandler(fn)` wraps handlers; ZodError → VALIDATION_ERROR; Mongoose ValidationError/CastError → 400; MulterError → UPLOAD_ERROR; entity.too.large → 413.
- Standard error JSON: `{ success:false, error:{ code, message, details?, stack? (dev only, 5xx) } }`.
- Helpers: `badRequest` (400), `unauthorized` (401), `forbidden` (403), `notFound` (404), `conflict` (409), `serviceUnavailable` (503).

### 1.4 Success envelope
All endpoints respond `{ success: true, data: ..., meta?/count?/warnings? }`.

### 1.5 Safety Event Bus (`src/utils/safetyEventBus.js`) — THE integration point for Person 1's SOS module
```js
import { onSafetyEvent, emitSafetyEvent } from ".../utils/safetyEventBus.js";
onSafetyEvent((event) => sosService.handleDetection(event));
```
Event shape:
```js
{
  type: "OFF_ROUTE" | "LONG_STOP" | "GEOFENCE_BREACH" | "ARRIVED",
  userId: string|null,
  safetySessionId: string|null,
  rideId: string|null,
  location: { lat, lng } | null,
  metadata: object,
  source: "location" | "ride" | "monitoring",
  timestamp: Date
}
```
Also emits `safety_event:<TYPE>`; `onSafetyEventType(type, handler)` subscribes per-type. This backend only **detects**; it never escalates.

### 1.6 Socket helpers (`src/socket/socket.js`)
- `getIO()` (throws if not initialized), `tryGetIO()`, `emitToUser(userId, event, payload)`, `emitToRide(rideId, event, payload)`, `emitToSession(sessionId, event, payload)`, `emitToRoom(room, event, payload)`.
- Rooms: `user:{userId}` (auto-joined), `session:{safetySessionId}`, `ride:{rideId}`.

### 1.7 Config (`src/config/env.js`)
Required: `MONGODB_URI`, `JWT_SECRET` (≥8 chars, dev default). Optional with graceful fallback: `GOOGLE_MAPS_API_KEY` (synthetic routes + mock safe places/transport), `CLOUDINARY_*` (local `/uploads` fallback), `GROQ_API_KEY` (AI ride-field extraction skipped), `OCR_LANG` (default `eng`). Monitoring tunables: `OFF_ROUTE_THRESHOLD_M`(150), `OFF_ROUTE_DEBOUNCE_POINTS`(3), `OFF_ROUTE_COOLDOWN_S`(60), `STOP_RADIUS_M`(30), `STOP_SECONDS`(300), `LOCATION_TTL_DAYS`(30). Missing keys never crash — services degrade to mocks.

### 1.8 Other utils
- `utils/geo.js`: haversineMeters, pointToSegmentMeters, distanceToPolylineMeters, nearestSegment, bearingDegrees, decodePolyline, interpolateAlongPath, samplesAlongPath, bboxAround, parseBbox, isValidLatLng, isValidBbox.
- `utils/distance.js`: formatDistance, formatDuration, speedMetersPerSecond, sortNearby, average.
- `utils/logger.js`: leveled logger (`LOG_LEVEL=debug|info|warn|error|silent`), scopes like `[ride]`, `[monitoring]`.

---

## 2. Modules — Full Endpoint Reference

Every entry: purpose → input → output → downstream contribution.

### 2.1 safetySession (`src/modules/safetySession/`)
**Purpose:** one active safety session per user; brackets rides/location pings; carries counters.

**Model** `SafetySession`: `userId`, `status(active|ended|cancelled)`, `mode(walk|ride|static|travel)`, `startedAt`, `endedAt`, `origin/destination{lat,lng,address}`, `rideRefs[]`, `lastLocation{lat,lng,accuracy,speed,recordedAt}`, `eventCount`, `metadata`, `note`, timestamps. Unique partial index on `{userId}` where status="active". Virtual `durationSeconds`.

| Method | Path | Input | Output | Used for |
|---|---|---|---|---|
| POST | `/safety-sessions` | `{ mode?, origin?, destination?, metadata?, note? }` | 201 `{ data: session }` | Starting protection; auto-ends previous active session. |
| GET | `/safety-sessions/active` | query `userId?` (defaults to caller) | `{ data: session "nullable" }` | Showing current session on client. |
| GET | `/safety-sessions` | `userId?, status?, limit?` | `{ data: [session] }` | Session history UI. |
| GET | `/safety-sessions/:id` | — | `{ data: session }` (owner-checked) | Detail screen. |
| POST | `/safety-sessions/:id/end` | `{ status: ended|cancelled, reason? }` | `{ data: session }` | Ending protection; stores `endReason` in metadata. Idempotent. |

**Service API:** `startSession`, `getActiveSession`, `getSessionById`, `listSessions`, `endSession`, `endActiveSessionForUser`, `updateLastLocation(sessionId, point)` (called by location service), `attachRide(sessionId, rideId)` (called by ride service), `countSessionEvents`, `incrementSessionEvents(sessionId)` (called by monitoring detectors — increments `eventCount`).

### 2.2 location (`src/modules/location/`)
**Purpose:** persistent + realtime location pings; feeds the monitoring pipeline.

**Model** `LocationPoint`: `userId`, `safetySessionId?`, `rideId?`, `lat,lng`, `accuracy?, altitude?, speed?, heading?`, `recordedAt`, `source(socket|http|import)`. TTL index on `recordedAt` (LOCATION_TTL_DAYS). Indexes on `{userId,recordedAt}`, `{rideId,...}`, `{safetySessionId,...}`.

| Method | Path | Input | Output | Used for |
|---|---|---|---|---|
| POST | `/location` | `{ lat, lng, accuracy?, altitude?, speed?, heading?, recordedAt?, safetySessionId?, rideId?, userId? }` | 201 `{ data:{ id, lat,lng, recordedAt, monitors } }` | Single ping; `monitors` = `{ offRoute?, longStop? }` detector results (rideId present only). |
| POST | `/location/batch` | `{ userId?, points: [pointSchema] (≤500) }` | 201 `{ data:{ saved, ids, monitors } }` | Offline sync of buffered pings. |
| GET | `/location/current/:userId` | — | `{ data: point "nullable" }` | Last known position. |
| GET | `/location/history` | `userId?` **or** `rideId?` **or** `safetySessionId?`, `from?, to?, limit?(≤5000)` | `{ data: [point], count }` | Trail replay, evidence sharing. |

**Service API:** `recordPoint({...})` (persists point, updates session.lastLocation, runs `evaluateRidePoint` when rideId → returns `{ point, monitors }`), `getCurrent`, `getHistory`, `getRecentForRide(rideId, limit)`, `getRideTrail(rideId, limit)`, `requireCurrent`.
**Contribution:** `monitors` result lets HTTP clients surface OFF_ROUTE/LONG_STOP without a socket; every ping is the trigger for monitoring.

### 2.3 ride (`src/modules/ride/`)
**Purpose:** ride lifecycle from a screenshot upload (Cloudinary → OCR → AI extraction → user confirm → monitored trip).

**Model** `Ride`: `userId, safetySessionId?, status(draft|uploaded|confirmed|active|completed|cancelled)`, `provider, driver{name,phone}, vehicleNumber, vehicleModel, fareEstimate, tripNote`, `screenshot{stored,url,publicId,originalName,sizeBytes,ocrText,ocrFields,ocrError}`, `pickup/drop{lat,lng,address}`, `route{polyline[], distanceM, durationS, summary, steps[], source(google|manual|none), fetchedAt}`, `monitoring{thresholds, offRouteCounter, lastOffRouteAt, lastRouteDistanceM, stopAnchor, stopStartedAt, longStopEmittedAt, flags[]}` (flag types: OFF_ROUTE|LONG_STOP|GEOFENCE_BREACH|ARRIVED), `startedAt, stoppedAt`, virtual `durationSeconds`, `resetMonitoring()` method. Indexes `{userId,status,createdAt}`, `vehicleNumber`.

| Method | Path | Input | Output | Used for |
|---|---|---|---|---|
| POST | `/rides/upload` | multipart `screenshot` (≤8MB, png/jpeg/jpg/webp/heic/heif) | 201 `{ data: ride(status="uploaded"), warnings[] }` | OCR+AI prefill; warnings explain Cloudinary/OCR/Groq degradation. |
| GET | `/rides` | `status?, limit?(≤100)` | `{ data: [ride] }` | My rides list. |
| GET | `/rides/:id` | — | `{ data: ride }` | Ride detail (owner-checked). |
| POST | `/rides/:id/confirm` | `{ provider?, driver?{name?,phone?}, vehicleNumber?, vehicleModel?, fareEstimate?, tripNote?, pickup?, drop? }` (place = lat+lng and/or address) | `{ data: ride(status="confirmed", route resolved) }` | User corrects prefill; address geocoded; Google Directions with synthetic offline fallback. |
| POST | `/rides/:id/start` | `{ safetySessionId? }` | `{ data: ride(status="active", route, monitoring reset) }` | Begin monitoring; attaches to active safety session (or given one); emits `ride:started`, `ride:updated`. |
| POST | `/rides/:id/stop` | `{ status?(completed|cancelled), reason? }` | `{ data: ride }` | End trip; idempotent; emits `ride:updated`. |

**Service API:** `createRideFromUpload`, `getRide`, `listRides`, `confirmRide`, `startRide`, `stopRide`, `estimateDistance(a,b)`.
**Contribution:** the `monitoring` block on the ride is the persistent state for route deviation and long-stop detection; flags form the trip's safety trail.

### 2.4 monitoring (`src/modules/monitoring/`)
**Purpose:** pure detection. No escalation — results go to safetyEventBus → Person 1.

| Function | Input | Output | Contribution |
|---|---|---|---|
| `evaluateRidePoint({ rideId, point })` | active ride id + location point | `{ offRoute?, longStop? } \| null` | Single entry called by location service; persists ride mutations; each detector result is `{ type, event, metadata }`. |
| `checkOffRoute(ride, point)` | hydrated Ride + point | `{ type:"OFF_ROUTE", event, metadata } \| null` | Emits OFF_ROUTE after threshold exceeded on 3 consecutive pings (debounce), 60s cooldown; writes `ride.monitoring.flags`; increments session `eventCount`. metadata: distanceFromRoute, thresholdM, speed, accuracy. |
| `checkLongStop(ride, point)` | hydrated Ride + point | `{ type:"LONG_STOP", event, metadata } \| null` | LONG_STOP after still-within-30m anchor for 300s; resets on movement beyond radius; cooldown = stopSeconds. metadata: stopDurationSeconds, stopRadiusM, requiredSeconds, distanceFromAnchorM, speed. |

### 2.5 safePlace (`src/modules/safePlace/`)
**Purpose:** emergency services (hospital/police/fire_station/pharmacy) near a point or along a route.

| Method | Path | Input | Output | Contribution |
|---|---|---|---|---|
| GET | `/safe-places/nearby` | `lat`, `lng`, `radius?(≤50000, default 5000)`, `types?(csv)` | `{ data:[place], meta:{ source, googleMaps } }` | place = `{ placeId, name, lat, lng, types, vicinity, rating, distanceM }`. Client "find help near me". |
| GET | `/safe-places/route` | `origin="lat,lng"`, `destination="lat,lng"` | `{ data:[place+distanceFromRouteM], route, meta }` | Places along a trip route; de-duplicated by placeId, sorted by distance from route. |

`source` ∈ `google` | `mock` (never 500s — deterministic mock fallback when `GOOGLE_MAPS_API_KEY` missing).

### 2.6 crime (`src/modules/crime/`)
**Purpose:** seeded crime incidents for the safety heatmap.

**Model** `CrimeIncident`: `category(harassment|theft|robbery|assault|snatching|accident|unsafe-lighting|unsafe-isolated|other)`, `severity(1-5)`, `lat,lng, address, area, occurredAt, count, source(seed|report|import), notes`.

| Method | Path | Input | Output | Contribution |
|---|---|---|---|---|
| GET | `/crime/incidents` | `bbox="minLat,minLng,maxLat,maxLng"?, from?, to?, category?, minSeverity?, limit?(≤2000)` | `{ data:[incident], count }` | List view of incidents in a viewport. |
| GET | `/crime/heatmap` | `bbox?, cellDeg?(0.001–0.5, default 0.01), from?, to?, category?` | `{ cellDeg, totalIncidents, cells:[{lat,lng,incidents,score,avgSeverity,categories[],latest}] }` | Grid heatmap; cell score = Σ count×severity → UI radius/opacity. |
| GET | `/crime/categories` | — | `[{ category, incidents, avgSeverity }]` | Category filter chips. |

Seed with `npm run seed:crime` (`-- --clear` to reset).

### 2.7 transport (`src/modules/transport/`)
**Purpose:** transit/taxi/airport hubs near a point.

| Method | Path | Input | Output | Contribution |
|---|---|---|---|---|
| GET | `/transport/search` | `lat, lng, type?(transit|metro|bus|train|taxi|auto|airport|all), radius?, limit?(≤50)` | `{ data:[place+distanceM], meta:{ source, type, googleMaps } }` | In-app escape options. |
| GET | `/transport/types` | — | `[{ type, placesTypes }]` | Populating the type filter. |

`TRANSPORT_TYPES` maps each preset to Google Places types. Google-first with deterministic mock fallback (`source` ∈ google|mock).

### 2.8 test (`src/modules/test/`) — dev smoke
| Method | Path | Input | Output |
|---|---|---|---|
| POST | `/test/pings` | `{ message, source?, lat?, lng?, meta? }` | 201 `{ stored:true, dbState, data }` |
| GET | `/test/pings` | `limit?` | `{ count, data, dbState }` |
| GET | `/test/ping/:id` | — | `{ found, data }` |
| DELETE | `/test/pings` | — | `{ deleted }` |

### 2.9 users (`src/modules/users/user.model.js`) — Person 3, real document exists
`User`: `name, email(unique), phone, role(user|guardian|admin), isVerified, lastLoginAt, disabled, locale, emergencyNote, home{lat,lng,address}, preferences{guardianAlerts, autoSos, shareLocationOnSos, quietHours}, auth{provider, passwordHash, googleId}, timestamps`. Statics: `findByEmail`. Instance: `toSafeJSON()` (strips `auth`). **Person 2 modules store `userId` as the User `_id` string — don't change that coupling.**

### 2.10 Stub modules (Person 1/3 — not implemented, do not implement here)
`auth` (register/login/Google OAuth/JWT issue), `guardians` (contacts/invites), `sos` (+`sos.stateMachine.js` VERIFY→SOS→GUARDIAN→RESPONDER→EMERGENCY), `voice`, `assistant` (chat AI), `dashboard` (aggregate stats; may read Person 2 models), `feedback`. Each folder README documents the same integration points: safetyEventBus, middleware/auth.js, socket helpers.

---

## 3. HTTP Routes (full mount table, `src/app.js`)

| Mount | Auth | Routes |
|---|---|---|
| `GET /api/v1/health` | public | liveness + `db` state + `env` |
| `/uploads/*` | public static | locally stored images (Cloudinary fallback) |
| `/api/v1/safety-sessions` | Bearer/dev | §2.1 |
| `/api/v1/location` | Bearer/dev | §2.2 |
| `/api/v1/rides` | Bearer/dev | §2.3 |
| `/api/v1/safe-places` | Bearer/dev | §2.5 |
| `/api/v1/crime` | Bearer/dev | §2.6 |
| `/api/v1/transport` | Bearer/dev | §2.7 |
| `/api/v1/test` | none (dev) | §2.8 |

Not-mounted stubs: auth, users mgmt, guardians, sos, voice, assistant, dashboard, feedback (Person 1/3 mount when implemented).

---

## 4. Socket.IO — Complete Event Reference

**Connect:** `io(URL, { auth: { token } })` or dev `{ auth: { userId } }`. Auto-joins `user:{userId}`. maxHttpBufferSize 1MB.

### Client → Server
| Event | Payload | Ack | Effect |
|---|---|---|---|
| `location:subscribe` | `{ safetySessionId?, rideId? }` | `{ ok, joined[] }` | joins `session:` / `ride:` rooms. |
| `location:update` | `{ lat, lng, accuracy?, altitude?, speed?, heading?, recordedAt?, safetySessionId?, rideId? }` | `{ ok, id, recordedAt, monitors }` | persists ping (source "socket"), updates session.lastLocation, runs monitoring; broadcasts to other devices & session room. |
| `location:current` | `{ userId? }` | `{ ok, data }` | latest point for user. |
| `ride:subscribe` | `{ rideId }` | `{ ok, room }` | joins `ride:{rideId}`. |
| `ride:unsubscribe` | `{ rideId }` | `{ ok }` | leaves room. |

### Server → Client
| Event | Room | Payload | Trigger |
|---|---|---|---|
| `location:update` | `user:{id}` (others), `session:{id}` | `{ userId, id, lat,lng, accuracy, speed, heading, recordedAt, rideId, safetySessionId }` | any socket ping. |
| `ride:started` | `ride:{id}` | `{ rideId, userId, startedAt, route:{distanceM,durationS} }` | `POST /rides/:id/start`. |
| `ride:updated` | `ride:{id}`, `user:{id}` | `{ rideId, status, stoppedAt? }` | confirm/start/stop. |
| `ride:offRoute` | `ride:{id}`, `user:{id}`, `session:{id}` | `{ type,userId,safetySessionId,rideId,location,metadata,timestamp }` | OFF_ROUTE detection. |
| `ride:longStop` | same | same shape | LONG_STOP detection. |
| `ride:geofenceBreach` / `ride:arrived` / `ride:event` | same | same shape | other event types (future). |
| `safety:event` | `user:{id}` | same shape, includes `type` | **every** detection — parallel to the safetyEventBus stream. |

Bridge: `attachSafetyEventBridge(io)` (registered once in `initializeSocket`) fans every safetyEventBus event to sockets; server-side Person 1 consumes the same events via `onSafetyEvent`. **Don't double-subscribe from clients and services to the same room without room filtering.**

---

## 5. Third-Party Integrations (`src/integrations/`)

| Integration | File | Used by | Input | Output | Degradation |
|---|---|---|---|---|---|
| Google Maps | `googleMaps/googleMaps.js` | ride (route/geocode), safePlace, transport | `directions(origin,destination,{mode?,alternatives?})`, `geocode(address)`, `reverseGeocode(lat,lng)`, `placesNearby({lat,lng,radiusM,types,maxResults})`, `syntheticRoute(origin,destination)`, `isGoogleMapsConfigured()` | directions → `{ polyline[], distanceM, durationS, summary, steps[], source:"google", fetchedAt }`; geocode → `{ lat,lng,formattedAddress } \| null`; placesNearby → `[{ placeId,name,lat,lng,types,vicinity,rating }]` | throws `GoogleMapsUnavailableError` (code `GOOGLE_MAPS_UNAVAILABLE`); callers fall back to `syntheticRoute` / mock places. |
| OCR | `ocr/ocr.js` | ride upload | `extractText(buffer)`, `extractRideFields(buffer)`, `parseRideFields(text)` (pure regex) | `{ text, fields:{ vehicleNumber?, driverPhone?, driverName?, vehicleModel?, fareEstimate?, tripOtp? }, error }` — never throws | returns `{ text:"", fields:{}, error }`. |
| Groq AI extract | `ai/groqExtract.js` | ride upload | `extractRideFieldsWithAI(ocrText)` → POSTs `{GROQ_BASE_URL}/chat/completions`, model `GROQ_MODEL`, json_object response | `{ fields:{ provider,driverName,driverPhone,vehicleNumber,vehicleModel,fareEstimate,tripOtp,pickup,drop,tripNote } \| null, error }` — merges over OCR fields in controller | `{ fields:null, error:"GROQ_API_KEY not set" \| "no OCR text" \| http error }`. |
| Cloudinary | `cloudinary/cloudinary.js` + `config/cloudinary.js` | ride upload | `uploadImage(buffer,{ folder?, originalName? })`, `destroyImage(publicId)`, `isCloudinaryConfigured()` | `{ publicId, url, bytes, format }` | stores to local `uploads/` and returns `/uploads/...` URL. |
| LiveKit / ZegoCloud | `calling/livekit.js`, `calling/zegocloud.js` | Person 1 | — | token generation (stub) | — |
| Tavily / Transcriber / Translator | `tavily/`, `transcriber/`, `translator/` | Person 3 | — | — | — |

**Voucher/TTL/paths:** OCR language data via `OCR_LANG`; `eng.traineddata` at repo root; uploaded images served from `/uploads`.

---

## 6. Background Jobs (`src/jobs/`)
- `sosEscalation.job.js` — Person 1 stub: scheduled SOS escalation timeouts.
- `voiceBatch.job.js` — Person 3 stub: scheduled batch voice processing.
Neither is scheduled yet; nothing in Person 2 code starts timers.

---

## 7. Data Flow (end-to-end, for tracing bugs)

```
POST /api/v1/rides/upload (multipart)
  → uploadImage (Cloudinary | local)
  → extractRideFields (tesseract OCR) ─┐
  → extractRideFieldsWithAI (Groq) ────┤ merge → createRideFromUpload → Ride(status="uploaded")
POST /rides/:id/confirm → geocode pickup/drop → directions → route; status="confirmed"
POST /rides/:id/start → attach safety session, resetMonitoring, status="active", emit ride:started
POST /location (or socket location:update)
  → LocationPoint.create
  → safetySession.updateLastLocation
  → monitoring.evaluateRidePoint
      ├─ routeMonitor.checkOffRoute → safetyEventBus.emit(OFF_ROUTE)
      └─ stopDetector.checkLongStop → safetyEventBus.emit(LONG_STOP)
            ├─ ride.monitoring.flags append + persisted
            ├─ safetySession.eventCount += 1
            └─ server→client: ride:offRoute / ride:longStop / safety:event
Person 1 (SOS) listens via onSafetyEvent — owns VERIFY → SOS → guardians → responders.
```

---

## 8. Ownership Map (who edits what)

| Scope | Owner | Files |
|---|---|---|
| Location, safetySession, ride, safePlace, crime, transport, monitoring | Person 2 | the `modules/*` folders above |
| googleMaps, ocr, cloudinary, upload middleware | Person 2 | `integrations/*`, `middleware/upload.js` |
| socket.js, location.socket.js, ride.socket.js | Person 2 | `socket/` |
| safetyEventBus, distance/geo utils, logger | shared | `utils/` |
| auth middleware internals, users model | Person 3 | `middleware/auth.js`, `modules/users/` |
| auth/users/voice/assistant/dashboard/feedback modules, ai/tavily/transcriber/translator, voiceBatch job | Person 3 | stubs |
| guardians, sos (+stateMachine), sosEscalation job, sos.socket, calling.socket, livekit/zegocloud | Person 1 | stubs |

Shared contracts to never break: auth exports, `onSafetyEvent/emitSafetyEvent` payload shape, socket room names (`user:`/`session:`/`ride:`), `getIO/emitToUser/emitToRide/emitToSession`, `User._id` stored as `userId` everywhere, `AppError` codes, zod validation envelope.

---

## 9. Scripts & Verification

| Command | Purpose |
|---|---|
| `npm run dev` | `node --watch src/server.js` |
| `npm start` | production boot |
| `npm run check` | `node --check` every src file (syntax gate) |
| `npm run smoke` | end-to-end HTTP+socket test (server must be running) |
| `npm run seed:crime` | load demo crime incidents (`-- --clear`) |
| `npm run seed:demo` / `npm run db` / `npm run test:user` | demo seeding / local mongo-memory-server |

Run `npm run check` after edits; run `npm run smoke` after boot. No lint/format config in repo.

---

## 10. Integration Checklist for Teammates

1. Point your handlers at `onSafetyEvent` / `emitSafetyEvent` — don't emit `safety:event` directly; go through the bus.
2. Auth: issue JWTs signed with `JWT_SECRET` with `{ sub: userId }`; HTTP `x-user-id` only works when `NODE_ENV != production`.
3. Reference rides/sessions by their Mongo `_id`; `userId` is the `User._id` string.
4. Emit to clients only via `emitToUser / emitToRide / emitToSession` or rooms — never hardcode room strings differently.
5. On any Google/Cloudinary/Groq failure, expect graceful degradation (`source:"mock"`, `warnings[]`, local `/uploads` URL, `fields:null`) rather than 500s.
6. Never escalate from Person 2 code — detection only; SOS decisions belong to Person 1.
