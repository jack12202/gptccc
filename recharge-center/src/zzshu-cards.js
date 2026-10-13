import crypto from "node:crypto";
import { parseCardInputs } from "./payment-card-input.js";

export function parsePaymentCards(text, existing = new Set(), now = new Date()) {
  const seen = new Set(existing);
  return parseCardInputs(text,now).map(row => {
    if (row.status !== "ready") return row;
    const fingerprint=crypto.createHash("sha256").update(row.payment.cardNumber).digest("hex");
    if (seen.has(fingerprint)) return {line:row.line,status:"duplicate",masked:row.masked,error:"重复卡，默认跳过"};
    seen.add(fingerprint);
    return {...row,fingerprint};
  });
}

export function publicPreview(rows) {
  return rows.map(({ line, status, masked, error }) => ({ line, status, masked, error }));
}
