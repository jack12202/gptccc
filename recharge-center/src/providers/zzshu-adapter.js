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
  async usage(page = 1) {
    const apiKey = zzshuCredentialStore.key();
    if (!apiKey) return { ok: false, status: 503, code: null };
    const base = new URL(config.zzshuBaseUrl);
    if (base.protocol !== "https:" && !["127.0.0.1", "localhost"].includes(base.hostname))
      return { ok: false, status: 503, code: null };
    const response = await fetch(new URL("/api/v1/third-party/orders/history", base), {
      method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": apiKey },
      body: JSON.stringify({ page, page_size: 20 }),
      signal: AbortSignal.timeout(config.zzshuTimeoutMs)
    });
    let body;
    try { body = await response.json(); } catch { return { ok: false, status: response.status, code: null }; }
    if (!response.ok || body?.code !== 0 || !body.data || !Array.isArray(body.data.items))
      return { ok: false, status: response.status, code: Number.isInteger(body?.code) ? body.code : null };
    return { ok: true, status: response.status, data: {
      page: Number(body.data.page) || page,
      total: Number(body.data.total) || 0,
      remaining: Number(body.data.remaining) || 0,
      items: body.data.items.slice(0, 20).map(item => ({
        taskNo: String(item.task_no || "").slice(0, 80),
        createdAt: String(item.created_at || "").slice(0, 40),
        email: String(item.email || "").slice(0, 200),
        planType: String(item.plan_type || "").slice(0, 40),
        status: String(item.status || "").slice(0, 40),
        cancellation: item.renewal_cancelled === true || item.renewal_cancelled === 1 || /已取消自动续费/.test(String(item.result_message || "")) ? "cancelled" :
          /取消续费未完成/.test(String(item.result_message || "")) ? "failed" : "unconfirmed",
        points: Number(item.cdk_cost) || 0
      }))
    } };
  },
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
      cancellation: [1, true, "1", "true"].includes(data.is_subscription_cancelled) ? "cancelled" : "unconfirmed"
    } };
  }
};
