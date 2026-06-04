import crypto from "node:crypto";

export function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(body);
}

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

export function maskCard(cardInfo = "") {
  if (cardInfo.length <= 4) return cardInfo;
  return `${cardInfo.slice(0, 4)}****${cardInfo.slice(-4)}`;
}

export function safeJsonParse(raw) {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, error };
  }
}

export function sha256(value = "") {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function requiredString(value) {
  return typeof value === "string" && value.trim() !== "";
}
