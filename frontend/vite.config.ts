// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - TanStack devtools (dev-only, first), tanstackStart, viteReact, tailwindcss, tsConfigPaths,
//     nitro (build-only using cloudflare as a default target), VITE_* env injection, @ path alias,
//     React/TanStack dedupe, error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv, type Connect } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";

const env = loadEnv("development", process.cwd(), "");

// /api/transcribe is answered locally: the Express backend (proxy target) has
// no such route, so without this middleware the upload is proxied and 404s.
const transcribeMiddleware = (env: Record<string, string>): Connect.NextHandleFunction => {
  const enabled = Boolean(env.GROQ_API_KEY);
  const base = (env.GROQ_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
  const model = env.GROQ_MODEL || "whisper-large-v3";

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };

  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith("/api/transcribe")) return next();

    if (req.method === "GET") {
      send(res, 200, { enabled });
      return;
    }
    if (req.method !== "POST") {
      send(res, 405, { error: "Method not allowed" });
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const request = new Request("http://localhost/api/transcribe", {
        method: "POST",
        headers: { "content-type": req.headers["content-type"] ?? "" },
        body: Buffer.concat(chunks),
      });
      const form = await request.formData();
      const file = form.get("audio");
      if (!(file instanceof File) || file.size === 0 || !file.type.startsWith("audio/")) {
        send(res, 400, { error: "Valid audio file required" });
        return;
      }
      const language = String(form.get("language") || "auto").trim().slice(0, 8);
      if (!env.GROQ_API_KEY) {
        send(res, 503, { reason: "no_key" });
        return;
      }
      const upstream = new FormData();
      upstream.append("file", file, file.name || "clip.webm");
      upstream.append("model", model);
      upstream.append("response_format", "verbose_json");
      if (language && language !== "auto") upstream.append("language", language);

      const response = await fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: upstream,
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        send(res, 502, { error: "Transcription service unavailable", upstream: response.status });
        return;
      }
      const json = (await response.json()) as { text?: string; language?: string };
      send(res, 200, {
        original: String(json.text || "").trim(),
        language: String(json.language || "unknown"),
        source: "groq",
      });
    } catch {
      send(res, 500, { error: "Transcription unavailable right now." });
    }
  };
};

export default defineConfig({
  vite: {
    plugins: [
      {
        name: "local-transcribe-api",
        configureServer(server) {
          server.middlewares.use(transcribeMiddleware(env));
        },
      },
    ],
    server: {
      proxy: {
        "/api": {
          target: "http://localhost:4000",
          changeOrigin: true,
          // The local middleware above answers /api/transcribe first; everything
          // else under /api is proxied to the Express backend.
        },
      },
    },
  },
  tanstackStart: {
    // Redirect TanStack Start's bundled server entry to src/server.ts (our SSR error wrapper).
    // nitro/vite builds from this
    server: { entry: "server" },
  },
});
