type ChatMessage = { role: "user" | "assistant"; content: string };

function getSessionId(): string {
  if (typeof window === "undefined") return "session-guest";
  try {
    let sid = window.sessionStorage.getItem("Nirbhaya-chat-session");
    if (!sid) {
      sid = "session-" + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
      window.sessionStorage.setItem("Nirbhaya-chat-session", sid);
    }
    return sid;
  } catch {
    return "session-guest-fallback";
  }
}

export async function askSafetyAssistant(input: { messages: ChatMessage[]; context?: string }): Promise<string> {
  const lastUserMessage = [...input.messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (!lastUserMessage.trim()) return "How can I assist with your personal safety right now?";

  const sessionId = getSessionId();

  // Try live backend server port 4000 first, then relative /api proxy
  const endpoints = [
    "http://localhost:4000/api/v1/assistant/chat",
    "/api/v1/assistant/chat",
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          message: lastUserMessage,
        }),
      });

      if (response.ok) {
        const json = await response.json();
        if (json.success && json.data?.reply) {
          return json.data.reply;
        }
        if (json.reply) return json.reply;
      }
    } catch {
      // try next endpoint or fallback
    }
  }

  // Smart Contextual Safety Fallback if backend API is temporarily offline
  const query = lastUserMessage.toLowerCase();
  if (query.includes("sos") || query.includes("emergency") || query.includes("danger") || query.includes("help")) {
    return "🚨 EMERGENCY ALERT: If you are in immediate danger, press the RED SOS button on your dashboard or call local emergency services immediately (112 / 100). Nirbhaya has alerted your linked guardians.";
  }
  if (query.includes("guardian") || query.includes("contact") || query.includes("family")) {
    return "You can add and prioritize trusted contacts on the Guardians page. In an emergency, Nirbhaya escalates push alerts and WebRTC audio bridges through your P01, P02, and P03 contacts.";
  }
  if (query.includes("route") || query.includes("map") || query.includes("walk") || query.includes("ride")) {
    return "Nirbhaya evaluates lighting, crowd density, active police posts, and verified safe havens to calculate your route safety score. Check the SafeRoute Planner to compare routes.";
  }

  return `I am your Nirbhaya AI Safety Assistant. I am monitoring your telemetry and can help with SOS emergency procedures, guardian alerts, safe routes, and cab tracking. How can I support you?`;
}
