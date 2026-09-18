import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";
import { decryptSecretText, encryptSecretText } from "./utils.js";

const PROVIDER_CONFIG_VERSION = 2;
const RECHARGE_SECRET_RETENTION_DAYS = 45;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function cardCodeHash(cardCode) {
  return crypto.createHash("sha256").update(cardCode).digest("hex");
}

function cardMask(cardCode) {
  return cardCode.length <= 8 ? `${cardCode.slice(0, 2)}****${cardCode.slice(-2)}` : `${cardCode.slice(0, 4)}****${cardCode.slice(-4)}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAccountId(value) {
  return String(value || "").trim();
}

function hasAccountIdentity(identity = {}) {
  return Boolean(normalizeEmail(identity.email) || normalizeAccountId(identity.accountId));
}

function cardIdentityMatches(card, identity = {}) {
  const email = normalizeEmail(identity.email);
  const accountId = normalizeAccountId(identity.accountId);
  const checks = [];
  if (card.boundEmail) checks.push(email && card.boundEmail === email);
  if (card.boundAccountId) checks.push(accountId && card.boundAccountId === accountId);
  return checks.length > 0 && checks.every(Boolean);
}

function hifupayIdentityMatches(user, identity = {}) {
  const email = normalizeEmail(identity.email);
  const accountId = normalizeAccountId(identity.accountId);
  return Boolean(
    (email && normalizeEmail(user?.email) === email) ||
    (accountId && normalizeAccountId(user?.accountId) === accountId)
  );
}

function hifupayCardId(value) {
  return String(value ?? "").trim();
}

function hifupayRemoteStatus(value) {
  const status = String(value || "active").trim().toLowerCase();
  return status || "active";
}

function hifupayBalance(value) {
  const balance = Number(value);
  return Number.isFinite(balance) ? balance : null;
}

function hifupayPlusMaxBalance() {
  const maximum = Number(config.hifupayPlusMaxBalanceUsd);
  return Number.isFinite(maximum) && maximum > 0 ? maximum : 66;
}

function activeHifupayProReservation(state, cardId) {
  return state.hifupayProReservations.find(item => item.cardId === cardId && item.status === "active") || null;
}

function pro5xCardHeld(state, cardId) {
  return state.settings.pro5xCardId === cardId || state.orders.some(order => order.plan === "pro_x5" && order.fulfillmentMode === "auto" &&
    order.hifupayCardId === cardId && ["queued", "submitting", "processing", "needs_review"].includes(order.status));
}

function maxIsoDate(values = []) {
  const dates = values
    .map(value => String(value || ""))
    .filter(Boolean)
    .map(value => ({ value, time: Date.parse(value) }))
    .filter(item => Number.isFinite(item.time))
    .sort((left, right) => right.time - left.time);
  return dates[0]?.value || "";
}

function hCardQueryStatus(card, order) {
  if (card.disabledAt || card.archivedAt || card.status === "expired") return "disabled";
  if (card.status === "unused") return "unused";
  if (card.status === "used" || order?.status === "success") return "success";
  if (order?.status === "failed") return "failed";
  if (
    card.status === "reserved" ||
    ["created", "queued", "processing", "syncing", "needs_review", "manual_queued", "manual_processing", "needs_info", "submitting"].includes(order?.status)
  ) return "processing";
  return "locked";
}

function hCardCompletedAt(card, order, status) {
  if (status === "success") return card.usedAt || order?.manualCompletedAt || order?.updatedAt || "";
  if (status === "failed") return order?.updatedAt || "";
  if (status === "disabled") return card.disabledAt || card.archivedAt || card.updatedAt || "";
  return "";
}

function protectionKey() {
  return config.recoveryEncryptionKey || config.adminToken || "local-development-only";
}

function encryptProtected(value, context) {
  return encryptSecretText(value, protectionKey(), context);
}

function decryptProtected(value, context) {
  return decryptSecretText(value, protectionKey(), context);
}

function generateCardCode(plan = "plus") {
  const prefix = { plus: "HPLUS", pro_x5: "HPRO5", pro_x20: "HPRO20" }[plan];
  if (!prefix) throw new Error("不支持的卡密套餐。");
  return `${prefix}${crypto.randomBytes(16).toString("hex").toUpperCase()}`;
}

function createInitialState() {
  return {
    orders: [],
    rechargeSessions: [],
    rechargeLogs: [],
    hCards: [],
    hifupayCards: [],
    hifupayProReservations: [],
    settings: {
      defaultProvider: config.defaultProvider,
      providerConfigVersion: PROVIDER_CONFIG_VERSION,
      providerUpdatedAt: "",
      providerUpdatedBy: "",
      hifupayCardsUpdatedAt: "",
      pro5xAutoEnabled: false,
      pro5xCardId: "",
      pro5xRegion: "EG",
      pro5xEstimatedChargeUsd: 0,
      pro5xSafetyBufferUsd: 0
    }
  };
}

function normalizeState(state) {
  const initial = createInitialState();
  const savedSettings = state?.settings || {};
  const settings = {
    ...initial.settings,
    ...savedSettings
  };

  if (Number(savedSettings.providerConfigVersion || 0) < PROVIDER_CONFIG_VERSION) {
    settings.defaultProvider = config.defaultProvider;
    settings.providerConfigVersion = PROVIDER_CONFIG_VERSION;
    settings.providerUpdatedAt = nowIso();
    settings.providerUpdatedBy = "provider-config-v2";
  }

  return {
    ...initial,
    ...state,
    orders: Array.isArray(state?.orders) ? state.orders : [],
    rechargeSessions: Array.isArray(state?.rechargeSessions) ? state.rechargeSessions : [],
    rechargeLogs: Array.isArray(state?.rechargeLogs) ? state.rechargeLogs : [],
    hCards: Array.isArray(state?.hCards) ? state.hCards : [],
    hifupayCards: Array.isArray(state?.hifupayCards) ? state.hifupayCards : [],
    hifupayProReservations: Array.isArray(state?.hifupayProReservations) ? state.hifupayProReservations : [],
    settings
  };
}

export class JsonStore {
  constructor(filePath = config.dataFile) {
    this.filePath = filePath;
    ensureDir(filePath);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, JSON.stringify(createInitialState(), null, 2));
    }
  }

  read() {
    const raw = fs.readFileSync(this.filePath, "utf8");
    return raw.trim() ? normalizeState(JSON.parse(raw)) : createInitialState();
  }

  write(state) {
    ensureDir(this.filePath);
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }

  createOrder(input) {
    const state = this.read();
    const order = {
      id: makeId("order"),
      siteSource: input.siteSource || "unknown",
      provider: input.provider || config.defaultProvider,
      cardMask: input.cardMask || "",
      productId: input.productId ?? config.defaultProductId,
      status: input.status || "created",
      upstreamTaskId: input.upstreamTaskId || "",
      hCardId: input.hCardId || "",
      hifupayCardId: input.hifupayCardId || "",
      providerSessionId: input.providerSessionId || "",
      hifupayCardLastFour: input.hifupayCardLastFour || "",
      hifupaySafetyStatus: input.hifupaySafetyStatus || "",
      hifupayUnpaidConfirmationCount: Number(input.hifupayUnpaidConfirmationCount || 0),
      hifupayUnpaidFirstSeenAt: input.hifupayUnpaidFirstSeenAt || "",
      hifupayUnpaidLastConfirmedAt: input.hifupayUnpaidLastConfirmedAt || "",
      hifupayUnpaidLastObservedAt: input.hifupayUnpaidLastObservedAt || "",
      hifupayReservationReleasedAt: input.hifupayReservationReleasedAt || "",
      hifupayReservationReleaseReason: input.hifupayReservationReleaseReason || "",
      cardInfoCiphertext: input.cardInfoCiphertext || "",
      message: input.message || "",
      subscriptionCancellationStatus: input.subscriptionCancellationStatus || "",
      subscriptionActionRequired: Boolean(input.subscriptionActionRequired),
      subscriptionActionMessage: input.subscriptionActionMessage || "",
      subscriptionActionDetectedAt: input.subscriptionActionDetectedAt || "",
      subscriptionActionHandledAt: input.subscriptionActionHandledAt || "",
      subscriptionActionHandledBy: input.subscriptionActionHandledBy || "",
      subscriptionAlertAttemptedAt: input.subscriptionAlertAttemptedAt || "",
      subscriptionAlertNotifiedAt: input.subscriptionAlertNotifiedAt || "",
      subscriptionFollowUpUntil: input.subscriptionFollowUpUntil || "",
      subscriptionClassifierVersion: Number(input.subscriptionClassifierVersion || 0),
      lastStatusSyncAt: input.lastStatusSyncAt || "",
      overwriteRecharge: Boolean(input.overwriteRecharge),
      createdAt: nowIso(),
      updatedAt: nowIso()
    };
    state.orders.push(order);
    this.write(state);
    return order;
  }

  updateOrder(orderId, patch) {
    const state = this.read();
    const order = state.orders.find((item) => item.id === orderId);
    if (!order) return null;
    Object.assign(order, patch, { updatedAt: nowIso() });
    this.write(state);
    return order;
  }

  getOrder(orderId) {
    const state = this.read();
    return state.orders.find((item) => item.id === orderId) || null;
  }

  getOrderByUpstreamTaskId(upstreamTaskId) {
    const state = this.read();
    return state.orders.find((item) => item.upstreamTaskId === upstreamTaskId) || null;
  }

  listHOrdersForSubscriptionSync({ lookbackHours = 72, processingHours = 6, limit = 20 } = {}) {
    const now = Date.now();
    const successCutoff = now - Math.max(Number(lookbackHours) || 72, 1) * 60 * 60 * 1000;
    const processingCutoff = now - Math.max(Number(processingHours) || 6, 1) * 60 * 60 * 1000;
    return this.read().orders
      .filter(order => {
        if (order.provider !== "h" || !order.upstreamTaskId) return false;
        const createdAt = Date.parse(order.createdAt);
        if (["created", "queued", "processing", "needs_review"].includes(order.status)) {
          return Number.isFinite(createdAt) && createdAt >= processingCutoff;
        }
        if (order.status !== "success") return false;
        const cancellationStatus = order.subscriptionCancellationStatus || "";
        if (cancellationStatus === "cancelled") return false;
        if (["failed", "unknown"].includes(cancellationStatus) && Number(order.subscriptionClassifierVersion || 0) >= 2) return false;
        return Number.isFinite(createdAt) && createdAt >= successCutoff;
      })
      .sort((left, right) => String(left.lastStatusSyncAt || left.updatedAt || left.createdAt).localeCompare(String(right.lastStatusSyncAt || right.updatedAt || right.createdAt)))
      .slice(0, Math.max(Number(limit) || 20, 1))
      .map(order => ({ id: order.id, status: order.status, subscriptionFollowUpUntil: order.subscriptionFollowUpUntil || "" }));
  }

  markHSubscriptionHandled(orderId, operator = "admin") {
    const state = this.read();
    const order = state.orders.find(item => item.id === orderId);
    if (!order) return { ok: false, status: "not_found", message: "订单不存在。" };
    if (order.provider !== "h" || !order.subscriptionActionRequired) {
      return { ok: false, status: "not_required", message: "这笔订单没有待处理的自动续费提醒。" };
    }
    order.subscriptionActionHandledAt = order.subscriptionActionHandledAt || nowIso();
    order.subscriptionActionHandledBy = operator;
    order.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: "handled", orderId: order.id, handledAt: order.subscriptionActionHandledAt };
  }

  listPendingHSubscriptionAlerts(retryMinutes = 5) {
    const state = this.read();
    const sessions = new Map(state.rechargeSessions.map(session => [session.orderId, session]));
    const retryCutoff = Date.now() - Math.max(Number(retryMinutes) || 5, 1) * 60 * 1000;
    return state.orders
      .filter(order => {
        if (order.provider !== "h" || !order.subscriptionActionRequired || order.subscriptionActionHandledAt || order.subscriptionAlertNotifiedAt) return false;
        const attemptedAt = Date.parse(order.subscriptionAlertAttemptedAt);
        return !Number.isFinite(attemptedAt) || attemptedAt <= retryCutoff;
      })
      .map(order => ({
        id: order.id,
        userEmail: sessions.get(order.id)?.userEmail || "",
        cardMask: order.cardMask || "",
        createdAt: order.createdAt || "",
        message: order.subscriptionActionMessage || "充值成功，但自动续费未关闭，请联系用户手动取消。"
      }));
  }

  markHSubscriptionAlertAttempt(orderId, notified = false) {
    const state = this.read();
    const order = state.orders.find(item => item.id === orderId);
    if (!order) return false;
    const timestamp = nowIso();
    order.subscriptionAlertAttemptedAt = timestamp;
    if (notified) order.subscriptionAlertNotifiedAt = timestamp;
    order.updatedAt = timestamp;
    this.write(state);
    return true;
  }

  getSettings() {
    return this.read().settings;
  }

  updateSettings(patch) {
    const state = this.read();
    state.settings = {
      ...state.settings,
      ...patch
    };
    this.write(state);
    return state.settings;
  }

  updatePro5xSettings(input) {
    const state = this.read();
    const cardId = String(input.cardId || "").trim();
    const region = String(input.region || "EG").trim().toUpperCase();
    const charge = Number(input.estimatedChargeUsd);
    const buffer = Number(input.safetyBufferUsd);
    if (cardId && !state.hifupayCards.some(card => card.id === cardId)) return { ok: false, message: "指定卡片不在本地卡池中。" };
    if (!/^[A-Z]{2}$/.test(region) || !Number.isFinite(charge) || charge < 0 || !Number.isFinite(buffer) || buffer < 0) return { ok: false, message: "地区或余额参数无效。" };
    if (input.enabled && (!cardId || charge <= 0)) return { ok: false, message: "开启前请指定卡片并填写预计扣款额。" };
    Object.assign(state.settings, {
      pro5xAutoEnabled: input.enabled === true,
      pro5xCardId: cardId,
      pro5xRegion: region,
      pro5xEstimatedChargeUsd: charge,
      pro5xSafetyBufferUsd: buffer
    });
    this.write(state);
    return { ok: true, settings: state.settings };
  }

  // A synchronous transaction: one card can own only one effective order, even for concurrent HTTP requests.
  createProOrder({ code, identity, source, ciphertext, session }) {
    const state = this.read();
    const card = state.hCards.find(item => item.codeHash === cardCodeHash(String(code).toUpperCase()));
    if (!card || !["pro_x5", "pro_x20"].includes(card.plan)) return { ok: false, status: 404, message: "未找到 Pro 套餐卡密。" };
    const existing = state.orders.find(item => item.id === card.orderId);
    if (existing) {
      if (!cardIdentityMatches(card, identity)) return { ok: false, status: 409, message: "卡密已绑定其他账号。" };
      return { ok: true, existing: true, order: existing };
    }
    if (card.disabledAt || card.archivedAt || card.status !== "unused") return { ok: false, status: 409, message: "卡密当前不可使用。" };
    const settings = state.settings;
    const configuredId = card.plan === "pro_x5" ? settings.pro5xCardId || "" : "";
    const selectedId = settings.pro5xAutoEnabled ? configuredId : "";
    const selected = state.hifupayCards.find(item => item.id === selectedId);
    const charge = Number(settings.pro5xEstimatedChargeUsd);
    const buffer = Number(settings.pro5xSafetyBufferUsd);
    const protection = selected && (selected.usageMode === "pro_reserved" || activeHifupayProReservation(state, selected.id));
    const available = selected && selected.enabled !== false && hifupayRemoteStatus(selected.status) === "active" && !protection &&
      selected.balance !== null && Number.isFinite(charge) && charge > 0 && selected.balance >= charge + buffer;
    const auto = Boolean(selectedId && available);
    const reason = card.plan === "pro_x5" && settings.pro5xAutoEnabled && !auto ? "指定付款卡不可用或余额不足，已转人工处理。" : "已进入充值队列，请稍后，完成后可在本页查询结果。";
    const timestamp = nowIso();
    const order = {
      id: makeId("order"), provider: "h", plan: card.plan, productId: card.productId,
      fulfillmentMode: auto ? "auto" : "manual", initialFulfillmentMode: auto ? "auto" : "manual",
      autoEnabledSnapshot: card.plan === "pro_x5" && settings.pro5xAutoEnabled === true,
      selectedCardSnapshotId: configuredId, status: auto ? "queued" : "manual_queued",
      siteSource: source || "unknown", cardMask: card.cardMask, hCardId: card.id,
      hifupayCardId: auto ? selectedId : "", hifupayCardLastFour: auto ? selected.lastFour || "" : "",
      proRegion: settings.pro5xRegion || "EG", estimatedChargeUsd: Number.isFinite(charge) ? charge : 0,
      safetyBufferUsd: Number.isFinite(buffer) ? buffer : 0, message: reason, processingNote: "",
      cardInfoCiphertext: ciphertext, upstreamTaskId: "", paymentConfirmed: false, autoCancelDone: false,
      subscriptionCancellationStatus: "not_started", createdAt: timestamp, updatedAt: timestamp
    };
    Object.assign(card, { status: "locked", orderId: order.id, boundEmail: normalizeEmail(identity.email),
      boundAccountId: normalizeAccountId(identity.accountId), boundAt: timestamp, hasSubmission: true, submittedAt: timestamp, updatedAt: timestamp });
    state.orders.push(order);
    state.rechargeSessions.push({ id: makeId("session"), orderId: order.id, userEmail: session.userEmail,
      tokenHash: session.tokenHash, authDataCiphertext: session.authDataCiphertext,
      rawSecretCiphertext: session.rawSecretCiphertext, createdAt: timestamp });
    state.rechargeLogs.push({ id: makeId("log"), orderId: order.id, step: "pro.created", requestSummary: "",
      responseSummary: order.fulfillmentMode, createdAt: timestamp });
    this.write(state);
    return { ok: true, existing: false, order };
  }

  claimNextProOrder() {
    const state = this.read();
    const order = state.orders.find(item => item.plan === "pro_x5" && item.fulfillmentMode === "auto" && item.status === "queued");
    if (!order) return null;
    const card = state.hifupayCards.find(item => item.id === order.hifupayCardId);
    if (!card) return this.moveProToManual(order.id, "指定付款卡不存在，已转人工处理。");
    if ((card.inFlightOrders || []).length) return null;
    if (card.enabled === false || hifupayRemoteStatus(card.status) !== "active" || card.usageMode === "pro_reserved" || activeHifupayProReservation(state, card.id) ||
      card.balance === null || card.balance < order.estimatedChargeUsd + order.safetyBufferUsd) {
      return this.moveProToManual(order.id, "指定付款卡不可用或余额不足，已转人工处理。");
    }
    card.inFlightOrders ||= [];
    card.inFlightOrders.push({ orderId: order.id, plan: "pro_x5", email: state.rechargeSessions.find(item => item.orderId === order.id)?.userEmail || "",
      estimatedChargeUsd: order.estimatedChargeUsd, balanceBefore: card.balance, state: "submitting", reservedAt: nowIso() });
    order.status = "submitting"; order.message = "充值任务正在提交，请勿重复操作。"; order.updatedAt = nowIso();
    this.write(state);
    return order;
  }

  moveProToManual(orderId, reason) {
    const state = this.read();
    const order = state.orders.find(item => item.id === orderId && item.plan === "pro_x5");
    if (!order || order.status !== "queued") return null;
    order.status = "manual_queued"; order.fulfillmentMode = "manual"; order.message = reason;
    order.updatedAt = nowIso(); this.write(state);
    return order;
  }

  listProOrders() {
    const state = this.read();
    return state.orders.filter(item => item.plan === "pro_x5" || item.plan === "pro_x20")
      .map(order => ({ ...order, session: state.rechargeSessions.find(item => item.orderId === order.id) || null }));
  }

  getHifupayEstimatedCharge(plan = "plus") {
    const normalizedPlan = String(plan || "plus").toLowerCase();
    if (normalizedPlan !== "plus") return Math.max(Number(config.hifupayEstimatedProChargeUsd) || 0, 0);
    const learned = Number(this.read().settings.hifupayLastPlusChargeUsd);
    return Number.isFinite(learned) && learned > 0 ? learned : Math.max(Number(config.hifupayEstimatedPlusChargeUsd) || 16, 0);
  }

  createRechargeSession(input) {
    const state = this.read();
    const session = {
      id: makeId("session"),
      orderId: input.orderId,
      userEmail: input.userEmail || "",
      tokenHash: input.tokenHash || "",
      authDataCiphertext: input.authDataCiphertext || "",
      rawSecretCiphertext: input.rawSecretCiphertext || "",
      authDataEncoded: input.authDataEncoded || "",
      createdAt: nowIso()
    };
    state.rechargeSessions.push(session);
    this.write(state);
    return session;
  }

  addLog(input) {
    const state = this.read();
    const log = {
      id: makeId("log"),
      orderId: input.orderId || "",
      step: input.step || "",
      requestSummary: input.requestSummary || "",
      responseSummary: input.responseSummary || "",
      createdAt: nowIso()
    };
    state.rechargeLogs.push(log);
    this.write(state);
    return log;
  }

  createHCards({ count = 1, productId = 3, source = "未分类", plan = "plus" } = {}) {
    if (!["plus", "pro_x5", "pro_x20"].includes(plan)) throw new Error("不支持的卡密套餐。");
    const safeCount = Math.min(Math.max(Number(count) || 1, 1), 100);
    const createdAt = nowIso();
    const batchId = makeId("batch");
    const normalizedSource = String(source || "未分类").trim().slice(0, 40) || "未分类";
    const state = this.read();
    const result = [];

    for (let index = 0; index < safeCount; index += 1) {
      const code = generateCardCode(plan);
      const card = {
        id: makeId("hcard"),
        provider: "h",
        batchId,
        source: normalizedSource,
        productId: Number(productId) || 3,
        plan,
        codeHash: cardCodeHash(code),
        codeCiphertext: encryptProtected(code, "h-card-code"),
        cardMask: cardMask(code),
        status: "unused",
        orderId: "",
        boundEmail: "",
        boundAccountId: "",
        boundAt: "",
        lockReason: "",
        disabledAt: "",
        disabledReason: "",
        archivedAt: "",
        hasSubmission: false,
        submittedAt: "",
        expiresAt: "",
        createdAt,
        updatedAt: createdAt
      };
      state.hCards.push(card);
      result.push({
        id: card.id,
        sequence: index + 1,
        code,
        cardMask: card.cardMask,
        status: card.status,
        plan,
        source: card.source,
        batchId,
        createdAt,
        expiresAt: "",
        link: `https://www.gptc.cc/activate/?provider=h&card=${encodeURIComponent(code)}`
      });
    }

    this.write(state);
    return result;
  }

  listHCards(limit = 100, all = false, reveal = false, includeArchived = false) {
    const cards = this.read().hCards.filter(card => includeArchived || !card.archivedAt);
    const selected = all
      ? cards
      : cards.slice(-Math.min(Math.max(Number(limit) || 100, 1), 500));
    return selected
      .reverse()
      .map(card => ({
        id: card.id,
        provider: card.provider,
        batchId: card.batchId || "",
        source: card.source || "未分类",
        productId: card.productId,
        plan: card.plan || "plus",
        cardMask: card.cardMask,
        ...(reveal && card.codeCiphertext ? { code: decryptProtected(card.codeCiphertext, "h-card-code") } : {}),
        status: card.disabledAt ? "disabled" : card.status,
        orderId: card.orderId || "",
        boundEmail: card.boundEmail || "",
        boundAccountId: card.boundAccountId || "",
        boundAt: card.boundAt || "",
        lockReason: card.lockReason || "",
        disabledAt: card.disabledAt || "",
        disabledReason: card.disabledReason || "",
        archivedAt: card.archivedAt || "",
        hasSubmission: Boolean(card.hasSubmission || card.submittedAt || card.boundAt || card.usedAt),
        submittedAt: card.submittedAt || card.boundAt || "",
        expiresAt: card.expiresAt || "",
        createdAt: card.createdAt,
        usedAt: card.usedAt || ""
      }));
  }

  syncHifupayCards(remoteCards = []) {
    const state = this.read();
    const timestamp = nowIso();
    const cards = Array.isArray(remoteCards) ? remoteCards : [];
    const seenIds = new Set();

    for (const remote of cards) {
      const id = hifupayCardId(remote.id ?? remote.cardId ?? remote.card_id);
      if (!id) continue;
      seenIds.add(id);
      const current = state.hifupayCards.find(item => item.id === id);
      const card = current || {
        id,
        lastFour: "",
        status: "active",
        balance: null,
        expiryDate: "",
        enabled: true,
        usageMode: "plus",
        priority: 0,
        plusUsers: [],
        inFlightOrders: [],
        createdAt: timestamp
      };
      Object.assign(card, {
        id,
        lastFour: String(remote.lastFour ?? remote.last4 ?? remote.last_four ?? card.lastFour ?? ""),
        status: hifupayRemoteStatus(remote.status ?? remote.state ?? card.status),
        balance: hifupayBalance(remote.balance ?? remote.availableBalance ?? remote.available_balance ?? card.balance),
        expiryDate: String(remote.expiryDate ?? remote.expiry_date ?? remote.expiry ?? card.expiryDate ?? ""),
        updatedAt: timestamp
      });
      if (!Array.isArray(card.plusUsers)) card.plusUsers = [];
      if (!Array.isArray(card.inFlightOrders)) card.inFlightOrders = [];
      if (typeof card.enabled !== "boolean") card.enabled = true;
      if (!card.usageMode) card.usageMode = "plus";
      if (!state.hifupayCards.includes(card)) state.hifupayCards.push(card);
    }

    for (const card of state.hifupayCards) {
      if (!seenIds.has(card.id)) {
        card.status = "unavailable";
        card.updatedAt = timestamp;
      }
    }

    state.settings.hifupayCardsUpdatedAt = timestamp;
    this.write(state);
    return this.listHifupayCards();
  }

  listHifupayCards() {
    const state = this.read();
    const maxPlusUsers = Math.max(Number(config.hifupayMaxPlusUsers) || 4, 1);
    const learnedCharge = Number(state.settings.hifupayLastPlusChargeUsd);
    const estimatedCharge = Number.isFinite(learnedCharge) && learnedCharge > 0
      ? learnedCharge
      : Math.max(Number(config.hifupayEstimatedPlusChargeUsd) || 16, 0);
    const safetyBuffer = Math.max(Number(config.hifupaySafetyBufferUsd) || 0, 0);
    const plusMaxBalance = hifupayPlusMaxBalance();
    return state.hifupayCards.map(card => {
      const plusUsers = Array.isArray(card.plusUsers) ? card.plusUsers : [];
      const inFlightOrders = Array.isArray(card.inFlightOrders) ? card.inFlightOrders : [];
      const plusInFlight = inFlightOrders.filter(item => item.plan === "plus").length;
      const reservedBalance = inFlightOrders.reduce((sum, item) => sum + (Number(item.estimatedChargeUsd) || 0), 0);
      const holdUntil = maxIsoDate(plusUsers.map(user => user.upgradeUntil));
      const full = false;
      const expiredHold = full && (!holdUntil || Date.parse(holdUntil) <= Date.now());
      const proReservation = activeHifupayProReservation(state, card.id);
      const proProtected = card.usageMode === "pro_reserved" || Boolean(proReservation);
      const pro5xSelected = pro5xCardHeld(state, card.id);
      const highBalanceProtected = card.balance !== null && card.balance > plusMaxBalance;
      let poolStatus = "ready";
      if (proProtected || pro5xSelected) poolStatus = "pro_protected";
      else if (!card.enabled) poolStatus = "disabled";
      else if (hifupayRemoteStatus(card.status) !== "active") poolStatus = "upstream_unavailable";
      else if (highBalanceProtected) poolStatus = "high_balance";
      else if (full) poolStatus = expiredHold ? "full_expired" : "full_hold";
      else if (card.balance === null || card.balance - reservedBalance < estimatedCharge + safetyBuffer) poolStatus = "low_balance";
      else if (plusInFlight > 0) poolStatus = "reserved";

      return {
        id: card.id,
        lastFour: card.lastFour || "",
        status: hifupayRemoteStatus(card.status),
        poolStatus,
        enabled: card.enabled !== false,
        usageMode: card.usageMode || "plus",
        proProtected,
        pro5xSelected,
        highBalanceProtected,
        plusMaxBalance,
        proReservation: proReservation ? {
          id: proReservation.id,
          type: proReservation.type || "Pro",
          account: proReservation.account || "",
          amountUsd: Number(proReservation.amountUsd) || 0,
          renewalAt: proReservation.renewalAt || "",
          note: proReservation.note || "",
          createdAt: proReservation.createdAt || ""
        } : null,
        priority: Number(card.priority) || 0,
        balance: card.balance,
        reservedBalance,
        availableBalance: card.balance === null ? null : Math.max(card.balance - reservedBalance, 0),
        maxPlusUsers,
        plusUsed: plusUsers.length,
        automaticPlusUsed: plusUsers.length,
        plusRemaining: null,
        inFlightCount: inFlightOrders.length,
        holdUntil,
        expiryDate: card.expiryDate || "",
        plusUsers: plusUsers.map(user => ({
          email: user.email || "",
          accountId: user.accountId || "",
          orderId: user.orderId || "",
          plusAt: user.plusAt || "",
          upgradeUntil: user.upgradeUntil || "",
          proAt: user.proAt || ""
        })),
        inFlightOrders: inFlightOrders.map(item => ({
          orderId: item.orderId || "",
          plan: item.plan || "",
          email: item.email || "",
          accountId: item.accountId || "",
          estimatedChargeUsd: Number(item.estimatedChargeUsd) || 0,
          state: item.state || "processing",
          reservedAt: item.reservedAt || ""
        })),
        updatedAt: card.updatedAt || card.createdAt || ""
      };
    }).sort((left, right) => (left.priority - right.priority) || left.id.localeCompare(right.id));
  }

  reserveHifupayCard({ orderId, plan = "plus", identity = {}, estimatedChargeUsd = 0, preferredCardId = "" } = {}) {
    const normalizedOrderId = String(orderId || "").trim();
    const normalizedPlan = String(plan || "plus").trim().toLowerCase();
    if (!normalizedOrderId) return { ok: false, status: "invalid", message: "缺少订单号，无法选择嗨付卡片。" };

    const state = this.read();
    const maxPlusUsers = Math.max(Number(config.hifupayMaxPlusUsers) || 4, 1);
    const charge = Math.max(Number(estimatedChargeUsd) || 0, 0);
    const safetyBuffer = Math.max(Number(config.hifupaySafetyBufferUsd) || 0, 0);
    const plusMaxBalance = hifupayPlusMaxBalance();
    if (normalizedPlan !== "plus" && charge <= 0) {
      return { ok: false, status: "unavailable", message: "Pro 充值金额尚未配置，暂不自动选择卡片。" };
    }
    const candidates = [];

    for (const card of state.hifupayCards) {
      if (card.inFlightOrders?.some(item => item.orderId === normalizedOrderId)) {
        if (normalizedPlan === "plus" && (
          card.usageMode === "pro_reserved" ||
          activeHifupayProReservation(state, card.id) ||
          pro5xCardHeld(state, card.id) ||
          (card.balance !== null && card.balance > plusMaxBalance)
        )) {
          return { ok: false, status: "protected", message: "原预留卡片已进入 Pro 或高余额保护，充值未提交。" };
        }
        return { ok: true, cardId: card.id, hifupayCardId: card.id, lastFour: card.lastFour || "", reused: true };
      }
      if (card.enabled === false || hifupayRemoteStatus(card.status) !== "active") continue;
      if (normalizedPlan === "plus" && (
        card.usageMode === "pro_reserved" ||
        activeHifupayProReservation(state, card.id) ||
        pro5xCardHeld(state, card.id) ||
        (card.balance !== null && card.balance > plusMaxBalance)
      )) continue;
      if (card.balance === null || card.balance < charge + safetyBuffer) continue;
      const inFlight = Array.isArray(card.inFlightOrders) ? card.inFlightOrders : [];
      const reservedBalance = inFlight.reduce((sum, item) => sum + (Number(item.estimatedChargeUsd) || 0), 0);
      if (card.balance - reservedBalance < charge + safetyBuffer) continue;
      const plusUsers = Array.isArray(card.plusUsers) ? card.plusUsers : [];
      if (normalizedPlan === "plus") {
        if (plusUsers.some(user => hifupayIdentityMatches(user, identity))) continue;
      } else {
        const boundUser = plusUsers.find(user => hifupayIdentityMatches(user, identity));
        if (!boundUser || !boundUser.upgradeUntil || Date.parse(boundUser.upgradeUntil) <= Date.now()) continue;
      }

      candidates.push({ card, plusUsers, inFlight });
    }

    candidates.sort((left, right) => {
      // 足额候选中优先消耗可用余额较少的卡，避免长期闲置低余额卡；priority 仅作为并列时的稳定排序。
      const leftAvailable = Number(left.card.balance) - left.inFlight.reduce((sum, item) => sum + (Number(item.estimatedChargeUsd) || 0), 0);
      const rightAvailable = Number(right.card.balance) - right.inFlight.reduce((sum, item) => sum + (Number(item.estimatedChargeUsd) || 0), 0);
      return leftAvailable - rightAvailable
        || (Number(left.card.priority) || 0) - (Number(right.card.priority) || 0)
        || left.card.id.localeCompare(right.card.id);
    });

    const selected = candidates[0]?.card;
    if (!selected) {
      return {
        ok: false,
        status: "unavailable",
        message: normalizedPlan === "plus"
          ? `当前没有可用于 Plus 的卡片：余额需足够且不能超过 $${plusMaxBalance.toFixed(2)}，同时不能处于 Pro 保护。`
          : "当前账号没有处于 30 天升级期内的嗨付卡片。"
      };
    }

    if (!Array.isArray(selected.inFlightOrders)) selected.inFlightOrders = [];
    selected.inFlightOrders.push({
      orderId: normalizedOrderId,
      plan: normalizedPlan,
      email: normalizeEmail(identity.email),
      accountId: normalizeAccountId(identity.accountId),
      estimatedChargeUsd: charge,
      balanceBefore: selected.balance,
      state: "processing",
      reservedAt: nowIso()
    });
    selected.updatedAt = nowIso();
    this.write(state);
    return { ok: true, cardId: selected.id, hifupayCardId: selected.id, lastFour: selected.lastFour || "", reused: false };
  }

  validateHifupayCardForSubmission({ cardId, orderId, plan = "plus", estimatedChargeUsd = 0 } = {}) {
    const state = this.read();
    const normalizedCardId = hifupayCardId(cardId);
    const normalizedOrderId = String(orderId || "").trim();
    const normalizedPlan = String(plan || "plus").trim().toLowerCase();
    const card = state.hifupayCards.find(item => item.id === normalizedCardId);
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不在本地卡池中，充值未提交。" };
    const inFlight = Array.isArray(card.inFlightOrders) ? card.inFlightOrders : [];
    const reservation = inFlight.find(item => item.orderId === normalizedOrderId);
    if (!reservation) return { ok: false, status: "reservation_missing", message: "嗨付卡片预留已失效，充值未提交。" };
    if (card.enabled === false) return { ok: false, status: "disabled", message: "嗨付卡片已暂停使用，充值未提交。" };
    if (hifupayRemoteStatus(card.status) !== "active") {
      return { ok: false, status: "upstream_unavailable", message: "嗨付卡片当前不可用，充值未提交。" };
    }

    const charge = Math.max(Number(estimatedChargeUsd) || Number(reservation.estimatedChargeUsd) || 0, 0);
    const safetyBuffer = Math.max(Number(config.hifupaySafetyBufferUsd) || 0, 0);
    if (normalizedPlan === "plus") {
      const plusMaxBalance = hifupayPlusMaxBalance();
      if (card.usageMode === "pro_reserved" || activeHifupayProReservation(state, card.id) || pro5xCardHeld(state, card.id)) {
        return { ok: false, status: "pro_protected", message: "这张嗨付卡已为 Pro 续费保留，Plus 充值未提交。" };
      }
      if (card.balance !== null && card.balance > plusMaxBalance) {
        return { ok: false, status: "high_balance", message: `这张嗨付卡余额超过 $${plusMaxBalance.toFixed(2)}，已触发高余额保护，Plus 充值未提交。` };
      }
    }
    if (card.balance === null) return { ok: false, status: "balance_unknown", message: "无法确认嗨付卡实时余额，充值未提交。" };
    const otherReservedBalance = inFlight
      .filter(item => item.orderId !== normalizedOrderId)
      .reduce((sum, item) => sum + (Number(item.estimatedChargeUsd) || 0), 0);
    if (card.balance - otherReservedBalance < charge + safetyBuffer) {
      return { ok: false, status: "low_balance", message: "嗨付卡可用余额不足，充值未提交。" };
    }
    return { ok: true, status: "ready", cardId: card.id, lastFour: card.lastFour || "", balance: card.balance };
  }

  protectHifupayCardForPro(cardId, input = {}) {
    const state = this.read();
    const normalizedCardId = hifupayCardId(cardId);
    const card = state.hifupayCards.find(item => item.id === normalizedCardId);
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不存在。" };
    if (Array.isArray(card.inFlightOrders) && card.inFlightOrders.length) {
      return { ok: false, status: "in_flight", message: "这张卡还有充值待确认，请先处理后再设置 Pro 保护。" };
    }
    const account = String(input.account || "").trim().slice(0, 160);
    if (!account) return { ok: false, status: "invalid", message: "请填写需要续费的 Pro 账号。" };
    const timestamp = nowIso();
    let reservation = activeHifupayProReservation(state, normalizedCardId);
    if (!reservation) {
      reservation = {
        id: makeId("hpro"),
        cardId: normalizedCardId,
        status: "active",
        createdAt: timestamp,
        releasedAt: ""
      };
      state.hifupayProReservations.push(reservation);
    }
    Object.assign(reservation, {
      type: String(input.type || "Pro").trim().slice(0, 40) || "Pro",
      account,
      amountUsd: Math.max(Number(input.amountUsd) || 0, 0),
      renewalAt: String(input.renewalAt || "").trim().slice(0, 40),
      note: String(input.note || "").trim().slice(0, 300),
      status: "active",
      updatedAt: timestamp,
      releasedAt: ""
    });
    card.usageMode = "pro_reserved";
    card.updatedAt = timestamp;
    this.write(state);
    return { ok: true, status: "protected", cardId: card.id, reservationId: reservation.id };
  }

  releaseHifupayCardProProtection(cardId) {
    const state = this.read();
    const normalizedCardId = hifupayCardId(cardId);
    const card = state.hifupayCards.find(item => item.id === normalizedCardId);
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不存在。" };
    const timestamp = nowIso();
    for (const reservation of state.hifupayProReservations) {
      if (reservation.cardId === normalizedCardId && reservation.status === "active") {
        reservation.status = "released";
        reservation.releasedAt = timestamp;
        reservation.updatedAt = timestamp;
      }
    }
    card.usageMode = "plus";
    card.updatedAt = timestamp;
    this.write(state);
    return { ok: true, status: "released", cardId: card.id };
  }

  listStaleHifupayReservationOrders({ staleMinutes = 10, lookbackHours = 168, limit = 20, includeManualReview = false } = {}) {
    const state = this.read();
    const now = Date.now();
    const staleCutoff = now - Math.max(Number(staleMinutes) || 10, 1) * 60 * 1000;
    const lookbackCutoff = now - Math.max(Number(lookbackHours) || 168, 1) * 60 * 60 * 1000;
    const orders = new Map(state.orders.map(order => [order.id, order]));
    const candidates = [];
    for (const card of state.hifupayCards) {
      for (const reservation of Array.isArray(card.inFlightOrders) ? card.inFlightOrders : []) {
        const order = orders.get(String(reservation.orderId || ""));
        const reservedAt = Date.parse(reservation.reservedAt || order?.createdAt || "");
        const createdAt = Date.parse(order?.createdAt || reservation.reservedAt || "");
        if (!order || order.provider !== "h" || !order.upstreamTaskId) continue;
        if (order.hifupayReservationReleasedAt) continue;
        if (!includeManualReview && ["balance_changed", "card_unavailable", "balance_check_failed", "manual_review"].includes(order.hifupaySafetyStatus)) continue;
        if (!Number.isFinite(reservedAt) || reservedAt > staleCutoff) continue;
        if (!Number.isFinite(createdAt) || createdAt < lookbackCutoff) continue;
        candidates.push({ orderId: order.id, cardId: card.id, reservedAt: new Date(reservedAt).toISOString() });
      }
    }
    return candidates
      .sort((left, right) => left.reservedAt.localeCompare(right.reservedAt))
      .slice(0, Math.max(Number(limit) || 20, 1));
  }

  confirmHifupayUnpaidFailure(orderId, minimumGapSeconds = 60) {
    const state = this.read();
    const order = state.orders.find(item => item.id === String(orderId || ""));
    if (!order) return { ok: false, status: "not_found", confirmations: 0, eligible: false };
    const timestamp = nowIso();
    const now = Date.parse(timestamp);
    const lastConfirmedAt = Date.parse(order.hifupayUnpaidLastConfirmedAt || "");
    let confirmations = Math.max(Number(order.hifupayUnpaidConfirmationCount) || 0, 0);
    if (confirmations === 0 || !Number.isFinite(lastConfirmedAt)) {
      confirmations = 1;
      order.hifupayUnpaidFirstSeenAt = order.hifupayUnpaidFirstSeenAt || timestamp;
      order.hifupayUnpaidLastConfirmedAt = timestamp;
    } else if (now - lastConfirmedAt >= Math.max(Number(minimumGapSeconds) || 60, 1) * 1000) {
      confirmations += 1;
      order.hifupayUnpaidLastConfirmedAt = timestamp;
    }
    order.hifupayUnpaidConfirmationCount = confirmations;
    order.hifupayUnpaidLastObservedAt = timestamp;
    order.hifupaySafetyStatus = confirmations >= 2 ? "release_check" : "confirming_unpaid";
    order.updatedAt = timestamp;
    this.write(state);
    return { ok: true, status: order.hifupaySafetyStatus, confirmations, eligible: confirmations >= 2 };
  }

  resetHifupayUnpaidFailure(orderId) {
    const state = this.read();
    const order = state.orders.find(item => item.id === String(orderId || ""));
    if (!order) return false;
    if (!order.hifupayUnpaidConfirmationCount && !order.hifupaySafetyStatus) return true;
    order.hifupaySafetyStatus = "";
    order.hifupayUnpaidConfirmationCount = 0;
    order.hifupayUnpaidFirstSeenAt = "";
    order.hifupayUnpaidLastConfirmedAt = "";
    order.hifupayUnpaidLastObservedAt = "";
    order.updatedAt = nowIso();
    this.write(state);
    return true;
  }

  inspectHifupayReservation(cardId, orderId, toleranceUsd = 0.5) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    const reservation = card?.inFlightOrders?.find(item => item.orderId === String(orderId || ""));
    if (!card || !reservation) return { ok: false, status: "not_found", safeToRelease: false };
    const balanceBefore = reservation.balanceBefore === null || reservation.balanceBefore === undefined
      ? Number.NaN
      : Number(reservation.balanceBefore);
    const currentBalance = card.balance === null || card.balance === undefined ? Number.NaN : Number(card.balance);
    const tolerance = Math.max(Number(toleranceUsd) || 0, 0);
    const active = hifupayRemoteStatus(card.status) === "active";
    const balanceKnown = Number.isFinite(balanceBefore) && Number.isFinite(currentBalance);
    const unchanged = balanceKnown && Math.abs(currentBalance - balanceBefore) <= tolerance;
    return {
      ok: true,
      status: active && unchanged ? "unchanged" : !active ? "card_unavailable" : "balance_changed",
      safeToRelease: active && unchanged,
      cardId: card.id,
      balanceBefore: balanceKnown ? balanceBefore : null,
      currentBalance: Number.isFinite(currentBalance) ? currentBalance : null,
      reservedAt: reservation.reservedAt || ""
    };
  }

  recordHifupayResult({ cardId, orderId, plan = "plus", identity = {}, paymentConfirmed = false, status = "" } = {}) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不在本地卡池中。" };
    if (!Array.isArray(card.inFlightOrders)) card.inFlightOrders = [];
    if (!Array.isArray(card.plusUsers)) card.plusUsers = [];
    const inFlightIndex = card.inFlightOrders.findIndex(item => item.orderId === String(orderId || ""));
    const inFlight = inFlightIndex >= 0 ? card.inFlightOrders[inFlightIndex] : null;

    if (status === "needs_review" && !paymentConfirmed) {
      if (inFlight) inFlight.state = "needs_review";
      card.updatedAt = nowIso();
      this.write(state);
      return { ok: true, status: "needs_review", cardId: card.id };
    }

    let learnedChargeUsd = null;
    if (paymentConfirmed && plan === "plus" && inFlight && card.inFlightOrders.length === 1) {
      const before = Number(inFlight.balanceBefore);
      const after = Number(card.balance);
      const difference = before - after;
      if (Number.isFinite(difference) && difference >= 10 && difference <= 30) {
        learnedChargeUsd = Math.round(difference * 100) / 100;
        state.settings.hifupayLastPlusChargeUsd = learnedChargeUsd;
        state.settings.hifupayLastPlusChargeUpdatedAt = nowIso();
      }
    }
    if (inFlightIndex >= 0) card.inFlightOrders.splice(inFlightIndex, 1);
    if (paymentConfirmed) {
      const email = normalizeEmail(identity.email || inFlight?.email);
      const accountId = normalizeAccountId(identity.accountId || inFlight?.accountId);
      let user = card.plusUsers.find(item => hifupayIdentityMatches(item, { email, accountId }));
      if (plan === "plus") {
        if (!user) {
          const plusAt = nowIso();
          user = {
            email,
            accountId,
            orderId: String(orderId || ""),
            plusAt,
            upgradeUntil: new Date(Date.now() + Math.max(Number(config.hifupayUpgradeWindowDays) || 30, 1) * 24 * 60 * 60 * 1000).toISOString(),
            proAt: ""
          };
          card.plusUsers.push(user);
        }
      } else if (user) {
        user.proAt = nowIso();
      }
    }
    card.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: paymentConfirmed ? "recorded" : "released", cardId: card.id, learnedChargeUsd };
  }

  clearHifupayReservation(cardId, orderId) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    if (!card || !Array.isArray(card.inFlightOrders)) return { ok: false, status: "not_found", message: "嗨付卡片或预留不存在。" };
    const before = card.inFlightOrders.length;
    card.inFlightOrders = card.inFlightOrders.filter(item => item.orderId !== String(orderId || ""));
    if (before === card.inFlightOrders.length) return { ok: false, status: "not_found", message: "嗨付卡片预留不存在。" };
    card.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: "released", cardId: card.id };
  }

  setHifupayCardEnabled(cardId, enabled) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不存在。" };
    card.enabled = Boolean(enabled);
    card.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: card.enabled ? "enabled" : "disabled", cardId: card.id };
  }

  setHifupayCardPriority(cardId, priority) {
    const state = this.read();
    const card = state.hifupayCards.find(item => item.id === hifupayCardId(cardId));
    if (!card) return { ok: false, status: "not_found", message: "嗨付卡片不存在。" };
    card.priority = Math.max(Number(priority) || 0, 0);
    card.updatedAt = nowIso();
    this.write(state);
    return { ok: true, status: "updated", cardId: card.id, priority: card.priority };
  }

  getHCardCode(cardId) {
    const card = this.read().hCards.find(item => item.id === cardId);
    return card?.codeCiphertext ? decryptProtected(card.codeCiphertext, "h-card-code") : "";
  }

  getHCardByCode(cardCode) {
    const normalized = String(cardCode || "").trim().toUpperCase();
    if (!normalized) return null;
    const state = this.read();
    return state.hCards.find(card => card.codeHash === cardCodeHash(normalized)) || null;
  }

  queryHCardsByCodes(cardCodes = []) {
    const normalizedCodes = (Array.isArray(cardCodes) ? cardCodes : [])
      .map(code => String(code || "").trim().toUpperCase());
    const state = this.read();
    const cardsByHash = new Map(
      state.hCards
        .filter(card => card.provider === "h")
        .map(card => [card.codeHash, card])
    );
    const ordersById = new Map(state.orders.map(order => [order.id, order]));
    const latestOrdersByCardId = new Map();

    for (const order of state.orders) {
      if (order.provider !== "h" || !order.hCardId) continue;
      const current = latestOrdersByCardId.get(order.hCardId);
      if (!current || String(order.updatedAt || order.createdAt).localeCompare(String(current.updatedAt || current.createdAt)) > 0) {
        latestOrdersByCardId.set(order.hCardId, order);
      }
    }

    return normalizedCodes.map(code => {
      const card = cardsByHash.get(cardCodeHash(code));
      if (!card) return { code, found: false };
      const order = (card.orderId && ordersById.get(card.orderId)) || latestOrdersByCardId.get(card.id) || null;
      const status = hCardQueryStatus(card, order);
      return {
        code,
        found: true,
        provider: card.provider,
        status,
        boundEmail: card.boundEmail || "",
        boundAccountId: card.boundAccountId || "",
        source: card.source || "未分类",
        plan: card.plan || "plus",
        batchId: card.batchId || "",
        createdAt: card.createdAt || "",
        submittedAt: card.submittedAt || card.boundAt || "",
        completedAt: hCardCompletedAt(card, order, status),
        failureMessage: status === "failed" ? order?.message || "" : "",
        subscriptionCancellationStatus: order?.subscriptionCancellationStatus || "",
        subscriptionActionRequired: Boolean(order?.subscriptionActionRequired && !order?.subscriptionActionHandledAt),
        subscriptionActionMessage: order?.subscriptionActionRequired && !order?.subscriptionActionHandledAt
          ? order.subscriptionActionMessage || "需要手动取消连续订阅。"
          : ""
      };
    });
  }

  verifyHCard(cardCode) {
    const card = this.getHCardByCode(cardCode);
    if (!card) return { ok: false, status: "not_found", message: "激活码不存在，请检查后重新输入。" };

    if (card.archivedAt) return { ok: false, status: "archived", message: "卡密已归档，请联系客服处理。" };
    if (card.disabledAt) return { ok: false, status: "disabled", message: "卡密已被后台禁用，请联系客服处理。" };
    if (card.status === "unused" && card.expiresAt && Date.parse(card.expiresAt) <= Date.now()) {
      this.updateHCard(card.id, { status: "expired" });
      return { ok: false, status: "expired", message: "激活码已过期，请联系人工处理。" };
    }
    if (card.status === "used") return { ok: false, status: "used", message: "卡密已使用，请勿重复提交。" };
    if (card.status === "reserved") return { ok: false, status: "reserved", message: "卡密正在处理中，请勿重复提交。" };
    if (card.status === "locked") return { ok: false, status: "locked", message: "卡密已锁定，请勿重复提交。" };
    if (card.status !== "unused") return { ok: false, status: card.status, message: "当前激活码不可用。" };

    return {
      ok: true,
      status: card.status,
      cardId: card.id,
      productId: card.productId,
      plan: card.plan || "plus",
      expiresAt: card.expiresAt || ""
    };
  }

  reserveHCard(cardCode, orderId, identity = {}) {
    const normalizedCode = String(cardCode || "").trim().toUpperCase();
    const normalizedOrderId = String(orderId || "").trim();
    if (!normalizedCode || !normalizedOrderId) return { ok: false, status: "invalid", message: "缺少卡密或订单号。" };
    if (!hasAccountIdentity(identity)) return { ok: false, status: "missing_account", message: "缺少账号信息，无法锁定卡密。" };

    const state = this.read();
    const card = state.hCards.find(item => item.codeHash === cardCodeHash(normalizedCode));
    if (!card) return { ok: false, status: "not_found", message: "激活码不存在，请检查后重新输入。" };
    if (card.archivedAt) return { ok: false, status: "archived", message: "卡密已归档，请联系客服处理。" };
    if (card.disabledAt) return { ok: false, status: "disabled", message: "卡密已被后台禁用，请联系客服处理。" };
    if (card.status === "unused" && card.expiresAt && Date.parse(card.expiresAt) <= Date.now()) {
      card.status = "expired";
      card.updatedAt = nowIso();
      this.write(state);
      return { ok: false, status: "expired", message: "激活码已过期，请联系人工处理。" };
    }
    if (card.status === "used") return { ok: false, status: "used", message: "卡密已使用，请勿重复提交。" };
    if (card.status === "reserved") {
      return { ok: false, status: "locked", message: "卡密已锁定，请勿重复提交。" };
    }
    if (card.status === "locked") {
      if (card.orderId && card.orderId !== normalizedOrderId) return { ok: false, status: "locked", message: "卡密已锁定，请勿重复提交。" };
      if (!cardIdentityMatches(card, identity)) {
        return { ok: false, status: "account_mismatch", message: "卡密已绑定其他账号，请联系客服处理。" };
      }
    }
    if (card.status !== "unused" && card.status !== "locked" && card.status !== "reserved") {
      return { ok: false, status: card.status, message: "当前激活码不可用。" };
    }

    const timestamp = nowIso();
    if (card.status === "unused") {
      Object.assign(card, {
        status: "locked",
        boundEmail: normalizeEmail(identity.email),
        boundAccountId: normalizeAccountId(identity.accountId),
        boundAt: card.boundAt || timestamp
      });
    }
    if (!card.codeCiphertext) {
      card.codeCiphertext = encryptProtected(normalizedCode, "h-card-code");
    }
    Object.assign(card, {
      orderId: card.orderId || normalizedOrderId,
      lockReason: "recharge_submitted",
      hasSubmission: true,
      submittedAt: card.submittedAt || timestamp,
      updatedAt: timestamp
    });
    this.write(state);
    return { ok: true, cardId: card.id, productId: card.productId };
  }

  completeHCard(cardId, orderId) {
    return this.transitionHCard(cardId, orderId, "used", { usedAt: nowIso() });
  }

  unlockHCard(cardId) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return { ok: false, status: "not_found", message: "卡密不存在。" };
    if (card.disabledAt) return { ok: false, status: "disabled", message: "请先启用卡密，再执行解锁。" };
    if (card.status === "used") return { ok: false, status: "used", message: "充值成功的卡密不能解锁。" };
    if (card.status !== "locked" && card.status !== "reserved") {
      return { ok: false, status: card.status, message: "当前卡密不需要解锁。" };
    }
    const order = card.orderId ? this.getOrder(card.orderId) : null;
    if (order && order.status !== "failed") {
      return { ok: false, status: "processing", message: "关联订单尚未确认失败，暂不能解锁。" };
    }

    Object.assign(card, {
      status: "unused",
      orderId: "",
      boundEmail: "",
      boundAccountId: "",
      boundAt: "",
      lockReason: "",
      usedAt: "",
      updatedAt: nowIso()
    });
    this.write(state);
    return { ok: true, status: "unused", cardId: card.id };
  }

  setHCardDisabled(cardId, disabled, reason = "") {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return { ok: false, status: "not_found", message: "卡密不存在。" };
    if (disabled) {
      Object.assign(card, {
        disabledAt: card.disabledAt || nowIso(),
        disabledReason: String(reason || "管理员禁用").trim(),
        updatedAt: nowIso()
      });
    } else {
      Object.assign(card, { disabledAt: "", disabledReason: "", updatedAt: nowIso() });
    }
    this.write(state);
    return { ok: true, status: card.disabledAt ? "disabled" : card.status, cardId: card.id };
  }

  archiveHCard(cardId, archived = true) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return { ok: false, status: "not_found", message: "卡密不存在。" };
    Object.assign(card, { archivedAt: archived ? (card.archivedAt || nowIso()) : "", updatedAt: nowIso() });
    this.write(state);
    return { ok: true, status: archived ? "archived" : (card.disabledAt ? "disabled" : card.status), cardId: card.id };
  }

  deleteHCard(cardId) {
    const state = this.read();
    const index = state.hCards.findIndex(item => item.id === cardId);
    if (index < 0) return { ok: false, status: "not_found", message: "卡密不存在。" };
    const card = state.hCards[index];
    const code = card.codeCiphertext ? decryptProtected(card.codeCiphertext, "h-card-code") : "";
    const hasMatchingOrder = state.orders.some(order => {
      if (order.hCardId === card.id || (card.orderId && order.id === card.orderId)) return true;
      const orderCode = order.cardInfoCiphertext ? decryptProtected(order.cardInfoCiphertext, "recharge-card-info") : "";
      return Boolean(code && orderCode && cardCodeHash(orderCode.trim().toUpperCase()) === card.codeHash);
    });
    if (card.hasSubmission || card.submittedAt || card.boundAt || card.usedAt || hasMatchingOrder) {
      return { ok: false, status: "has_submission", message: "这张卡密提交过充值资料，只能归档，不能删除。" };
    }
    if (!["unused", "expired"].includes(card.status) && !card.disabledAt) {
      return { ok: false, status: card.status, message: "只有未使用、已过期或已禁用且没有提交记录的卡密可以删除。" };
    }
    state.hCards.splice(index, 1);
    this.write(state);
    return { ok: true, status: "deleted", cardId };
  }

  bulkHCardAction(cardIds = [], action = "") {
    const ids = [...new Set((Array.isArray(cardIds) ? cardIds : []).map(String).filter(Boolean))];
    const results = ids.map(cardId => {
      if (action === "delete") return { cardId, ...this.deleteHCard(cardId) };
      if (action === "archive") return { cardId, ...this.archiveHCard(cardId, true) };
      if (action === "disable" || action === "enable") return { cardId, ...this.setHCardDisabled(cardId, action === "disable", "管理员批量禁用") };
      return { cardId, ok: false, status: "invalid", message: "不支持的批量操作。" };
    });
    return { total: results.length, successCount: results.filter(item => item.ok).length, failedCount: results.filter(item => !item.ok).length, results };
  }

  updateHCard(cardId, patch) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card) return null;
    Object.assign(card, patch, { updatedAt: nowIso() });
    this.write(state);
    return card;
  }

  getRechargeSession(orderId) {
    return this.read().rechargeSessions.find(item => item.orderId === orderId) || null;
  }

  purgeExpiredRechargeSecrets(retentionDays = RECHARGE_SECRET_RETENTION_DAYS) {
    const state = this.read();
    const cutoff = Date.now() - Math.max(Number(retentionDays) || RECHARGE_SECRET_RETENTION_DAYS, 1) * 24 * 60 * 60 * 1000;
    const terminalOrders = new Map(state.orders
      .filter(order => order.status === "success")
      .map(order => [order.id, Date.parse(order.manualCompletedAt || order.updatedAt || order.createdAt)]));
    let purged = 0;
    for (const session of state.rechargeSessions) {
      const completedAt = terminalOrders.get(session.orderId);
      if (!Number.isFinite(completedAt) || completedAt > cutoff) continue;
      if (session.rawSecretCiphertext || session.authDataCiphertext || session.authDataEncoded) {
        session.rawSecretCiphertext = "";
        session.authDataCiphertext = "";
        session.authDataEncoded = "";
        session.secretPurgedAt = nowIso();
        purged += 1;
      }
    }
    if (purged) this.write(state);
    return purged;
  }

  purgeRechargeSecretsBefore(cutoffIso) {
    const cutoff = Date.parse(cutoffIso);
    if (!Number.isFinite(cutoff)) return 0;
    const state = this.read();
    const orderTimes = new Map(state.orders.map(order => [order.id, Date.parse(order.createdAt)]));
    let purged = 0;
    for (const session of state.rechargeSessions) {
      const createdAt = orderTimes.get(session.orderId) || Date.parse(session.createdAt);
      if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
      if (session.rawSecretCiphertext || session.authDataCiphertext || session.authDataEncoded) {
        session.rawSecretCiphertext = "";
        session.authDataCiphertext = "";
        session.authDataEncoded = "";
        session.secretPurgedAt = nowIso();
        session.secretPurgeReason = "before-cutoff";
        purged += 1;
      }
    }
    if (purged) this.write(state);
    return purged;
  }

  listRechargeOrders() {
    this.purgeExpiredRechargeSecrets();
    const state = this.read();
    const sessions = new Map(state.rechargeSessions.map(session => [session.orderId, session]));
    return state.orders
      .sort((left, right) => String(right.updatedAt || right.createdAt).localeCompare(String(left.updatedAt || left.createdAt)))
      .map(order => {
        const session = sessions.get(order.id);
        return {
          id: order.id,
          provider: order.provider,
          cardMask: order.cardMask,
          productId: order.productId,
          plan: order.plan || "plus",
          fulfillmentMode: order.fulfillmentMode || "auto",
          processingNote: order.processingNote || "",
          paymentConfirmed: order.paymentConfirmed === true,
          waitingMinutes: Math.max(0, Math.floor((Date.now() - Date.parse(order.createdAt)) / 60000)),
          status: order.status,
          upstreamTaskId: order.upstreamTaskId || "",
          providerSessionId: order.providerSessionId || "",
          hifupayCardId: order.hifupayCardId || "",
          hifupayCardLastFour: order.hifupayCardLastFour || "",
          hifupaySafetyStatus: order.hifupaySafetyStatus || "",
          hifupayUnpaidConfirmationCount: Number(order.hifupayUnpaidConfirmationCount || 0),
          userEmail: session?.userEmail || "",
          message: order.message || "",
          subscriptionCancellationStatus: order.subscriptionCancellationStatus || "",
          subscriptionActionRequired: Boolean(order.subscriptionActionRequired),
          subscriptionActionMessage: order.subscriptionActionMessage || "",
          subscriptionActionDetectedAt: order.subscriptionActionDetectedAt || "",
          subscriptionActionHandledAt: order.subscriptionActionHandledAt || "",
          needsAttention: Boolean(order.subscriptionActionRequired && !order.subscriptionActionHandledAt),
          createdAt: order.createdAt,
          updatedAt: order.updatedAt,
          hasSecret: Boolean(session?.authDataCiphertext || session?.authDataEncoded),
          hasOriginalJson: Boolean(session?.rawSecretCiphertext || session?.authDataCiphertext || session?.authDataEncoded),
          hCardCodeAvailable: Boolean(order.hCardId && this.getHCardCode(order.hCardId))
        };
      });
  }

  listRecoveryOrders() {
    return this.listRechargeOrders().filter(order => ["failed", "needs_review"].includes(order.status));
  }

  getRecoveryOrder(orderId) {
    const state = this.read();
    const order = state.orders.find(item => item.id === orderId) || null;
    if (!order) return null;
    const session = state.rechargeSessions.find(item => item.orderId === orderId) || null;
    return { order, session };
  }

  transitionHCard(cardId, orderId, status, extra = {}) {
    const state = this.read();
    const card = state.hCards.find(item => item.id === cardId);
    if (!card || !["locked", "reserved"].includes(card.status) || card.orderId !== orderId) return false;
    const completedPatch = status === "used" ? { disabledAt: "", disabledReason: "" } : {};
    Object.assign(card, { ...completedPatch, ...extra, status, orderId: status === "unused" ? "" : orderId, updatedAt: nowIso() });
    this.write(state);
    return true;
  }
}
