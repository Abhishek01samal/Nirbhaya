function emptyResult(text = "", error = null) {
  return { text, fields: {}, error };
}

/** Extract text from a screenshot buffer via Tesseract, then parse ride fields. */
export async function extractRideFields(buffer) {
  if (!buffer) return emptyResult("", "no file buffer");

  let text = "";
  try {
    const mod = await import("tesseract.js").catch(() => null);
    if (!mod) return emptyResult("", "tesseract.js not installed");
    const worker = await mod.createWorker("eng");
    const { data } = await worker.recognize(buffer);
    text = data?.text ?? "";
    await worker.terminate();
  } catch (err) {
    return emptyResult("", `ocr failed: ${err.message}`);
  }

  return { text, fields: parseFields(text), error: null };
}

function parseFields(text) {
  const fields = {};
  const pick = (re) => {
    const m = text.match(re);
    return m ? m[1].trim() : undefined;
  };

  fields.vehicleNumber = pick(/\b([A-Z]{2}\s?\d{1,2}\s?[A-Z]{0,3}\s?\d{1,4})\b/i);
  fields.driverPhone = pick(/(\+?\d[\d\s-]{8,}\d)/);
  fields.fareEstimate = (() => {
    const m = text.match(/(?:₹|Rs\.?|INR)\s?(\d+[\d,]*)/i);
    return m ? Number(m[1].replace(/,/g, "")) : null;
  })();
  fields.provider = /uber/i.test(text) ? "uber" : /ola/i.test(text) ? "ola" : /rapido/i.test(text) ? "rapido" : undefined;
  fields.tripOtp = pick(/\b(?:OTP|otp)[:\s]*(\d{4,6})/);
  return fields;
}
