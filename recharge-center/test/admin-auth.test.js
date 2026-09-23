import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createAdminAuth } from "../src/admin-auth.js";

const origin = "https://www.gptc.cc";
const password = "admin-test-only-password";
function request(cookie = "", extra = {}) {
  return { method: "POST", socket: { remoteAddress: "127.0.0.1" }, headers: { origin, cookie, "x-admin-request": "1", ...extra } };
}

test("sessions expire, survive restart, rotate on login, and revoke individually or globally", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "sessions.json");
  let time = Date.now();
  const options = { file, origin, password, now: () => time };
  let auth = createAdminAuth(options);
  const first = auth.login(request(), { password, remember: true });
  assert.equal(first.ok, true);
  assert.match(first.cookie, /HttpOnly; Secure; SameSite=Strict; Max-Age=604800/);
  const firstCookie = first.cookie.split(";")[0];
  const stored = fs.readFileSync(file, "utf8");
  assert.ok(!stored.includes(password));
  assert.ok(!stored.includes(firstCookie.split("=")[1]));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  auth = createAdminAuth(options);
  assert.ok(auth.session(request(firstCookie)));
  const second = auth.login(request(), { password });
  assert.doesNotMatch(second.cookie, /Max-Age/);
  const secondCookie = second.cookie.split(";")[0];
  const rotated = auth.login(request(secondCookie), { password });
  assert.equal(auth.session(request(secondCookie)), null);
  const rotatedCookie = rotated.cookie.split(";")[0];
  assert.equal(auth.authorize(request(rotatedCookie)).status, 403);
  assert.equal(auth.authorize(request(rotatedCookie, { "x-csrf-token": rotated.data.csrf, origin: "https://evil.example" })).status, 403);
  assert.equal(auth.authorize(request(rotatedCookie, { "x-csrf-token": rotated.data.csrf })).ok, true);
  assert.equal(auth.logout(request(rotatedCookie, { "x-csrf-token": rotated.data.csrf })).ok, true);
  assert.equal(auth.session(request(rotatedCookie)), null);
  assert.ok(auth.session(request(firstCookie)));
  const short = auth.login(request(), { password });
  time += 8 * 3600 * 1000 + 1;
  assert.equal(auth.session(request(short.cookie.split(";")[0])), null);
  assert.ok(auth.session(request(firstCookie)));
  auth.logout(request(firstCookie, { "x-csrf-token": first.data.csrf }), true);
  assert.equal(createAdminAuth(options).session(request(firstCookie)), null);
  const later = auth.login(request(), { password, remember: true });
  const laterCookie = later.cookie.split(";")[0];
  assert.equal(createAdminAuth({ ...options, password: "new-password" }).session(request(laterCookie)), null);
  time += 7 * 24 * 3600 * 1000;
  assert.equal(auth.session(request(laterCookie)), null);
});

test("login requires same-origin header and throttles failures without trusting remote IP headers", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-login-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let time = Date.now();
  const auth = createAdminAuth({ password, origin, file: path.join(dir, "sessions.json"), now: () => time });
  assert.equal(auth.login(request("", { origin: "https://evil.example" }), { password }).status, 403);
  assert.equal(auth.login(request("", { "x-admin-request": "" }), { password }).status, 403);
  assert.equal(auth.login(request(), null).status, 400);
  for (let i = 0; i < 5; i++) {
    const req = request("", { "x-real-ip": `1.1.1.${i}` });
    req.socket.remoteAddress = "198.51.100.1";
    assert.equal(auth.login(req, { password: "wrong" }).status, 401);
  }
  const req = request("", { "x-real-ip": "2.2.2.2" });
  req.socket.remoteAddress = "198.51.100.1";
  assert.equal(auth.login(req, { password }).status, 429);
  time += 15 * 60 * 1000 + 1;
  assert.equal(auth.login(req, { password }).ok, true);
});

test("all admin pages and APIs require sessions; old tokens and GET switch cannot bypass authorization", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-auth-http-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ADMIN_TOKEN = password;
  process.env.DATA_FILE = path.join(dir, "orders.json");
  const { server } = await import("../src/server.js");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const pages = ["/admin", "/admin/cards", "/admin/cards/library", "/admin/cards/batch", "/admin/hifupay/cards", "/admin/zzshu", "/admin/pro-orders", "/admin/recoveries", "/admin/provider"];
  for (const page of pages) {
    const res = await fetch(base + page, { redirect: "manual" });
    assert.equal(res.status, 303);
    assert.match(res.headers.get("location"), /^\/admin\/login\?next=/);
  }
  for (const suffix of ["", `?token=${password}`, `?adminToken=${password}`]) {
    const res = await fetch(base + "/api/admin/h-cards" + suffix, { headers: { "X-Admin-Token": password } });
    assert.equal(res.status, 401);
  }
  const login = await fetch(base + "/api/admin/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json", "X-Admin-Request": "1" }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const csrf = (await login.json()).data.csrf;
  for (const page of pages) {
    const res = await fetch(base + page, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /src="\/admin\/session.js"/);
    assert.match(html, /GPTC 后台|产品与卡密|ZZS 通道工作台|Pro 履约工作台/);
    if (page === "/admin/provider") {
      assert.match(html, /履约通道入口/);
      assert.match(html, /href="\/admin\/hifupay\/cards"/);
      assert.match(html, /href="\/admin\/zzshu"/);
    }
    if (page === "/admin/zzshu") {
      assert.match(html, /id="zzshuApiKey" type="password"/);
      assert.match(html, /验证并保存/);
      assert.match(html, /ZZS 支付卡库/);
      assert.match(html, /<details class="sync-details">/);
      assert.ok(html.indexOf('id="manual-card-import"') < html.indexOf('id="hifupay-sync"'));
      assert.ok(html.indexOf('id="hifupay-sync"') < html.indexOf('id="zzs-card-library"'));
    }
    if (!["/admin", "/admin/zzshu"].includes(page)) assert.doesNotMatch(html, /type="password"/);
    if (page === "/admin") {
      assert.match(html, /嗨付 API/);
      assert.match(html, /ZZS API/);
      assert.match(html, /Plus 通道选择/);
      assert.doesNotMatch(html, /value="[^\"]+"/);
    }
    assert.doesNotMatch(html, /X-Admin-Token|localStorage\.setItem|tokenFromQuery/);
    for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
  }
  const before = fs.readFileSync(process.env.DATA_FILE, "utf8");
  const productionVerifier = fs.readFileSync(new URL("../../scripts/verify-admin-session.mjs", import.meta.url), "utf8");
  assert.match(productionVerifier, /hasOnlyZzshuCredentialInput/);
  assert.equal((await fetch(base + "/api/admin/zzshu/credential")).status, 401);
  assert.equal((await fetch(base + "/api/admin/hifupay/credential")).status, 401);
  assert.equal((await fetch(base + "/api/admin/recharge-dashboard")).status, 401);
  const credentialStatus = await fetch(base + "/api/admin/zzshu/credential", { headers: { Cookie: cookie } });
  assert.equal(credentialStatus.status, 200);
  assert.equal((await credentialStatus.json()).data.configured, false);
  const rejectedCredential = await fetch(base + "/api/admin/zzshu/credential/verify-and-save", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "fixture-key" }) });
  assert.equal(rejectedCredential.status, 403);
  const rejectedHifupayCredential = await fetch(base + "/api/admin/hifupay/credential/verify-and-save", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: "fixture-key" }) });
  assert.equal(rejectedHifupayCredential.status, 403);
  const rejected = await fetch(base + "/api/admin/h-cards", { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, body: JSON.stringify({ count: 1 }) });
  assert.equal(rejected.status, 403);
  const oldSwitch = await fetch(base + "/admin/provider/switch?provider=h", { headers: { Cookie: cookie }, redirect: "manual" });
  assert.equal(oldSwitch.status, 303);
  assert.equal(oldSwitch.headers.get("location"), "/admin/provider");
  assert.equal(fs.readFileSync(process.env.DATA_FILE, "utf8"), before);
  const result = await fetch(base + "/api/admin/h-cards/query", { method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ inputs: [] }) });
  assert.equal(result.status, 400); // Reaches input validation, not auth rejection.
  const logout = await fetch(base + "/api/admin/logout-all", { method: "POST", headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf } });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await fetch(base + "/api/admin/session", { headers: { Cookie: cookie } })).status, 401);
});
