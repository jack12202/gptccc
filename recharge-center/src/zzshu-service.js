import { config } from "./config.js";
import { sharedZzshuStore } from "./zzshu-store.js";
import { parsePaymentCards, publicPreview } from "./zzshu-cards.js";
import { zzshuAdapter } from "./providers/zzshu-adapter.js";
import { hifupayAdapter } from "./providers/hifupay-adapter.js";
import { JsonStore } from "./store.js";
import { encryptSecretText } from "./utils.js";

const store = sharedZzshuStore;
const hifupayStore = new JsonStore();
const codePattern = /^ZZPLUS[0-9A-F]{32}$/;
const cleanCode = value => {
  const raw = String(value || "").trim();
  try { const url = new URL(raw); return url.searchParams.get("provider") === "zzshu" ? String(url.searchParams.get("card") || "").toUpperCase() : ""; }
  catch { return raw.toUpperCase(); }
};
function vaultReady() {
  const url = config.zzshuVaultUrl;
  if (!url || !config.zzshuVaultToken || !config.recoveryEncryptionKey) throw new Error("凭据服务或加密密钥未配置，禁止导入和开通");
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && !["localhost","127.0.0.1"].includes(parsed.hostname)) throw new Error("凭据服务必须使用 HTTPS");
  return parsed;
}
async function vaultRequest(method, suffix, payment) {
  const base = vaultReady();
  const response = await fetch(new URL(suffix, base), {
    method, headers: { Authorization: `Bearer ${config.zzshuVaultToken}`, "Content-Type": "application/json" },
    ...(payment ? { body: JSON.stringify(payment) } : {}), signal: AbortSignal.timeout(config.zzshuTimeoutMs)
  });
  if (!response.ok) throw new Error("凭据服务不可用");
  return response.json();
}
function safeOrder(order) {
  if (!order) return null;
  return { orderId: order.id, taskId: order.id, provider: "zzshu", providerLabel: "吱吱鼠", status: order.status,
    message: order.status === "success" ? "Plus 已开通" : order.status === "failed" ? "本次未支付，请联系客服核查" :
      "正在处理或待确认，请勿重复提交", subscriptionCancellationStatus: order.cancellation };
}
function session(input) {
  let data;
  try { data = typeof input === "string" ? JSON.parse(input) : input; } catch { return null; }
  if (data?.fullAuthData) data = data.fullAuthData;
  if (typeof data === "string") { try { data = JSON.parse(data); } catch { return null; } }
  if (!data || typeof data !== "object" || Array.isArray(data) || !data.user?.id || !data.user?.email ||
      !data.account?.id || data.account?.planType !== "free" || !data.accessToken || !data.sessionToken || !data.expires) return null;
  return data;
}
export const zzshuService = {
  store,
  async listHifupayAssignments(refresh = false) {
    if (refresh) {
      const result = await hifupayAdapter.listCards({ fresh: true });
      if (!result.ok) throw new Error("嗨付卡片同步失败");
      hifupayStore.syncHifupayCards(result.data.cards);
    }
    const needed=Math.max(0,config.hifupayEstimatedPlusChargeUsd+config.hifupaySafetyBufferUsd);
    return hifupayStore.listHifupayCards().map(card => {
      const role=store.role(card.id).role, occupied=card.inFlightCount>0 || Boolean(store.role(card.id).hOrderId);
      const balance=Number(card.balance), active=String(card.status||"").toLowerCase()==="active";
      const eligible=role==="zzshu" && card.enabled!==false && active && Number.isFinite(balance) && balance>=needed && !occupied;
      const eligibilityReason=eligible?"可用于吱吱鼠 Plus":role!=="zzshu"?"尚未分配给吱吱鼠":
        card.enabled===false?"本地已停用":occupied?"有未决订单占用":card.missingFromUpstream?"嗨付本次同步未返回此卡":!active?`嗨付状态 ${card.status||"未知"}`:
        !Number.isFinite(balance)?"余额未知":`余额不足，至少需要 $${needed.toFixed(2)}`;
      return {id:card.id,lastFour:card.lastFour,balance:card.balance,status:card.status,enabled:card.enabled,
        role,occupied,proProtected:card.proProtected,usedInH:card.plusUsed>0,eligible,eligibilityReason,
        missingFromUpstream:card.missingFromUpstream,lastSeenAt:card.lastSeenAt};
    });
  },
  assignHifupayCard(cardId, role) {
    const card=hifupayStore.listHifupayCards().find(item=>item.id===String(cardId));
    if (!card) return {ok:false,reason:"请先同步嗨付卡池"};
    if (card.inFlightCount || store.role(card.id).hOrderId) return {ok:false,reason:"卡片有未决嗨付订单"};
    if (role === "zzshu" && card.proProtected)
      return {ok:false,reason:"这张卡仍受 Pro 保护，请先解除保护后再分配给吱吱鼠"};
    return store.assignHifupay({id:card.id,lastFour:card.lastFour},role);
  },
  preview(text) { return publicPreview(parsePaymentCards(text, store.hashes())); },
  async importCards({ text, source, note = "", enabled = true, maxSuccess = 5 }) {
    vaultReady();
    if (!String(source || "").trim()) return { ok: false, message: "请填写支付卡来源" };
    const limit = Number(maxSuccess);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, message: "成功次数上限应为 1–100" };
    const rows = parsePaymentCards(text, store.hashes());
    if (rows.length > 100 || !rows.length) return { ok: false, message: "每批 1–100 行" };
    const result = publicPreview(rows);
    for (const row of rows.filter(item => item.status === "ready")) {
      // The vault alone owns the lifetime/PCI handling of CVV. No local persistence or logs.
      try {
        const saved = await vaultRequest("POST", "/credentials", row.payment);
        if (!saved?.ref || typeof saved.ref !== "string") throw new Error("无凭据引用");
        store.addPaymentCard(row, { credentialRef: saved.ref, source: String(source).trim().slice(0, 40),
          note: String(note).slice(0, 200), enabled, maxSuccess: limit });
      } catch { result[row.line - 1] = { line: row.line, status: "error", masked: row.masked, error: "凭据服务导入失败；请核查孤立凭据" }; }
    }
    return { ok: true, rows: result };
  },
  createVouchers({ count, source }) {
    if (!config.recoveryEncryptionKey) throw new Error("未配置兑换卡密加密密钥");
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new Error("每批生成 1–100 张卡密");
    return store.createVouchers(n,String(source || "未分类").slice(0,40),config.hifupayProductId,
      code => encryptSecretText(code,config.recoveryEncryptionKey,"zzshu-voucher"));
  },
  verify(value) {
    const code = cleanCode(value);
    if (!codePattern.test(code)) return { ok: false, message: "卡密格式不正确" };
    const voucher = store.voucher(code);
    if (!voucher) return { ok: false, message: "卡密不存在" };
    return { ok: voucher.status === "unused", message: voucher.status === "unused" ? "" : "卡密处理中或已使用", productId: voucher.productId, status: voucher.status, orderId: voucher.orderId };
  },
  async voucherStatus(value) {
    const code = cleanCode(value);
    if (!codePattern.test(code)) return { ok: false, message: "卡密格式不正确" };
    const voucher = store.voucher(code);
    if (!voucher) return { ok: false, message: "卡密不存在" };
    const order = voucher.orderId ? (await this.refresh(voucher.orderId)).data : null;
    return { ok: true, status: voucher.status === "used" ? "success" : order?.status || voucher.status,
      canRecharge: voucher.status === "unused", statusLabel: voucher.status === "used" ? "充值成功" :
        voucher.status === "unused" ? "未使用" : "正在处理", boundAccount: voucher.email ?
          `${voucher.email.slice(0,1)}***@${voucher.email.split("@")[1]}` : "",
      subscriptionCancellationStatus: order?.subscriptionCancellationStatus || "",
      subscriptionActionRequired: order?.status === "success" && order?.subscriptionCancellationStatus !== "cancelled",
      message: order?.message || (voucher.status === "unused" ? "可继续激活" : "请勿重复提交") };
  },
  async confirm(input) {
    const code = cleanCode(input.cardInfo);
    const token = session(input.secretJsonText || input.fullAuthData);
    if (!codePattern.test(code) || !token) return { ok: false, status: 400, message: "需要有效的吱吱鼠 Plus 卡密和免费账号完整 Session JSON" };
    if (!config.zzshuEnabled || !config.zzshuApiKey) return { ok: false, status: 503, message: "通道尚未启用，兑换权益未消耗" };
    let allowedHifupayIds=null;
    if (store.hasHifupayAssignments()) {
      try {
        const upstream=await hifupayAdapter.listCards();
        if (!upstream.ok) throw new Error("嗨付卡片状态不可用");
        const local=new Map(hifupayStore.listHifupayCards().map(card=>[card.id,card]));
        const needed=Math.max(0,config.hifupayEstimatedPlusChargeUsd+config.hifupaySafetyBufferUsd);
        allowedHifupayIds=new Set(upstream.data.cards.filter(card=>{
          const id=String(card.id||""), balance=Number(card.balance);
          return store.role(id).role==="zzshu" && local.get(id)?.enabled!==false &&
            String(card.status||"").toLowerCase()==="active" && Number.isFinite(balance) && balance>=needed;
        }).map(card=>String(card.id)));
      } catch { return {ok:false,status:503,message:"无法核实嗨付卡片状态，兑换权益未消耗"}; }
    } else { try { vaultReady(); } catch { return {ok:false,status:503,message:"支付卡来源未就绪，兑换权益未消耗"}; } }
    const reservation = store.reserve(code, token.user.email.toLowerCase(), String(token.account.id),allowedHifupayIds,
      Boolean(config.zzshuVaultUrl && config.zzshuVaultToken));
    if (!reservation.ok) return reservation.orderId ? { ok: true, status: 200, data: safeOrder(store.order(reservation.orderId)) } :
      { ok: false, status: 409, message: reservation.reason };
    const id = reservation.orderId;
    let payment;
    try {
      payment = reservation.credentialRef.startsWith("hifupay:")
        ? await hifupayAdapter.getPaymentCard({cardId:reservation.credentialRef.slice(8),expectedLastFour:reservation.lastFour})
        : await vaultRequest("GET", `/credentials/${encodeURIComponent(reservation.credentialRef)}`);
    } catch { store.abortBeforeSubmit(id,"支付卡详情读取失败，未调用吱吱鼠"); return {ok:false,status:503,message:"支付卡详情不可用，兑换权益未消耗"}; }
    if (!payment || !/^\d{12,19}$/.test(payment.cardNumber || "") || !/^\d{3,4}$/.test(payment.cvv || "") ||
        !Number.isInteger(payment.expMonth) || payment.expMonth < 1 || payment.expMonth > 12 ||
        !Number.isInteger(payment.expYear) || payment.expYear < new Date().getUTCFullYear()) {
      store.abortBeforeSubmit(id,"支付卡详情无效，未调用吱吱鼠"); return {ok:false,status:503,message:"支付卡详情无效，兑换权益未消耗"};
    }
    store.markSubmitting(id); // Persist before the network request: crash means no automatic resubmission.
    let created;
    try { created = await zzshuAdapter.create({ token, payment }); }
    catch { store.review(id,"创建请求连接中断或超时；上游是否已创建未知"); return { ok: true, status: 200, data: safeOrder(store.order(id)) }; }
    const upstreamNo = String(created.data?.order_no ?? ""), upstreamKey = String(created.data?.card_key ?? "");
    if (created.ok && upstreamNo && upstreamKey) store.created(id,upstreamNo,upstreamKey);
    else store.review(id,`创建响应未能确认订单（HTTP ${created.status}, code ${created.code ?? "?"}）；不得自动重试`);
    return { ok: true, status: 200, data: safeOrder(store.order(id)) };
  },
  async refresh(id) {
    const order = store.order(id);
    if (!order) return { ok: false, status: 404, message: "订单不存在" };
    if (!order.upstream_card_key || order.status === "failed" || order.status === "success" && order.cancellation === "cancelled")
      return { ok: true, status: 200, data: safeOrder(order) };
    try {
      const result = await zzshuAdapter.status(order.upstream_card_key);
      if (!result.ok || result.data.cardKey !== order.upstream_card_key || result.data.orderNo !== order.upstream_order_no || result.data.planType !== "plus")
        return { ok: true, status: 200, data: safeOrder(order) };
      const data = result.data;
      if (data.status === "success") store.settle(id,"success",data.cancellation);
      else if (data.status === "failed") {
        // An upstream failed state alone does not prove that payment was not captured.
        if (data.unpaid && !data.paid) store.review(id,"上游报告失败/未支付；需间隔补查和人工确认后释放");
        else store.review(id,"上游失败但支付状态不明；保留占用");
      } else if (!["pending","processing"].includes(data.status)) store.review(id,"上游返回未知状态");
    } catch { /* Keep the persisted reservation. */ }
    store.markChecked(id);
    return { ok: true, status: 200, data: safeOrder(store.order(id)) };
  },
  async reconcile() {
    store.recoverInterrupted(Math.max(30000,config.zzshuTimeoutMs * 2));
    const ids = store.reconciliationIds(Math.max(1,config.zzshuConcurrency));
    for (const id of ids) await this.refresh(id);
  }
};
