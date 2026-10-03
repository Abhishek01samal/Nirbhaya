export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;

  constructor(message: string, status: number, code?: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

type Envelope<T> = {
  success?: boolean;
  data?: T;
  route?: unknown;
  meta?: unknown;
  count?: number;
  warnings?: string[];
  error?: { code?: string; message?: string; details?: unknown };
};

async function parseJson<T>(response: Response): Promise<Envelope<T>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Envelope<T>;
  } catch {
    return {};
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const body = init.body;
  const headers = new Headers(init.headers);
  if (body && !(body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const baseUrl = (typeof window !== "undefined" && window.location.port !== "4000")
    ? "http://localhost:4000/api/v1"
    : "/api/v1";

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, { ...init, headers });
  } catch {
    response = await fetch(`/api/v1${path}`, { ...init, headers });
  }
  const json = await parseJson<T>(response);

  if (!response.ok) {
    throw new ApiError(
      json.error?.message || `Request failed (${response.status})`,
      response.status,
      json.error?.code,
      json.error?.details ?? json,
    );
  }

  return (json.data as T) ?? (json as T);
}

export async function apiRaw<T>(path: string, init: RequestInit = {}): Promise<Envelope<T>> {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api/v1${path}`, { ...init, headers });
  const json = await parseJson<T>(response);
  if (!response.ok) {
    throw new ApiError(
      json.error?.message || `Request failed (${response.status})`,
      response.status,
      json.error?.code,
      json.error?.details ?? json,
    );
  }
  return json;
}

export type GeoPoint = { lat: number; lng: number; address?: string; accuracy?: number };

export type SosRecord = {
  id: string;
  status: string;
  triggerType: string;
  location?: GeoPoint | null;
  triggerData?: { riskLevel?: string; confidence?: number; reason?: string } | null;
  escalation?: { currentLevel: number; levels: Array<{ type?: string; status?: string }> };
  createdAt?: string;
};

export type GuardianRecord = {
  id: string;
  guardianUserId: string;
  relationship: string;
  priority: number;
  status: string;
};

export type PlaceRecord = {
  placeId?: string;
  name: string;
  type?: string;
  lat: number;
  lng: number;
  vicinity?: string;
  distanceM?: number;
  distanceFromRouteM?: number;
};

export type RouteMeta = {
  distanceM?: number;
  durationS?: number;
  summary?: string;
  polyline?: GeoPoint[];
};

export type CrimeIncident = {
  category?: string;
  severity?: number;
  lat: number;
  lng: number;
  address?: string;
  area?: string;
  occurredAt?: string;
};

export type HeatCell = { lat: number; lng: number; score: number; count?: number };

export type TransportOption = {
  title?: string;
  url?: string;
  content?: string;
  price?: string;
  duration?: string;
};

export const sosApi = {
  create: (payload: {
    triggerType: "MANUAL" | "VOICE_DANGER" | "OFF_ROUTE" | "LONG_STOP";
    location?: GeoPoint;
    triggerData?: { riskLevel?: string; confidence?: number; reason?: string };
  }) => api<SosRecord>("/sos", { method: "POST", body: JSON.stringify(payload) }),
  active: () => api<{ active: boolean; sos: SosRecord | null }>("/sos/active"),
  history: () => api<{ items?: SosRecord[]; sos?: SosRecord[] } | SosRecord[]>("/sos/history"),
  confirm: (id: string) => api<SosRecord>(`/sos/${id}/confirm`, { method: "POST" }),
  cancel: (id: string) => api<SosRecord>(`/sos/${id}/cancel`, { method: "POST" }),
  resolve: (id: string) => api<SosRecord>(`/sos/${id}/resolve`, { method: "POST" }),
  startEscalation: (id: string) => api<unknown>(`/sos/${id}/escalation/start`, { method: "POST" }),
  notifyResponders: (id: string) => api<unknown>(`/sos/${id}/responders/notify`, { method: "POST" }),
};

export const guardianApi = {
  list: () => api<{ guardians: GuardianRecord[] }>("/guardians"),
  create: (payload: { guardianUserId: string; relationship: string; priority: number }) =>
    api<{ guardian: GuardianRecord }>("/guardians", { method: "POST", body: JSON.stringify(payload) }),
  update: (id: string, payload: { relationship?: string; priority?: number }) =>
    api<{ guardian: GuardianRecord }>(`/guardians/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
  remove: (id: string) => api<{ guardian: GuardianRecord }>(`/guardians/${id}`, { method: "DELETE" }),
  accept: (id: string) => api<{ guardian: GuardianRecord }>(`/guardians/${id}/accept`, { method: "POST" }),
};

export const mapApi = {
  nearbyPlaces: (lat: number, lng: number, radius = 5000) =>
    apiRaw<PlaceRecord[]>(`/safe-places/nearby?lat=${lat}&lng=${lng}&radius=${radius}`),
  alongRoute: (origin: GeoPoint, destination: GeoPoint) =>
    apiRaw<PlaceRecord[]>(
      `/safe-places/route?origin=${origin.lat},${origin.lng}&destination=${destination.lat},${destination.lng}`,
    ),
  crimeIncidents: (bbox: string) => apiRaw<CrimeIncident[]>(`/crime/incidents?bbox=${encodeURIComponent(bbox)}&limit=200`),
  crimeHeatmap: (bbox: string) => api<HeatCell[] | { cells: HeatCell[] }>(`/crime/heatmap?bbox=${encodeURIComponent(bbox)}&cellDeg=0.02`),
  transport: (lat: number, lng: number, type = "all") =>
    api<PlaceRecord[]>(`/transport/search?lat=${lat}&lng=${lng}&type=${type}&limit=12`),
  emergencyTravel: (victimLocation: GeoPoint, guardianLocation: GeoPoint) =>
    api<{
      source: { name?: string; city?: string; coordinates: GeoPoint };
      destination: { name?: string; city?: string; coordinates: GeoPoint };
      transport: { flights: TransportOption[]; trains: TransportOption[]; cabs: TransportOption[] };
      transportErrors?: Record<string, string | null>;
    }>("/emergency/transport/search", {
      method: "POST",
      body: JSON.stringify({ victimLocation, guardianLocation }),
    }),
};

export const sessionApi = {
  start: (payload: { mode?: "walk" | "ride" | "static" | "travel"; origin?: GeoPoint; destination?: GeoPoint; note?: string }) =>
    api<{ _id?: string; id?: string; status?: string; mode?: string }>("/safety-sessions", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  active: () => api<{ _id?: string; id?: string; status?: string } | null>("/safety-sessions/active"),
  end: (id: string) => api(`/safety-sessions/${id}/end`, { method: "POST", body: JSON.stringify({ status: "ended" }) }),
};

export const locationApi = {
  ping: (point: GeoPoint & { safetySessionId?: string; rideId?: string }) =>
    api("/location", { method: "POST", body: JSON.stringify(point) }),
  current: (userId: string) => api<GeoPoint | null>(`/location/current/${userId}`),
};

export const rideApi = {
  upload: (file: File) => {
    const form = new FormData();
    form.append("screenshot", file);
    return api<{ _id?: string; id?: string; status?: string }>("/rides/upload", { method: "POST", body: form });
  },
  confirm: (id: string, payload: { pickup?: GeoPoint & { address?: string }; drop?: GeoPoint & { address?: string }; tripNote?: string }) =>
    api(`/rides/${id}/confirm`, { method: "POST", body: JSON.stringify(payload) }),
  start: (id: string, safetySessionId?: string) =>
    api(`/rides/${id}/start`, { method: "POST", body: JSON.stringify({ safetySessionId }) }),
  stop: (id: string) => api(`/rides/${id}/stop`, { method: "POST", body: JSON.stringify({ status: "completed" }) }),
  list: () => api<unknown[]>("/rides"),
};

export const responderApi = {
  nearby: () => api<{ responders?: Array<{ id: string; name: string; phone: string; status: string }> } | Array<{ id: string; name: string; phone: string; status: string }>>("/responders/nearby"),
};

export const assistantApi = {
  chat: (sessionId: string, message: string) =>
    api<{ reply: string; sessionId: string }>("/assistant/chat", {
      method: "POST",
      body: JSON.stringify({ sessionId, message }),
    }),
};

export async function backendHealth() {
  try {
    const response = await fetch("/api/pulse-health");
    const json = (await response.json()) as { ok?: boolean };
    return Boolean(json.ok);
  } catch {
    return false;
  }
}
