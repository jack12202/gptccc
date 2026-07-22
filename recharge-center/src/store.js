import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { config } from "./config.js";

const PROVIDER_CONFIG_VERSION = 2;

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function createInitialState() {
  return {
    orders: [],
    rechargeSessions: [],
    rechargeLogs: [],
    settings: {
      defaultProvider: config.defaultProvider,
      providerConfigVersion: PROVIDER_CONFIG_VERSION,
      providerUpdatedAt: "",
      providerUpdatedBy: ""
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
    fs.writeFileSync(this.filePath, JSON.stringify(state, null, 2));
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
      message: input.message || "",
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

  createRechargeSession(input) {
    const state = this.read();
    const session = {
      id: makeId("session"),
      orderId: input.orderId,
      userEmail: input.userEmail || "",
      tokenHash: input.tokenHash || "",
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
}
