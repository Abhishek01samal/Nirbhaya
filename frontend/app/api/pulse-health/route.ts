import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const base = (process.env.BACKEND_URL || "http://localhost:4000").replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/health`, { cache: "no-store" });
    const json = (await response.json()) as { success?: boolean };
    return NextResponse.json({ ok: response.ok && json.success !== false });
  } catch {
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
