import { config } from "./config.js";
import { JsonStore } from "./store.js";
import { hifupayAdapter } from "./providers/hifupay-adapter.js";
import { decryptSecretText } from "./utils.js";

const publicMessage = {
  manual_queued: "已进入充值队列，请稍后，完成后可在本页查询结果。",
  manual_processing: "正在人工处理，完成后可在本页查询结果。",
  needs_info: "需要补充资料，请联系客服核实。",
  queued: "已进入充值队列，请稍后，完成后可在本页查询结果。",
  submitting: "正在提交充值任务，请勿重复操作。",
  processing: "充值处理中，请稍后查询结果。",
  needs_review: "结果待确认，请勿重复提交或人工补充充值。",
  success: "充值成功。"
};

export function createProService({ store = new JsonStore(), adapter = hifupayAdapter } = {}) {
  let draining = false;
  const readOrder = id => store.getOrder(id);
  const isPro = order => ["pro_x5", "pro_x20"].includes(order?.plan);
  const expose = order => ({ orderId: order.id, status: order.status, taskId: "", plan: order.plan,
    planLabel: order.plan === "pro_x5" ? "Pro 5x" : "Pro 20x", provider: "h", providerLabel: "h",
    fulfillmentMode: order.fulfillmentMode, paymentConfirmed: order.paymentConfirmed === true,
    autoCancelDone: order.autoCancelDone === true,
    subscriptionCancellationStatus: order.subscriptionCancellationStatus || "not_started",
    subscriptionActionRequired: order.subscriptionCancellationStatus === "failed",
    subscriptionActionMessage: order.subscriptionCancellationStatus === "failed" ? "充值成功，但自动续费未关闭，请手动关闭。" : "",
    message: publicMessage[order.status] || publicMessage.needs_review });

  async function refresh(orderId) {
    const order = readOrder(orderId);
    if (!isPro(order) || !order.upstreamTaskId || (order.status === "success" && order.subscriptionCancellationStatus !== "pending")) return order;
    let result;
    try { result = await adapter.queryTaskStatus({ taskId: order.upstreamTaskId }); }
    catch { return order; }
    if (!result.ok) return order;
    const data = result.data || {};
    const payment = data.raw?.paymentConfirmed === true;
    const nextStatus = payment || order.paymentConfirmed === true ? "success" :
      data.status === "failed" || data.status === "needs_review" || data.upstreamStatus === "completed" ? "needs_review" : "processing";
    const cancelStatus = payment ? data.autoCancelDone === true ? "cancelled" : data.subscriptionCancellationStatus === "failed" || data.upstreamStatus === "completed" ? "failed" : "pending" : "not_started";
    if (payment && order.status !== "success") {
      store.completeHCard(order.hCardId, order.id);
      store.recordHifupayResult({ cardId: order.hifupayCardId, orderId: order.id, plan: "pro_x5", paymentConfirmed: true, status: "success" });
    } else if (nextStatus === "needs_review") {
      store.recordHifupayResult({ cardId: order.hifupayCardId, orderId: order.id, plan: "pro_x5", status: "needs_review" });
    }
    if (order.status !== nextStatus || order.subscriptionCancellationStatus !== cancelStatus) {
      store.updateOrder(order.id, { status: nextStatus, paymentConfirmed: payment || order.paymentConfirmed === true,
        autoCancelDone: data.raw?.autoCancelDone === true,
        subscriptionCancellationStatus: cancelStatus,
        message: publicMessage[nextStatus], lastStatusSyncAt: new Date().toISOString() });
      store.addLog({ orderId: order.id, step: "pro.status", requestSummary: order.upstreamTaskId,
        responseSummary: JSON.stringify({ status: nextStatus, paymentConfirmed: payment, autoCancelDone: data.autoCancelDone === true }) });
    }
    return readOrder(order.id);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      // One claim per selected card. A network request never runs twice for a submitted order.
      while (true) {
        const order = store.claimNextProOrder();
        if (!order) break;
        if (order.status !== "submitting") continue;
        let cards;
        try { cards = await adapter.listCards(); } catch { cards = { ok: false }; }
        if (!cards.ok || !Array.isArray(cards.data?.cards)) {
          store.updateOrder(order.id, { status: "manual_queued", fulfillmentMode: "manual", message: "指定付款卡状态不可确认，已转人工处理。" });
          store.clearHifupayReservation(order.hifupayCardId, order.id);
          continue;
        }
        store.syncHifupayCards(cards.data.cards);
        const check = store.validateHifupayCardForSubmission({ cardId: order.hifupayCardId, orderId: order.id,
          plan: "pro_x5", estimatedChargeUsd: order.estimatedChargeUsd });
        const card = store.listHifupayCards().find(item => item.id === order.hifupayCardId);
        if (!check.ok || card?.proReservation || card?.usageMode === "pro_reserved" || card?.availableBalance === null ||
          card?.balance < order.estimatedChargeUsd + order.safetyBufferUsd) {
          store.updateOrder(order.id, { status: "manual_queued", fulfillmentMode: "manual", message: "指定付款卡不可用或余额不足，已转人工处理。" });
          store.clearHifupayReservation(order.hifupayCardId, order.id);
          continue;
        }
        const session = store.getRechargeSession(order.id);
        const key = config.recoveryEncryptionKey || config.adminToken || "local-development-only";
        const token = decryptSecretText(session?.authDataCiphertext, key, "recharge-auth-data");
        if (!token) {
          store.updateOrder(order.id, { status: "manual_queued", fulfillmentMode: "manual", message: "账号资料不可用，已转人工处理。" });
          store.clearHifupayReservation(order.hifupayCardId, order.id);
          continue;
        }
        store.addLog({ orderId: order.id, step: "pro.start.submitting", requestSummary: JSON.stringify({ cardId: order.hifupayCardId, plan: order.plan, region: order.proRegion }), responseSummary: "pending" });
        let response;
        try { response = await adapter.startPro5x({ token, cardId: order.hifupayCardId, region: order.proRegion }); }
        catch { response = null; }
        if (response?.preflight === true) {
          store.updateOrder(order.id, { status: "manual_queued", fulfillmentMode: "manual", message: "通道登录失败，未提交充值，已转人工处理。" });
          store.clearHifupayReservation(order.hifupayCardId, order.id);
          continue;
        }
        const taskId = response?.ok && typeof response.data?.taskId === "string" ? response.data.taskId.trim() : "";
        store.updateOrder(order.id, taskId ? { status: "processing", upstreamTaskId: taskId, message: publicMessage.processing } :
          { status: "needs_review", message: publicMessage.needs_review });
        store.addLog({ orderId: order.id, step: "pro.start.response", requestSummary: "", responseSummary: taskId ? `taskId:${taskId}` : "ambiguous_no_task_id" });
        // A failed/ambiguous response retains the card reservation; only an explicit no-charge attestation releases it.
        break;
      }
    } finally { draining = false; }
  }

  return {
    drain, refresh, expose,
    async query({ orderId, cardInfo }) {
      const card = store.getHCardByCode(cardInfo);
      const order = readOrder(orderId || card?.orderId);
      if (!isPro(order) || !card || card.id !== order.hCardId) return { ok: false, status: 404, message: "未找到这张卡密的订单。" };
      return { ok: true, status: 200, data: expose(await refresh(order.id)) };
    },
    settings() {
      const settings = store.getSettings();
      return { enabled: settings.pro5xAutoEnabled === true, cardId: settings.pro5xCardId || "",
        region: settings.pro5xRegion || "EG", estimatedChargeUsd: Number(settings.pro5xEstimatedChargeUsd) || 0,
        safetyBufferUsd: Number(settings.pro5xSafetyBufferUsd) || 0, cards: store.listHifupayCards() };
    },
    updateSettings(input) { return store.updatePro5xSettings(input); },
    selectCard(id, cardId) {
      const result = store.selectManualProCard(id, cardId);
      if (!result.ok) return result;
      store.addLog({ orderId: id, step: "pro.admin.select-card", requestSummary: String(cardId), responseSummary: "selected" });
      return { ok: true, status: 200, data: this.detail(id) };
    },
    list() { return store.listProOrders().map(({ session, ...order }) => ({ id: order.id, plan: order.plan, status: order.status,
      fulfillmentMode: order.fulfillmentMode, initialFulfillmentMode: order.initialFulfillmentMode || order.fulfillmentMode,
      selectedCardSnapshotId: order.selectedCardSnapshotId || "", userEmail: session?.userEmail || "", source: order.siteSource,
      cardMask: order.cardMask, hifupayCardId: order.hifupayCardId, hifupayCardLastFour: order.hifupayCardLastFour,
      createdAt: order.createdAt, upstreamTaskPresent: Boolean(order.upstreamTaskId), waitingMinutes: Math.max(0, Math.floor((Date.now() - Date.parse(order.createdAt)) / 60000)),
      message: order.message, processingNote: order.processingNote || "", paymentConfirmed: order.paymentConfirmed === true,
      autoCancelDone: order.autoCancelDone === true,
      subscriptionCancellationStatus: order.subscriptionCancellationStatus || "" })); },
    detail(id) { const record = store.getRecoveryOrder(id); if (!isPro(record?.order)) return null;
      const key = config.recoveryEncryptionKey || config.adminToken || "local-development-only";
      return { ...this.list().find(item => item.id === id),
        secretJsonText: decryptSecretText(record.session?.rawSecretCiphertext, key, "recharge-secret-json") || "",
        logs: store.read().rechargeLogs.filter(item => item.orderId === id).map(item => ({ step: item.step, createdAt: item.createdAt })) };
    },
    action(id, action, { note = "", confirmedNoCharge = false } = {}) {
      const order = readOrder(id);
      if (!isPro(order)) return { ok: false, status: 404, message: "订单不存在。" };
      if (action === "note") {
        const value = String(note || "").trim().slice(0, 1000);
        store.updateOrder(id, { processingNote: value });
      } else if (action === "manual-processing" || action === "needs-info") {
        if (order.fulfillmentMode !== "manual" || !["manual_queued", "manual_processing", "needs_info"].includes(order.status)) return { ok: false, status: 409, message: "订单当前不可人工处理。" };
        store.updateOrder(id, { status: action === "needs-info" ? "needs_info" : "manual_processing", processingNote: String(note || "").slice(0, 1000) });
      } else if (action === "mark-success") {
        if (order.status === "success") return { ok: true, status: 200, data: expose(order) };
        if (order.fulfillmentMode !== "manual" || !["manual_queued", "manual_processing", "needs_info"].includes(order.status)) return { ok: false, status: 409, message: "自动任务待确认，不能直接人工同步成功。" };
        if (order.hifupayCardId && !store.claimManualProCardUse(order.hifupayCardId, id))
          return { ok: false, status: 409, message: "所选支付卡没有可用次数或正在处理其他订单，请重新核对。" };
        if (!store.completeHCard(order.hCardId, id)) {
          if (order.hifupayCardId) store.releaseManualProCardUse(order.hifupayCardId, id);
          return { ok: false, status: 409, message: "卡密状态不允许同步成功。" };
        }
        store.updateOrder(id, { status: "success", paymentConfirmed: true, message: "人工充值成功，系统已同步完成。", manualCompletedAt: new Date().toISOString(), manualCompletedBy: "admin", processingNote: String(note || order.processingNote || "").slice(0, 1000) });
        if (order.hifupayCardId) store.recordHifupayResult({ cardId: order.hifupayCardId, orderId: id, plan: order.plan, paymentConfirmed: true, status: "success" });
      } else return { ok: false, status: 400, message: "不支持的操作。" };
      store.addLog({ orderId: id, step: `pro.admin.${action}`, requestSummary: "admin", responseSummary: "completed" });
      return { ok: true, status: 200, data: expose(readOrder(id)) };
    },
    async confirmNoCharge(id, { note = "", confirmedNoCharge = false } = {}) {
      const order = readOrder(id);
      if (!isPro(order) || order.fulfillmentMode !== "auto" || !["needs_review", "processing"].includes(order.status) ||
        !confirmedNoCharge || !String(note).trim()) return { ok: false, status: 409, message: "请写明核查依据，并确认原任务未扣款且未成功。" };
      if (order.upstreamTaskId) {
        let result;
        try { result = await adapter.queryTaskStatus({ taskId: order.upstreamTaskId }); } catch { result = null; }
        const data = result?.data || {};
        if (!result?.ok || data.raw?.paymentConfirmed !== false || data.unpaidTerminal !== true || data.upstreamStatus !== "failed") {
          return { ok: false, status: 409, message: "原任务未明确返回终止且未扣款，继续保留待确认占用。" };
        }
        const confirmation = store.confirmHifupayUnpaidFailure(id, config.hifupayFailureConfirmSeconds);
        if (!confirmation.eligible) return { ok: false, status: 409, message: "首次确认未扣款已记录；请至少间隔安全复核时间后再次核实。" };
      }
      let cards;
      try { cards = await adapter.listCards(); } catch { cards = null; }
      if (!cards?.ok || !Array.isArray(cards.data?.cards)) return { ok: false, status: 409, message: "无法取得付款卡实时余额，保留占用。" };
      store.syncHifupayCards(cards.data.cards);
      const inspection = store.inspectHifupayReservation(order.hifupayCardId, id, config.hifupayBalanceToleranceUsd);
      if (!inspection.safeToRelease) return { ok: false, status: 409, message: "卡片余额有变化或状态不可用，保留占用。" };
      store.clearHifupayReservation(order.hifupayCardId, id);
      store.updateOrder(id, { status: "manual_queued", fulfillmentMode: "manual", message: publicMessage.manual_queued,
        processingNote: String(note).slice(0, 1000), hifupayReservationReleasedAt: new Date().toISOString(),
        hifupayReservationReleaseReason: "admin_confirmed_no_charge" });
      store.addLog({ orderId: id, step: "pro.admin.confirm-no-charge", requestSummary: "admin attestation + live balance", responseSummary: "released_to_manual" });
      return { ok: true, status: 200, data: expose(readOrder(id)) };
    },
    recoverOnStart() {
      for (const order of store.listProOrders()) if (order.status === "submitting") {
        store.updateOrder(order.id, { status: "needs_review", message: publicMessage.needs_review });
        store.addLog({ orderId: order.id, step: "pro.restart.ambiguous", requestSummary: "", responseSummary: "reservation_retained" });
      }
    },
    async reconcile() { for (const order of store.listProOrders()) if (order.upstreamTaskId && (order.status !== "success" || order.subscriptionCancellationStatus === "pending")) await refresh(order.id); await drain(); }
  };
}

export const proService = createProService();
