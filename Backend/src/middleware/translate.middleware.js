import { TRANSLATE_ENABLED, GEMINI_API_KEY } from "../config/env.js";
import { translateToEnglish } from "../modules/person3Services/geminiTranslate.service.js";

const MAX_TRANSLATION_LENGTH = 5000;

async function translateToEnglishMiddleware(req, res, next) {
  if (!TRANSLATE_ENABLED || !GEMINI_API_KEY) {
    return next();
  }

  const transcription = req.body?.transcription;
  if (typeof transcription !== "string") {
    return next();
  }

  const trimmed = transcription.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TRANSLATION_LENGTH) {
    return next();
  }

  try {
    const { translatedText, detectedLanguage } = await translateToEnglish(trimmed);
    req.body.transcription = translatedText;
    req.body.sourceLanguage = detectedLanguage;
    return next();
  } catch (err) {
    console.warn(`translation skipped, analyzing original text: ${err.message}`);
    return next();
  }
}

export { translateToEnglishMiddleware };
export default translateToEnglishMiddleware;
