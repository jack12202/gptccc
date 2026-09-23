import { config } from "../config.js";
import { zzshuCredentialStore } from "../zzshu-credential-store.js";

// Deliberately allowlist responses: the upstream status includes PAN and Session JSON.
async function request(path, payload) {
  const apiKey = zzshuCredentialStore.key();
  if (!config.zzshuEnabled || !apiKey) throw new Error("自动充值通道尚未启用");
  const base = new URL(config.zzshuBaseUrl);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1" && base.hostname !== "localhost") throw new Error("上游必须使用 HTTPS");
  const response = await fetch(new URL(path, base), {
    method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(config.zzshuTimeoutMs)
  });
  let body;
  try { body = await response.json(); } catch { return { ok: false, status: response.status, code: null, data: null }; }
  return { ok: response.ok && body?.code === 0, status: response.status, code: body?.code, data: body?.data };
}

export const zzshuAdapter = {
  key: "zzshu", label: "ZZS",
  async create({ token, payment }) {
    return request("/api/v1/third-party/orders/direct", {
      orderType: "direct", planType: "plus", token,
      cardNumber: payment.cardNumber, expMonth: payment.expMonth,
      expYear: payment.expYear, cvv: payment.cvv
      // No explicit region: the documented default is PH. Never rotate regions.
    });
  },
  async status(cardKey) {
    const raw = await request("/api/v1/third-party/orders/status", { cardKey });
    if (!raw.ok || !raw.data || Array.isArray(raw.data)) return { ok: false, status: raw.status, code: raw.code };
    const data = raw.data;
    const upstreamStatus = String(data.status ?? "").trim().toLowerCase();
    const paid = data.payment_result?.success === true && data.payment_result?.status === "paid";
    const unpaid = data.payment_result?.success === false && ["failed", "unpaid"].includes(String(data.payment_result?.status || "").toLowerCase());
    const verificationRequired = Boolean(data.verification);
    const status = paid ? "success"
      : verificationRequired ? "verification_required"
        : unpaid && ["failed", "cancelled", "canceled", "closed"].includes(upstreamStatus) ? "unpaid"
          : ["pending", "processing", "queued", "created", "running", "paying"].includes(upstreamStatus) ? "processing"
            : ["success", "completed", "done"].includes(upstreamStatus) ? "needs_review"
              : ["failed", "cancelled", "canceled", "closed", "error"].includes(upstreamStatus) ? "needs_review"
                : "unknown";
    return { ok: true, status: raw.status, data: {
      orderNo: String(data.order_no ?? ""), cardKey: String(data.card_key ?? ""),
      planType: String(data.plan_type ?? ""), status, upstreamStatus,
      paid, unpaid, verificationRequired,
      cancellation: data.is_subscription_cancelled === 1 ? "cancelled" : "unconfirmed"
    } };
  }
};
