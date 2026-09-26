import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import { config } from "./config.js";
import { decryptSecretText, encryptSecretText } from "./utils.js";

const platformFetch = globalThis.fetch;

export function normalizeZzshuProxy(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\u007f]/.test(value)) return "";
  try {
    const url = new URL(value);
    if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname ||
      !url.port || (url.pathname && url.pathname !== "/") || url.search || url.hash) return "";
    // Resolve ZZS through the SOCKS endpoint, never through the VPS resolver.
    if (url.protocol === "socks5:") url.protocol = "socks5h:";
    return url.href;
  } catch { return ""; }
}

export class ZzshuProxyStore {
  constructor({ file, encryptionKey }) { this.file = file; this.encryptionKey = encryptionKey; }
  read() {
    if (!fs.existsSync(this.file)) return { state: "missing" };
    try {
      if (fs.lstatSync(this.file).isSymbolicLink()) return { state: "invalid" };
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      const url = decryptSecretText(saved?.proxyCiphertext, this.encryptionKey(), "zzshu-proxy");
      // Legacy proxy files did not record an active mode. Keep their encrypted
      // endpoint, but default them to the verified VPS IPv4 route.
      const mode = saved?.mode === "proxy" ? "proxy" : "direct_ipv4";
      return normalizeZzshuProxy(url) ? { state: "ready", url, mode } : { state: "invalid" };
    } catch { return { state: "invalid" }; }
  }
  url() { return this.read().url || ""; }
  status() {
    const current = this.read();
    return {
      configured: current.state === "ready",
      mode: current.mode || "direct_ipv4",
      usingProxy: current.state === "ready" && current.mode === "proxy",
      storageReady: current.state !== "invalid" && Boolean(this.encryptionKey())
    };
  }
  save(value) {
    const url = normalizeZzshuProxy(value);
    if (!url) return { ok: false, status: 400, message: "代理地址格式不正确；请填写 HTTP(S) 或 SOCKS5 节点 URI。" };
    if (!this.status().storageReady) return { ok: false, status: 503, message: "代理配置加密存储不可用。" };
    const directory = path.dirname(this.file);
    const temporary = path.join(directory, `.zzshu-proxy-${crypto.randomUUID()}.tmp`);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.writeFileSync(temporary, JSON.stringify({ version: 2, mode: "proxy", proxyCiphertext: encryptSecretText(url, this.encryptionKey(), "zzshu-proxy"), updatedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
      return { ok: true };
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
      return { ok: false, status: 503, message: "代理配置保存失败。" };
    }
  }

  setMode(mode) {
    if (!["direct_ipv4", "proxy"].includes(mode)) return { ok: false, status: 400, message: "ZZS 出口模式无效。" };
    const current = this.read();
    if (current.state === "invalid") return { ok: false, status: 503, message: "代理配置不可读取。" };
    if (mode === "proxy" && current.state !== "ready") return { ok: false, status: 409, message: "尚未保存代理出口。" };
    if (mode === "direct_ipv4" && current.state === "missing") return { ok: true };
    const temporary = path.join(path.dirname(this.file), `.zzshu-proxy-mode-${crypto.randomUUID()}.tmp`);
    try {
      const saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
      fs.writeFileSync(temporary, JSON.stringify({ ...saved, version: 2, mode, updatedAt: new Date().toISOString() }), { mode: 0o600, flag: "wx" });
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
      return { ok: true };
    } catch {
      try { fs.unlinkSync(temporary); } catch {}
      return { ok: false, status: 503, message: "ZZS 出口模式保存失败。" };
    }
  }
}

export const zzshuProxyStore = new ZzshuProxyStore({ file: config.zzshuProxyFile, encryptionKey: () => config.recoveryEncryptionKey });

function nodeHttpsFetch(target, options, requestOptions = {}, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      callback(value);
    };
    const request = https.request(target, {
      method: options.method || "GET",
      headers: options.headers,
      signal: options.signal,
      ...requestOptions
    }, response => {
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) request.destroy(new Error("ZZS 响应过大"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
        finish(resolve, new Response(Buffer.concat(chunks), { status: response.statusCode, headers }));
      });
      response.on("error", error => finish(reject, error));
    });
    const onAbort = () => {
      request.destroy();
      requestOptions.agent?.destroy?.();
      finish(reject, options.signal.reason || new Error("ZZS 请求已取消"));
    };
    request.on("error", error => finish(reject, error));
    options.signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      request.destroy();
      requestOptions.agent?.destroy?.();
      finish(reject, new Error("ZZS 连接超时"));
    }, timeoutMs);
    if (options.signal?.aborted) { onAbort(); return; }
    request.end(options.body);
  });
}

// Only ZZS API traffic calls this function. Never retry a request here: a timed-out
// order creation may already have reached the upstream service.
export async function zzshuFetch(url, options = {}, proxyOverride) {
  const stored = proxyOverride === undefined ? zzshuProxyStore.read() : null;
  if (stored?.state === "invalid") throw new Error("ZZS 代理配置不可读取");
  const proxyUrl = proxyOverride === undefined && stored?.mode === "proxy" ? stored.url :
    proxyOverride === undefined ? "" : normalizeZzshuProxy(proxyOverride);
  if (proxyOverride !== undefined && !proxyUrl) throw new Error("代理地址格式不正确");
  const target = new URL(url);
  const timeoutMs = Math.max(1000, Math.min(Number(config.zzshuTimeoutMs) || 15000, 8000));
  if (!proxyUrl) {
    if (target.protocol !== "https:") throw new Error("ZZS 上游必须使用 HTTPS");
    // Existing provider tests inject a local fetch implementation. Production
    // keeps the platform function and therefore always uses the IPv4 transport.
    if (target.hostname.endsWith(".test") || globalThis.fetch !== platformFetch) return globalThis.fetch(target, options);
    return nodeHttpsFetch(target, options, { family: 4 }, timeoutMs);
  }
  if (target.protocol !== "https:") throw new Error("代理模式下 ZZS 上游必须使用 HTTPS");
  const proxy = new URL(proxyUrl);
  const agent = proxy.protocol.startsWith("socks") ? new SocksProxyAgent(proxy, { timeout: timeoutMs }) : new HttpsProxyAgent(proxy, { timeout: timeoutMs });
  return nodeHttpsFetch(target, options, { agent }, timeoutMs);
}
