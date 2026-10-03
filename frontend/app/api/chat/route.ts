import { NextResponse } from "next/server";

type ChatMessage = { role: "user" | "assistant"; content: string };

const SYSTEM = `You are Nirbhaya's conversational safety assistant in a FRONTEND PREVIEW. Be concise, grounded and reassuring. Never claim to have contacted guardians, emergency services, booked rides, retrieved live fares, read sensors, monitored location, or verified a safe route. No agents or integrations execute here. The interface displays simulated agent activity only. You may help users navigate the demo and reason about general safety. If there is immediate danger, advise contacting local emergency services directly and moving to safety if possible. If asked for prices, availability, locations or risk, say live data is unavailable. Remember relevant origin, destination and preferences from the conversation. Do not invent facts. Plain text only, 2-4 short sentences.`;

function demoReply(messages: ChatMessage[], context: string) {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content.toLowerCase() ?? "";
  if (/\b(sos|emergency|danger|help me|fire|attack)\b/.test(last)) {
    return "If you are in immediate danger, call your local emergency number now and move to a safer place if you can. This preview has not sent an alert. You can walk through the SOS workflow on the dashboard.";
  }
  if (/\b(guardian|family|contact)\b/.test(last)) {
    return "Open the Guardians page to add trusted contacts and set escalation order. Changes stay on this device only, and no messages are sent in this preview.";
  }
  if (/\b(ride|uber|ola|cab)\b/.test(last)) {
    return "Use Safe Ride to preview stop and route checks. Booking, tracking, and payments are not connected in this demo.";
  }
  if (/\b(route|travel|flight|train)\b/.test(last)) {
    return "The Routes page shows a planning preview, including an example guardian journey. Live traffic, fares, and bookings are not available here.";
  }
  if (context.toLowerCase().includes("emergency")) {
    return "This is an SOS preview only. No contacts or services were notified. Use the dashboard to see how agents would sequence a response.";
  }
  return "I can help you explore Nirbhaya: dashboard signals, guardians, routes, and the ride safety preview. Nothing here is live monitoring. What would you like to look at?";
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { messages?: ChatMessage[]; context?: string };
    const messages = (body.messages || [])
      .slice(-12)
      .filter(
        (m) =>
          (m.role === "user" || m.role === "assistant") && typeof m.content === "string",
      )
      .map((m) => ({ role: m.role, content: m.content.slice(0, 1200) }));
    if (!messages.length) {
      return NextResponse.json({ error: "Message required" }, { status: 400 });
    }

    const context = (body.context || "none").slice(0, 400);
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      return NextResponse.json({ reply: demoReply(messages, context) });
    }

    const base = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.45,
        max_tokens: 320,
        messages: [
          { role: "system", content: `${SYSTEM} Current preview context: ${context}` },
          ...messages,
        ],
      }),
      signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) {
      return NextResponse.json({ reply: demoReply(messages, context) });
    }
    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const reply = String(json.choices?.[0]?.message?.content || demoReply(messages, context));
    return NextResponse.json({ reply });
  } catch {
    return NextResponse.json({ error: "Assistant unavailable right now." }, { status: 500 });
  }
}
