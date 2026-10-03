export type Intent = "emergency" | "travel" | "ride" | "guardian" | "location" | "status" | "general";
export type AgentStep = { name: string; detail: string };

export function identifyIntent(text: string, previous: Intent = "general"): Intent {
  const t = text.toLowerCase();
  if (/\b(sos|emergency|danger|attack|help me|need help|not safe|fire|heart rate alert|shake alert)\b/.test(t)) return "emergency";
  if (/\b(ride|uber|ola|cab|driver|pickup|book a car|stopped)\b/.test(t)) return "ride";
  if (/\b(guardian|mother|father|contact|family|him|her|notify)\b/.test(t)) return "guardian";
  if (/\b(route|travel|flight|train|bus|cheaper|fastest|safest|reach|go to|from .+ to )\b/.test(t)) return "travel";
  if (/\b(where am i|my location|locate me|map)\b/.test(t)) return "location";
  if (/\b(status|risk|heart rate|safety score|pulse)\b/.test(t)) return "status";
  if (/\b(cheaper|faster|alternative|what about|another option)\b/.test(t) && previous !== "general") return previous;
  return "general";
}

export const flows: Record<Intent, AgentStep[]> = {
  emergency: [
    { name: "SOS Orchestrator", detail: "Organizing a preview response" },
    { name: "Location Agent", detail: "Location permission needed for a real position" },
    { name: "Guardian Agent", detail: "Showing contacts; no message sent" },
    { name: "Response Agent", detail: "Displaying next-step guidance" },
  ],
  travel: [
    { name: "Travel Planner", detail: "Understanding origin and destination" },
    { name: "Flight / Train / Bus", detail: "Live schedules and prices not connected" },
    { name: "Road Agent", detail: "Mapping route concepts" },
    { name: "Optimization Agent", detail: "Presenting comparison preview" },
  ],
  ride: [
    { name: "Ride Agent", detail: "Preparing booking-flow preview" },
    { name: "Context Agent", detail: "Explaining route and stop checks" },
    { name: "Safety Agent", detail: "Displaying safety checks; no live tracking" },
  ],
  guardian: [
    { name: "Guardian Agent", detail: "Opening linked-contact preview" },
    { name: "Travel Agent", detail: "Showing travel-planning options" },
  ],
  location: [
    { name: "Location Agent", detail: "Browser permission required on map" },
    { name: "Map Agent", detail: "Showing map preview" },
  ],
  status: [
    { name: "Vitals Agent", detail: "Reading sample dashboard values" },
    { name: "Risk Agent", detail: "Explaining simulated risk score" },
  ],
  general: [{ name: "Assistant", detail: "Responding to your question" }],
};

export const destinationFor: Partial<Record<Intent, string>> = {
  emergency: "/", travel: "/routes", ride: "/ride", guardian: "/guardians", location: "/", status: "/",
};

export const labelFor: Partial<Record<Intent, string>> = {
  emergency: "Open SOS preview", travel: "Explore routes", ride: "Open safe ride", guardian: "View guardians", location: "Open location map", status: "View dashboard",
};