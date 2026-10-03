import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim() || "";
  if (q.length < 2) {
    return NextResponse.json({ error: "Query required" }, { status: 400 });
  }

  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`;
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Nirbhaya/1.0 (hackathon safety app)",
      },
      cache: "no-store",
    });
    const data = (await response.json()) as Array<{
      lat: string;
      lon: string;
      display_name: string;
    }>;
    return NextResponse.json({
      results: (data || []).map((item) => ({
        lat: Number(item.lat),
        lng: Number(item.lon),
        address: item.display_name,
      })),
    });
  } catch {
    return NextResponse.json({ results: [] });
  }
}
