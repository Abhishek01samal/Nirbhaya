import { GROQ_API_KEY, GROQ_BASE_URL, GROQ_MODEL } from "../../config/env.js";

const SYSTEM_PROMPT = `You extract structured ride details from OCR text of a ride screenshot (Uber/Ola/Rapido). Respond with ONLY JSON: {"provider":..., "driverName":..., "driverPhone":..., "vehicleNumber":..., "vehicleModel":..., "fareEstimate": number|null, "tripOtp":..., "pickup": string, "drop": string, "tripNote": string}. Use null/empty when unknown.`;

export async function extractRideFieldsWithAI(text) {
  if (!text || !text.trim()) return { fields: null, error: "empty OCR text" };
  if (!GROQ_API_KEY) return { fields: null, error: "GROQ_API_KEY not configured" };

  try {
    const res = await fetch(`${GROQ_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: text.slice(0, 4000) },
        ],
      }),
    });
    if (!res.ok) return { fields: null, error: `groq status ${res.status}` };
    const payload = await res.json();
    const content = payload?.choices?.[0]?.message?.content ?? "";
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return { fields: null, error: "unparseable AI response" };
    return { fields: JSON.parse(match[0]), error: null };
  } catch (err) {
    return { fields: null, error: err.message };
  }
}
