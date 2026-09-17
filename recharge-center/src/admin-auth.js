import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const COOKIE = "__Host-gptc_admin";
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const equal = (a, b) => crypto.timingSafeEqual(Buffer.from(hash(String(a))), Buffer.from(hash(String(b))));
const deny = (status, message) => ({ ok: false, status, message });

// One backend process owns this file. Only hashes of bearer sessions are stored.
export function createAdminAuth({ password, file, origin, now = Date.now }) {
  const expectedOrigin = new URL(origin).origin;
  const passwordVersion = hash(`gptc-admin-session:${password}`);
  let sessions = {};
  const failures = new Map();
  let globalFailures = [];
  if (fs.existsSync(file)) {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    if (stored.passwordVersion === passwordVersion) sessions = stored.sessions || {};
  }
  function save() {
    const current = now();
    sessions = Object.fromEntries(Object.entries(sessions).filter(([, value]) => value.expiresAt > current));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ passwordVersion, sessions }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
  function session(req) {
    if (!password) return null;
    const match = String(req.headers.cookie || "").match(/(?:^|;\s*)__Host-gptc_admin=([A-Za-z0-9_-]{43})(?:;|$)/);
    if (!match) return null;
    const id = hash(match[1]);
    const value = sessions[id];
    return value && value.expiresAt > now() ? { ...value, id } : null;
  }
  function sameOrigin(req) {
    return req.headers.origin === expectedOrigin && req.headers["sec-fetch-site"] !== "cross-site";
  }
  function authorize(req) {
    const value = session(req);
    if (!value) return deny(401, "登录已过期，请重新登录。");
    if (!["GET", "HEAD"].includes(req.method) &&
      (!sameOrigin(req) || !equal(req.headers["x-csrf-token"] || "", value.csrf))) {
      return deny(403, "请求验证失败，请刷新页面后重试。");
    }
    return { ok: true, session: value };
  }
  function login(req, input = {}) {
    if (!sameOrigin(req) || req.headers["x-admin-request"] !== "1") return deny(403, "请从本站登录页登录。");
    if (!input || typeof input !== "object" || Array.isArray(input)) return deny(400, "登录请求格式不正确。");
    if (!password) return deny(503, "后台登录尚未配置。");
    const remote = req.socket.remoteAddress || "unknown";
    const trustedProxy = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote);
    const ip = trustedProxy ? String(req.headers["x-real-ip"] || remote).slice(0, 80) : remote;
    const cutoff = now() - 15 * 60 * 1000;
    globalFailures = globalFailures.filter(time => time > cutoff);
    for (const [key, times] of failures) {
      const recent = times.filter(time => time > cutoff);
      if (recent.length) failures.set(key, recent); else failures.delete(key);
    }
    const attempts = failures.get(ip) || [];
    if (attempts.length >= 5 || globalFailures.length >= 100) return deny(429, "尝试次数过多，请 15 分钟后再试。");
    if (typeof input.password !== "string" || input.password.length > 1024 || !equal(input.password, password)) {
      failures.set(ip, [...attempts, now()]);
      globalFailures.push(now());
      return deny(401, "管理密码不正确。");
    }
    failures.delete(ip);
    const previous = session(req);
    if (previous) delete sessions[previous.id];
    const token = crypto.randomBytes(32).toString("base64url");
    const remembered = input.remember === true;
    const seconds = remembered ? 7 * 24 * 3600 : 8 * 3600;
    const value = { csrf: crypto.randomBytes(32).toString("base64url"), expiresAt: now() + seconds * 1000, remembered };
    sessions[hash(token)] = value;
    save();
    return { ok: true, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict${remembered ? `; Max-Age=${seconds}` : ""}`, data: value };
  }
  function logout(req, all = false) {
    const result = authorize(req);
    if (!result.ok) return result;
    if (all) sessions = {}; else delete sessions[result.session.id];
    save();
    return { ok: true, cookie: `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0` };
  }
  return { session, authorize, login, logout };
}
