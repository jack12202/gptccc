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
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) throw new Error("嗨付上游必须使用 HTTPS");
  return base;
}

export class HifupayCredentialStore {
  constructor({ file, encryptionKey, environmentKey, baseUrl, fetchImpl = globalThis.fetch }) {
    this.file = file; this.encryptionKey = encryptionKey; this.environmentKey = environmentKey; this.baseUrl = baseUrl; this.fetchImpl = fetchImpl;
  }
  readStored() {
    if (!fs.existsSync(this.file)) return { state: "missing" };
    try {
      if (fs.lstatSync(this.file).isSymbolicLink()) return { state: "invalid" };
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const key = decryptSecretText(saved?.apiKeyCiphertext, this.encryptionKey(), "hifupay-api-key");
      return normalizeKey(key) ? { state: "ready", key } : { state: "invalid" };
    } catch { return { state: "invalid" }; }
  }
  current() {
    const environmentKey = normalizeKey(this.environmentKey());
    if (environmentKey) return { state: "ready", source: "environment", key: environmentKey };
    const stored = this.readStored();
    return stored.state === "ready" ? { ...stored, source: "runtime-secret" } : stored;
  }
  key() { return this.current().key || ""; }
  status() {
    const current = this.current();
    return { configured: current.state === "ready", source: current.source || "", canConfigure: current.source !== "environment" && current.state !== "invalid" && Boolean(this.encryptionKey()), storageReady: current.state !== "invalid" && Boolean(this.encryptionKey()) };
  }
  async verify(apiKey) {
    const key = normalizeKey(apiKey);
    if (!key) return { ok: false, status: 400, message: "API Key 格式不正确。" };
    let response;
    try {
      response = await this.fetchImpl(new URL("/api/hfp/login", upstreamBase(this.baseUrl())), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: key, platform: "haifupaytop" }), signal: AbortSignal.timeout(15000) });
    } catch { return { ok: false, status: 502, message: "无法连接嗨付验证 API，请稍后重试。" }; }
    let body; try { body = await response.json(); } catch { body = null; }
    if (!response.ok || body?.success !== true || !normalizeKey(body?.apiKey)) return { ok: false, status: 400, message: "嗨付未接受此 API Key，请核对后重试。" };
    return { ok: true };
  }
  async verifySaved() { const key = this.key(); return key ? this.verify(key) : { ok: false, status: 503, message: "尚未配置嗨付 API Key。" }; }
  save(apiKey, { replace = false } = {}) {
    const key = normalizeKey(apiKey);
    if (!key) return { ok: false, status: 400, message: "API Key 格式不正确。" };
    if (!this.encryptionKey()) return { ok: false, status: 503, message: "未配置运行时加密密钥，无法保存 API Key。" };
    const current = this.current();
    if (current.source === "environment") return { ok: false, status: 409, message: "当前嗨付 API Key 由部署环境管理，不能在后台替换。" };
    if (current.state === "ready" && !replace) return { ok: false, status: 409, message: "已有嗨付 API Key；如需更换请使用更换操作。" };
    if (current.state === "invalid") return { ok: false, status: 503, message: "现有嗨付私密配置不可读取，请先核查。" };
    const directory = path.dirname(this.file), temporary = path.join(directory, `.hifupay-api-key-${crypto.randomUUID()}.tmp`);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, apiKeyCiphertext: encryptSecretText(key, this.encryptionKey(), "hifupay-api-key"), createdAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
      if (replace) fs.renameSync(temporary, this.file);
      else { fs.linkSync(temporary, this.file); fs.unlinkSync(temporary); }
      fs.chmodSync(this.file, 0o600); return { ok: true };
    } catch { try { fs.unlinkSync(temporary); } catch {} return { ok: false, status: 503, message: "私密配置未能保存，请稍后重试。" }; }
  }
  async verifyAndSave(apiKey, options = {}) {
    if (this.current().state === "ready" && options.replace !== true) return this.save(apiKey, options);
    const verified = await this.verify(apiKey); if (!verified.ok) return verified; return this.save(apiKey, options);
  }
}

export const hifupayCredentialStore = new HifupayCredentialStore({ file: config.hifupaySecretFile, encryptionKey: () => config.recoveryEncryptionKey, environmentKey: () => config.hifupayApiKey, baseUrl: () => config.hifupayBaseUrl });
