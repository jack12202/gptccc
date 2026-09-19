import crypto from "node:crypto";

export function parsePaymentCards(text, existing = new Set(), now = new Date()) {
  const seen = new Set(existing);
  return String(text || "").split(/\r?\n/).map((raw, index) => {
    const line = index + 1;
    if (!raw.trim()) return { line, status: "empty" };
    const parts = raw.trim().split(",").map(value => value.trim());
    const pan = parts[0] || "";
    const lastFour = /^\d{4}$/.test(pan.slice(-4)) ? pan.slice(-4) : "";
    const masked = lastFour ? `****${lastFour}` : "****";
    if (parts.length !== 3 || !/^\d{12,19}$/.test(pan) || !/^(0[1-9]|1[0-2])\/\d{2}$/.test(parts[1] || "") || !/^\d{3,4}$/.test(parts[2] || "")) {
      return { line, status: "error", masked, error: "仅接受 卡号,MM/YY,CVV；请修正含糊格式" };
    }
    const month = Number(parts[1].slice(0, 2));
    const year = 2000 + Number(parts[1].slice(3));
    if (year < now.getUTCFullYear() || year === now.getUTCFullYear() && month < now.getUTCMonth() + 1) {
      return { line, status: "error", masked, error: "卡片已过期" };
    }
    const fingerprint = crypto.createHash("sha256").update(pan).digest("hex");
    if (seen.has(fingerprint)) return { line, status: "duplicate", masked, error: "重复卡，默认跳过" };
    seen.add(fingerprint);
    return { line, status: "ready", masked, fingerprint, payment: { cardNumber: pan, expMonth: month, expYear: year, cvv: parts[2] } };
  });
}

export function publicPreview(rows) {
  return rows.map(({ line, status, masked, error }) => ({ line, status, masked, error }));
}
