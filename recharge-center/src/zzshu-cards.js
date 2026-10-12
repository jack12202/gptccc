import crypto from "node:crypto";

export function parsePaymentCards(text, existing = new Set(), now = new Date()) {
  const seen = new Set(existing);
  return String(text || "").split(/\r?\n/).map((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return { line, status: "empty" };
    const input = raw.trim();
    const commaParts = input.split(",").map(value => value.trim());
    const spaceParts = input.split(/\s+/);
    const spaceFormat = !input.includes(",") && spaceParts.length === 3;
    const labeledParts = input.split(/[;；]/).map(value => value.trim());
    // Sky's copy format omits the colon after CVV. Labels can appear in any order.
    const fields = {};
    let labeledFormat = labeledParts.length === 3;
    for (const part of labeledParts) {
      const match = part.match(/^(卡号|有效期|CVV)\s*[:：]?\s*(\S+)$/i);
      const key = match?.[1].toUpperCase();
      if (!match || fields[key] !== undefined) { labeledFormat = false; break; }
      fields[key] = match[2];
    }
    labeledFormat = labeledFormat && Object.keys(fields).length === 3;
    const pan = (labeledFormat ? fields["卡号"] : spaceFormat ? spaceParts[0] : commaParts[0]) || "";
    const lastFour = /^\d{4}$/.test(pan.slice(-4)) ? pan.slice(-4) : "";
    const masked = lastFour ? `****${lastFour}` : "****";
    const expiry = labeledFormat ? fields["有效期"] : spaceFormat ? spaceParts[2] : commaParts[1];
    const cvv = labeledFormat ? fields.CVV : spaceFormat ? spaceParts[1] : commaParts[2];
    const expiryYearFirst = spaceFormat && /^20\d{2}-(0[1-9]|1[0-2])$/.test(expiry || "");
    const validExpiry = expiryYearFirst || /^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry || "");
    if ((!labeledFormat && (spaceFormat ? spaceParts.length : commaParts.length) !== 3) || !/^\d{12,19}$/.test(pan) || !validExpiry || !/^\d{3,4}$/.test(cvv || "")) {
      return { line, status: "error", masked, error: "格式应为 卡号,MM/YY,CVV、卡号 CVV MM/YY（也支持 YYYY-MM），或 卡号:…;CVV…;有效期:MM/YY" };
    }
    const month = expiryYearFirst ? Number(expiry.slice(5)) : Number(expiry.slice(0, 2));
    const year = expiryYearFirst ? Number(expiry.slice(0, 4)) : 2000 + Number(expiry.slice(3));
    if (year < now.getUTCFullYear() || year === now.getUTCFullYear() && month < now.getUTCMonth() + 1) {
      return { line, status: "error", masked, error: "卡片已过期" };
    }
    const fingerprint = crypto.createHash("sha256").update(pan).digest("hex");
    if (seen.has(fingerprint)) return { line, status: "duplicate", masked, error: "重复卡，默认跳过" };
    seen.add(fingerprint);
    return { line, status: "ready", masked, fingerprint, payment: { cardNumber: pan, expMonth: month, expYear: year, cvv } };
  });
}

export function publicPreview(rows) {
  return rows.map(({ line, status, masked, error }) => ({ line, status, masked, error }));
}
