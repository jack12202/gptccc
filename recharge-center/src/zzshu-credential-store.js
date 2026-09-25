import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { decryptSecretText, encryptSecretText } from "./utils.js";

const MAX_KEY_LENGTH = 512;

function normalizeKey(value) {
  if (typeof value !== "string") return "";
  const key = value.trim();
  return key && key.length <= MAX_KEY_LENGTH && !/[\u0000-\u001f\u007f]/.test(key) ? key : "";
}

function upstreamBase(value) {
  const base = new URL(value);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error("ZZS 上游必须使用 HTTPS");
  }
  return base;
}

export class ZzshuCredentialStore {
  constructor({ file, encryptionKey, environmentKey, baseUrl, timeoutMs, fetchImpl = globalThis.fetch }) {
    this.file = file;
    this.encryptionKey = encryptionKey;
    this.environmentKey = environmentKey;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  readStored() {
    if (!fs.existsSync(this.file)) return { state: "missing" };
    try {
      if (fs.lstatSync(this.file).isSymbolicLink()) return { state: "invalid" };
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const key = decryptSecretText(saved?.apiKeyCiphertext, this.encryptionKey(), "zzshu-api-key");
      return normalizeKey(key) ? { state: "ready", key, overrideEnvironment: saved?.overrideEnvironment === true } : { state: "invalid" };
    } catch {
      return { state: "invalid" };
    }
  }

  current() {
    const stored = this.readStored();
    if (stored.state === "ready" && stored.overrideEnvironment) return { ...stored, source: "runtime-secret" };
    const environmentKey = normalizeKey(this.environmentKey());
    if (environmentKey) return { state: "ready", source: "environment", key: environmentKey };
    return stored.state === "ready" ? { ...stored, source: "runtime-secret" } : stored;
  }

  key() {
    return this.current().key || "";
  }

  status() {
    const current = this.current();
    return {
      configured: current.state === "ready",
      source: current.source || "",
      channelEnabled: config.zzshuEnabled,
      testMode: config.zzshuTestMode,
      canConfigure: current.state !== "invalid" && Boolean(this.encryptionKey()),
      storageReady: current.state !== "invalid" && Boolean(this.encryptionKey())
    };
  }

  async verify(apiKey, extraHeaders = {}) {
    const key = normalizeKey(apiKey);
    if (!key) return { ok: false, status: 400, message: "API Key 格式不正确。" };
    let response;
    try {
      response = await this.fetchImpl(new URL("/api/v1/third-party/user", upstreamBase(this.baseUrl())), {
        method: "GET",
        headers: { "X-API-Key": key, ...extraHeaders },
        signal: AbortSignal.timeout(Math.max(1000, Number(this.timeoutMs()) || 15000))
      });
    } catch {
      return { ok: false, status: 502, message: "无法连接 ZZS 验证 API，请稍后重试。" };
    }
    let body;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok || body?.code !== 0) {
      const code = Number.isInteger(body?.code) ? body.code : null;
      const upstreamUnavailable = Number(response.status) >= 500;
      return { ok: false, status: upstreamUnavailable ? 502 : 400,
        message: upstreamUnavailable
          ? `ZZS 上游网关暂时不可用（HTTP ${response.status}）；不能据此判定 API Key 无效，请保留原 Key 并稍后重试。`
          : `ZZS 未接受此 API Key（上游 HTTP ${response.status || "?"}，code ${code ?? "?"}）。请核对后台保存的 Key。`,
        upstreamHttpStatus: response.status || null, upstreamCode: code,
        upstreamRay: response.headers?.get?.("cf-ray") || "" };
    }
    const points = Number(body?.data?.points);
    return { ok: true, points: Number.isFinite(points) ? points : null };
  }

  async verifySaved() {
    const key = this.key();
    return key ? this.verify(key) : { ok: false, status: 503, message: "尚未配置 ZZS API Key。" };
  }

  save(apiKey, { replace = false } = {}) {
    const key = normalizeKey(apiKey);
    if (!key) return { ok: false, status: 400, message: "API Key 格式不正确。" };
    if (!this.encryptionKey()) return { ok: false, status: 503, message: "未配置运行时加密密钥，无法保存 API Key。" };
    const current = this.current();
    if (current.state === "ready" && !replace) return { ok: false, status: 409, message: "已有 ZZS API Key；如需更换请使用更换操作。" };
    if (current.state === "invalid") return { ok: false, status: 503, message: "现有 ZZS 私密配置不可读取，请先由运维安全核查。" };
    const directory = path.dirname(this.file);
    const temporary = path.join(directory, `.zzshu-api-key-${crypto.randomUUID()}.tmp`);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, overrideEnvironment: current.source === "environment" || current.overrideEnvironment === true, apiKeyCiphertext: encryptSecretText(key, this.encryptionKey(), "zzshu-api-key"), createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
      if (replace) fs.renameSync(temporary, this.file);
      else { fs.linkSync(temporary, this.file); fs.unlinkSync(temporary); }
      fs.chmodSync(this.file, 0o600);
      return { ok: true };
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
      return { ok: false, status: 503, message: "私密配置未能保存，请稍后重试。" };
    }
  }

  async verifyAndSave(apiKey, options = {}) {
    const status = this.status();
    if (this.current().state === "ready" && options.replace !== true) return this.save(apiKey, options);
    if (!status.storageReady) return this.save(apiKey, options);
    const verified = await this.verify(apiKey);
    if (!verified.ok) return verified;
    const saved = this.save(apiKey, options);
    return saved.ok ? { ...saved, points: verified.points } : saved;
  }
}

export const zzshuCredentialStore = new ZzshuCredentialStore({
  file: config.zzshuSecretFile,
  encryptionKey: () => config.recoveryEncryptionKey,
  environmentKey: () => config.zzshuApiKey,
  baseUrl: () => config.zzshuBaseUrl,
  timeoutMs: () => config.zzshuTimeoutMs
});
