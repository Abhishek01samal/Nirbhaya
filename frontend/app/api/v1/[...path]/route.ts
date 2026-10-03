import { createHmac } from "crypto";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BACKEND = (process.env.BACKEND_URL || "http://localhost:4000").replace(/\/$/, "");
const DEMO_USER = process.env.BACKEND_DEMO_USER_ID || "64a1b2c3d4e5f60718293a4b";
const JWT_SECRET = process.env.BACKEND_JWT_SECRET || "";

function b64url(value: string | Buffer) {
  return Buffer.from(value).toString("base64url");
}

function demoToken() {
  if (!JWT_SECRET) return "";
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({
      sub: DEMO_USER,
      id: DEMO_USER,
      role: "USER",
      iat: now,
      exp: now + 60 * 60 * 12,
    }),
  );
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}

async function proxy(request: NextRequest, path: string[]) {
  const search = request.nextUrl.search || "";
  const target = `${BACKEND}/api/v1/${path.join("/")}${search}`;
  const headers = new Headers();
  const incomingType = request.headers.get("content-type");
  if (incomingType) headers.set("content-type", incomingType);
  const token = demoToken();
  if (token) headers.set("authorization", `Bearer ${token}`);

  const method = request.method.toUpperCase();
  const init: RequestInit = { method, headers };
  if (method !== "GET" && method !== "HEAD") {
    init.body = Buffer.from(await request.arrayBuffer());
  }

  try {
    const upstream = await fetch(target, init);
    const body = await upstream.arrayBuffer();
    const out = new NextResponse(body, { status: upstream.status });
    const type = upstream.headers.get("content-type");
    if (type) out.headers.set("content-type", type);
    return out;
  } catch {
    return NextResponse.json(
      { success: false, error: { code: "BACKEND_UNREACHABLE", message: "SafePulse API is not reachable." } },
      { status: 502 },
    );
  }
}

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
export async function POST(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
export async function PATCH(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
export async function PUT(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
export async function DELETE(request: NextRequest, ctx: Ctx) {
  return proxy(request, (await ctx.params).path);
}
