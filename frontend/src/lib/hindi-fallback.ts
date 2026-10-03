// Zero-config Hindi/Hinglish -> English gloss used when no AI key is configured.
// Deliberately small and safety-focused: it maps the phrases a person is most
// likely to shout during an emergency into the English words that
// `analyzeSpeech` in ./threat.ts actually matches on, so a real Hindi cry for
// help still drives the SOS classification instead of scoring zero.

const DICTIONARY: Record<string, string> = {
  // general distress
  मदद: "help",
  "मदद करो": "help me",
  "मदद कीजिए": "help me",
  बचाओ: "save me",
  "बचाओ मुझे": "save me",
  इमरजेंसी: "emergency",
  आपातकाल: "emergency",
  "मदद की जरूरत": "i need help",
  "मेरी मदद": "i need help",

  // fire
  आग: "fire",
  "आग लगी": "there is fire",
  "आग लग गई": "the house is on fire",
  धुआं: "smoke",
  धुएं: "smoke",
  "जल रहा": "burning",

  // medical
  चोट: "injured",
  "मेरी चोट": "i am injured",
  खून: "bleeding",
  "खून बह रहा": "i am bleeding",
  "सांस नहीं": "i can't breathe",
  दर्द: "pain",
  डॉक्टर: "doctor",
  "हाथ सेटी": "i need a doctor",
  "हाथ सेटो": "i need a doctor",
  "दिल का दौरा": "heart attack",
  बेहोश: "unconscious",
  "बेहोश हो": "i am unconscious",

  // physical attack / theft
  "मुझे मार रहा": "hurting me",
  "मुझे मार रहे": "hurting me",
  मारा: "attacked me",
  पीट: "beating me",
  "पीट रहा": "beating me",
  "लड़ रहा": "fighting me",
  "मुझे छोड़ो": "leave me alone",
  "छोड़ो मुझे": "leave me alone",
  "छू मत": "don't touch me",
  चोरी: "robbery",
  लूट: "robbery",
  "ले रहा": "snatching my bag",
  "मेरी चीज़": "my belongings",

  // being followed / trapped
  पीछे: "behind me",
  "मेरे पीछे": "following me",
  पीछा: "following me",
  फंसा: "trapped",
  "फंसा हुआ": "i am trapped",
  "अंदर बंद": "locked inside",
  ताला: "locked",

  // reassurance / false-alarm context
  "ठीक हूं": "i am fine",
  "सब ठीक": "all good",
  "कुछ नहीं": "nothing is wrong",
  फिल्म: "movie",
  "फिल्म देख": "watching a movie",
  मज़ाक: "joke",
  "मजाक कर": "just kidding",
};

const KEYS = Object.keys(DICTIONARY).sort((a, b) => b.length - a.length);

const NON_LATIN = /(?!\p{Script=Latin})[\p{L}\p{M}]/u;

export function isNonLatinScript(text: string): boolean {
  return NON_LATIN.test(text);
}

/**
 * Greedy longest-match gloss. Returns null when nothing in the dictionary is
 * recognised, so callers can tell "we translated it" from "we have no idea".
 * Unmapped non-Latin characters are dropped rather than passed through, so the
 * English result never contains leftover Devanagari mixed into a sentence.
 */
export function hindiToEnglish(text: string): string | null {
  if (!text.trim()) return null;
  let out = "";
  let matched = 0;
  let i = 0;
  while (i < text.length) {
    const hit = KEYS.find((k) => text.startsWith(k, i));
    if (hit) {
      out += `${DICTIONARY[hit]} `;
      i += hit.length;
      matched++;
      continue;
    }
    const char = text[i] as string;
    if (!isNonLatinScript(char)) out += char;
    i += 1;
  }
  if (matched === 0) return null;
  return out.replace(/\s+/g, " ").trim();
}
