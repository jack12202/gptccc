import { config } from "./config.js";
import { sharedZzshuStore } from "./zzshu-store.js";
import { parsePaymentCards, publicPreview } from "./zzshu-cards.js";
import { zzshuAdapter } from "./providers/zzshu-adapter.js";
import { hifupayAdapter } from "./providers/hifupay-adapter.js";
import { JsonStore } from "./store.js";
import { encryptSecretText, decryptSecretText, sha256 } from "./utils.js";
import { zzshuCredentialStore } from "./zzshu-credential-store.js";

const store = sharedZzshuStore;
const hifupayStore = new JsonStore();
let unifiedRecovered = false;
const codePattern = /^(?:ZZPLUS|HPLUS)[0-9A-F]{32}$/;
const cleanCode = value => {
  const raw = String(value || "").trim();
  try { const url = new URL(raw); return ["zzshu", "h"].includes(url.searchParams.get("provider")) ? String(url.searchParams.get("card") || "").toUpperCase() : ""; }
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
  return { orderId: order.id, taskId: order.id, provider: "zzshu", providerLabel: "自动充值", status: order.status,
    message: order.status === "success" ? "Plus 已开通" : order.status === "failed" ? "本次未完成，卡密权益已恢复，可以重新提交" :
      order.status === "needs_review" && /银行卡持有人验证/.test(order.review_reason || "") ? "支付需要银行卡持有人验证，请等待处理，勿重复提交" :
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
  importStatus() {
    return config.recoveryEncryptionKey
      ? { ready: true, message: "可直接导入；支付资料加密保存在本机，按设置次数使用" }
      : { ready: false, message: "运行时加密密钥未配置，暂不能导入支付卡" };
  },
  diagnostics() {
    const candidate = store.manualCandidate();
    let manualPaymentReadable = false;
    let reservationProbe = "not_applicable";
    if (candidate?.credential_ref.startsWith("local:")) {
      try {
        const payment = JSON.parse(decryptSecretText(candidate.payment_cipher, config.recoveryEncryptionKey, "zzshu-payment-card"));
        manualPaymentReadable = /^\d{12,19}$/.test(payment.cardNumber || "") && /^\d{3,4}$/.test(payment.cvv || "") &&
          Number.isInteger(payment.expMonth) && payment.expMonth >= 1 && payment.expMonth <= 12 &&
          Number.isInteger(payment.expYear) && payment.expYear >= new Date().getUTCFullYear();
      } catch { /* Return only a readiness boolean; never return payment fields. */ }
    }
    if (config.zzshuTestMode && config.recoveryEncryptionKey) {
      try {
        const code = decryptSecretText(store.voucherCipherByHash(config.zzshuTestVoucherHash), config.recoveryEncryptionKey, "zzshu-voucher");
        const result = store.probeManualReservation(code);
        reservationProbe = result.ok ? "ready" : result.reason || "blocked";
      } catch (error) {
        reservationProbe = /^SQLITE_[A-Z_]+$/.test(error?.code || "") ? error.code : "error";
      }
    }
    return {
      channelEnabled: config.zzshuEnabled,
      testMode: config.zzshuTestMode,
      apiKeyReady: Boolean(zzshuCredentialStore.key()),
      testVoucherStatus: config.zzshuTestMode ? store.voucherStatusByHash(config.zzshuTestVoucherHash) : "not_applicable",
      manualCardSelectable: Boolean(candidate?.credential_ref.startsWith("local:")),
      manualPaymentReadable,
      reservationProbe,
      recentPreSubmitFailures: store.recentPreSubmitFailures()
    };
  },
  async importCards({ text, source, note = "", enabled = true, maxSuccess = 1 }) {
    if (!config.recoveryEncryptionKey) return { ok: false, message: "运行时加密密钥未配置" };
    if (!String(source || "").trim()) return { ok: false, message: "请填写支付卡来源" };
    const limit = Number(maxSuccess);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return { ok: false, message: "总可用次数应为 1–100" };
    const rows = parsePaymentCards(text, store.hashes());
    if (rows.length > 100 || !rows.length) return { ok: false, message: "每批 1–100 行" };
    const result = publicPreview(rows);
    for (const row of rows.filter(item => item.status === "ready")) {
      try {
        const paymentCipher = encryptSecretText(JSON.stringify(row.payment), config.recoveryEncryptionKey, "zzshu-payment-card");
        const added = store.addPaymentCard(row, { credentialRef: `local:${row.fingerprint}`, paymentCipher, source: String(source).trim().slice(0, 40),
          note: String(note).slice(0, 200), enabled, maxSuccess: limit });
        result[row.line - 1] = { line: row.line, masked: row.masked, status: added ? "imported" : "duplicate" };
      } catch { result[row.line - 1] = { line: row.line, status: "error", masked: row.masked, error: "此行保存失败，未导入" }; }
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
  registerUnifiedVouchers(cards) {
    if (!config.recoveryEncryptionKey) throw new Error("未配置兑换卡密加密密钥");
    store.registerUnifiedVouchers(cards, code => encryptSecretText(code, config.recoveryEncryptionKey, "zzshu-voucher"));
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
    // Card lookup is intentionally local-only. Upstream reconciliation runs in
    // the background and through the explicit admin refresh action.
    const order = voucher.orderId ? safeOrder(store.order(voucher.orderId)) : null;
    return { ok: true, status: voucher.status === "used" ? "success" : order?.status || voucher.status,
      canRecharge: voucher.status === "unused", statusLabel: voucher.status === "used" ? "充值成功" :
        voucher.status === "unused" ? "未使用" : "正在处理", boundAccount: voucher.email ?
          `${voucher.email.slice(0,1)}***@${voucher.email.split("@")[1]}` : "",
      subscriptionCancellationStatus: order?.subscriptionCancellationStatus || "",
      subscriptionActionRequired: order?.status === "success" && order?.subscriptionCancellationStatus !== "cancelled",
      message: order?.message || (voucher.status === "unused" ? "可继续激活" : "请勿重复提交") };
  },
  syncUnifiedOrder(id) {
    const code = decryptSecretText(store.voucherCipherForOrder(id), config.recoveryEncryptionKey, "zzshu-voucher");
    if (/^HPLUS[0-9A-F]{32}$/.test(code)) hifupayStore.syncUnifiedPlus(code, store.voucher(code));
  },
  async confirm(input) {
    const code = cleanCode(input.cardInfo);
    try {
    const rawSession = typeof input.secretJsonText === "string" ? input.secretJsonText : JSON.stringify(input.fullAuthData || {});
    const token = session(rawSession);
    if (input.dryRun === true) {
      if (!config.zzshuTestMode || !codePattern.test(code) || !token ||
          sha256(code) !== config.zzshuTestVoucherHash ||
          sha256(String(token.account.id)) !== config.zzshuTestAccountHash)
        return { ok: false, status: 403, message: "此测试请求未开放" };
      const diagnostics = this.diagnostics();
      const ready = diagnostics.testVoucherStatus === "unused" && diagnostics.apiKeyReady &&
        diagnostics.manualCardSelectable && diagnostics.manualPaymentReadable && diagnostics.reservationProbe === "ready";
      return { ok: ready, status: ready ? 200 : 409,
        ...(ready ? { data: { preflight: true, ready: true, provider: "zzshu" } } :
          { message: "测试请求的卡密、支付资料或订单预留未就绪" }) };
    }
    if (!codePattern.test(code) || !token) return { ok: false, status: 400, message: "需要有效的 Plus 卡密和完整账号 Session JSON" };
    const reject = (status, message, reason) => {
      if (config.zzshuTestMode && sha256(code) === config.zzshuTestVoucherHash) {
        try { store.audit("test-voucher", "pre_submit_rejected", reason); } catch { /* Preserve the rejection response. */ }
      }
      return { ok: false, status, message };
    };
    if (/^HPLUS[0-9A-F]{32}$/.test(code)) {
      const unified = hifupayStore.getHCardByCode(code);
      if (!unified?.unified || unified.disabledAt || unified.archivedAt || unified.routedProvider && unified.routedProvider !== "zzshu" || !["unused", "locked"].includes(unified.status)) {
        return reject(409, "卡密当前不可用于 ZZS 充值", "统一卡密不存在、已停用或通道不匹配");
      }
    }
    if (config.zzshuTestMode &&
        (!/^[a-f0-9]{64}$/.test(config.zzshuTestVoucherHash) ||
         !/^[a-f0-9]{64}$/.test(config.zzshuTestAccountHash) ||
         sha256(code) !== config.zzshuTestVoucherHash ||
         sha256(String(token.account.id)) !== config.zzshuTestAccountHash))
      return reject(403, "此卡密或账号暂未开放提交，兑换权益未消耗", "测试卡密或账号门禁未通过");
    if (!config.zzshuEnabled || !zzshuCredentialStore.key()) return reject(503, "通道尚未启用，兑换权益未消耗", "通道或 API 凭据未就绪");
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
      } catch { allowedHifupayIds = new Set(); }
    }
    let reservation;
    try {
      const sessionCipher = encryptSecretText(rawSession, config.recoveryEncryptionKey, "zzshu-session-json");
      reservation = store.reserve(code, token.user.email.toLowerCase(), String(token.account.id),allowedHifupayIds,
        Boolean(config.recoveryEncryptionKey || config.zzshuVaultUrl && config.zzshuVaultToken), sessionCipher);
    } catch (error) {
      try {
        const voucher = store.voucher(code);
        if (voucher?.orderId && voucher.email === token.user.email.toLowerCase() && voucher.accountId === String(token.account.id))
          return { ok: true, status: 200, data: safeOrder(store.order(voucher.orderId)) };
      } catch { /* Keep the voucher untouched if the database is unavailable. */ }
      const sqliteCode = /^SQLITE_[A-Z_]+$/.test(error?.code || "") ? error.code : "unknown";
      return reject(503, "订单预留暂不可用，兑换权益未消耗", `订单预留异常：${sqliteCode}`);
    }
    if (!reservation.ok) return reservation.orderId ? { ok: true, status: 200, data: safeOrder(store.order(reservation.orderId)) } :
      reject(409, reservation.reason, `订单预留拒绝：${reservation.reason}`);
    const id = reservation.orderId;
    let payment;
    try {
      payment = reservation.credentialRef.startsWith("hifupay:")
        ? await hifupayAdapter.getPaymentCard({cardId:reservation.credentialRef.slice(8),expectedLastFour:reservation.lastFour})
        : reservation.credentialRef.startsWith("local:")
          ? JSON.parse(decryptSecretText(store.paymentCipher(reservation.credentialRef),config.recoveryEncryptionKey,"zzshu-payment-card"))
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
    else if ([42902,40305,40306,40106,40107,40005,40006,40007,40008,40024,40025,40026,40027,40028,40030].includes(Number(created.code)) &&
             store.rejectUncreated(id,`上游拒绝创建订单（HTTP ${created.status}, code ${created.code}）`))
      return { ok: false, status: created.status === 429 ? 429 : 400,
        message: Number(created.code) === 42902 ? "上游当前并发已满，请稍后再试；卡密和支付卡未消耗" :
          Number(created.code) === 40305 ? "上游暂时关闭充值，请稍后再试；卡密和支付卡未消耗" :
          [40106,40107,40306].includes(Number(created.code)) ? "上游 API 凭据或额度不可用，请联系客服；卡密和支付卡未消耗" :
            "账号 Session 未被上游接受，请重新获取完整 Session；卡密和支付卡未消耗" };
    else store.review(id,`创建响应未能确认订单（HTTP ${created.status}, code ${created.code ?? "?"}）；不得自动重试`);
    return { ok: true, status: 200, data: safeOrder(store.order(id)) };
    } finally {
      if (/^HPLUS[0-9A-F]{32}$/.test(code)) {
        const voucher = store.voucher(code);
        hifupayStore.syncUnifiedPlus(code, voucher);
        if (voucher?.status === "unused" && !store.hasVoucherOrders(code)) hifupayStore.releaseUnsubmittedUnifiedPlus(code);
      }
    }
  },
  async refresh(id) {
    const order = store.order(id);
    if (!order) return { ok: false, status: 404, message: "订单不存在" };
    this.syncUnifiedOrder(id);
    if (!order.upstream_card_key || order.status === "failed" || order.status === "success" && order.cancellation === "cancelled")
      return { ok: true, status: 200, data: safeOrder(order) };
    try {
      const result = await zzshuAdapter.status(order.upstream_card_key);
      if (!result.ok || result.data.cardKey !== order.upstream_card_key || result.data.orderNo !== order.upstream_order_no || result.data.planType !== "plus")
        return { ok: true, status: 200, data: safeOrder(order) };
      const data = result.data;
      if (data.status === "success" && data.paid) store.settle(id,"success",data.cancellation);
      else if (data.status === "unpaid" && data.unpaid && !data.paid) store.settle(id,"failed");
      else if (data.status === "verification_required") store.review(id,"支付需要银行卡持有人验证");
      else if (["needs_review","unknown"].includes(data.status)) store.review(id,`上游状态需核查：${data.upstreamStatus || "unknown"}`);
      store.markChecked(id, true);
    } catch { store.markChecked(id, false); }
    this.syncUnifiedOrder(id);
    return { ok: true, status: 200, data: safeOrder(store.order(id)) };
  },
  async reconcile() {
    store.recoverInterrupted(Math.max(30000,config.zzshuTimeoutMs * 2));
    if (!unifiedRecovered) {
      if (config.recoveryEncryptionKey) {
        const missing = hifupayStore.listHCards(1, true, true, true)
          .filter(card => card.unified && card.code && !store.voucher(card.code));
        if (missing.length) this.registerUnifiedVouchers(missing);
      }
      for (const id of store.unifiedOrderIds()) this.syncUnifiedOrder(id);
      unifiedRecovered = true;
    }
    const ids = store.reconciliationIds(Math.max(1,config.zzshuConcurrency));
    for (const id of ids) await this.refresh(id);
  }
};
