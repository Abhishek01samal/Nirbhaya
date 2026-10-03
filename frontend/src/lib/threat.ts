const GROUPS: { category: string; services: string[]; words: string[] }[] = [
  { category: "Fire", services: ["Fire", "Hospital"], words: ["fire", "burning", "smoke", "on fire"] },
  { category: "Medical emergency", services: ["Hospital"], words: ["injured", "can't breathe", "bleeding", "doctor", "heart attack"] },
  { category: "Physical attack", services: ["Police", "Hospital"], words: ["attack", "hurting me", "following me", "don't touch me", "stop"] },
  { category: "General distress", services: ["Police"], words: ["help", "save me", "emergency", "please help"] },
];
const NEGATORS = ["movie", "game", "joke", "show", "watching", "all good", "just kidding", "song"];

export function analyzeSpeech(text: string) {
  const lower = text.toLowerCase();
  const hits: string[] = [];
  const scores = GROUPS.map((g) => {
    const found = g.words.filter((w) => lower.includes(w));
    hits.push(...found);
    return { ...g, score: found.length };
  });
  const negated = NEGATORS.some((n) => lower.includes(n));
  const urgency = (text.match(/!/g)?.length ?? 0) + (/\b(me|my)\b/i.test(text) ? 1 : 0);
  const best = scores.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || GROUPS.indexOf(a) - GROUPS.indexOf(b))[0];
  if (!best || negated) {
    return { category: "No emergency", services: [] as string[], confidence: best ? 12 : 4, hits, reason: negated ? "Keywords found, but the context (e.g. a movie) suggests no real danger." : "No distress language detected." };
  }
  const confidence = Math.min(98, 45 + hits.length * 12 + urgency * 6);
  return { category: best.category, services: best.services, confidence, hits, reason: `Matched ${hits.length} distress indicator(s) in first-person, urgent context.` };
}
