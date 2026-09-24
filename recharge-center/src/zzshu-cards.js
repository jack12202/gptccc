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
    const pan = (spaceFormat ? spaceParts[0] : commaParts[0]) || "";
    const lastFour = /^\d{4}$/.test(pan.slice(-4)) ? pan.slice(-4) : "";
    const masked = lastFour ? `****${lastFour}` : "****";
    const expiry = spaceFormat ? spaceParts[2] : commaParts[1];
    const cvv = spaceFormat ? spaceParts[1] : commaParts[2];
    const validExpiry = spaceFormat ? /^20\d{2}-(0[1-9]|1[0-2])$/.test(expiry || "") : /^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry || "");
    if ((spaceFormat ? spaceParts.length : commaParts.length) !== 3 || !/^\d{12,19}$/.test(pan) || !validExpiry || !/^\d{3,4}$/.test(cvv || "")) {
      return { line, status: "error", masked, error: "格式应为 卡号,MM/YY,CVV 或 卡号 CVV YYYY-MM" };
    }
    const month = Number(spaceFormat ? expiry.slice(5) : expiry.slice(0, 2));
    const year = spaceFormat ? Number(expiry.slice(0, 4)) : 2000 + Number(expiry.slice(3));
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
