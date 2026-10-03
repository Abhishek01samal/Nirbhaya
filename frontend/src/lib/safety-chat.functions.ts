import { createServerFn } from "@tanstack/react-start";

type ChatMessage = { role: "user" | "assistant"; content: string };

export const askSafetyAssistant = createServerFn({ method: "POST" })
  .inputValidator((input: { messages: ChatMessage[]; context?: string }) => input)
  .handler(async ({ data }) => {
    const messages = (data.messages || []).slice(-12).filter(m =>
      (m.role === "user" || m.role === "assistant") && typeof m.content === "string"
    ).map(m => ({ role: m.role, content: m.content.slice(0, 1200) }));
    if (!messages.length) throw new Error("Message required");
    const key = process.env["AI_API_KEY"];
    if (!key) throw new Error("AI service is unavailable");
    const base = (process.env["AI_BASE_URL"] || "https://api.openai.com/v1").replace(/\/$/, "");
    const model = process.env["AI_MODEL"] || "gpt-4o-mini";
    const response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0.45,
        max_tokens: 320,
        messages: [
          { role: "system", content: `You are Nirbhaya's conversational safety assistant in a FRONTEND PREVIEW. Be concise, grounded and reassuring. Never claim to have contacted guardians, emergency services, booked rides, retrieved live fares, read sensors, monitored location, or verified a safe route. No agents or integrations execute here. The interface displays simulated agent activity only. You may help users navigate the demo and reason about general safety. If there is immediate danger, advise contacting local emergency services directly and moving to safety if possible. If asked for prices, availability, locations or risk, say live data is unavailable. Remember relevant origin, destination and preferences from the conversation. Do not invent facts. Plain text only, 2-4 short sentences. Current preview context: ${(data.context || "none").slice(0, 400)}` },
          ...messages,
        ],
      }),
      signal: AbortSignal.timeout(18000),
    });
    if (!response.ok) throw new Error(`AI service unavailable (${response.status})`);
    const json = await response.json();
    return String(json.choices?.[0]?.message?.content || "I couldn't produce a response right now.");
  });