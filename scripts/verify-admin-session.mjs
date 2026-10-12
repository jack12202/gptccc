import assert from "node:assert/strict";

// Read-only production smoke check: no card, provider, or recharge mutations.
const base = "https://www.gptc.cc";
const password = process.env.ADMIN_TOKEN;
if (!password) throw new Error("ADMIN_TOKEN is required for login verification");
const pages = ["/admin", "/admin/cards", "/admin/cards/library", "/admin/cards/batch", "/admin/hifupay/cards", "/admin/zzshu", "/admin/pro-orders", "/admin/recoveries", "/admin/provider"];
const call = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(20000) });
let cookie, csrf;
try {
  for (const page of pages) {
    const response = await call(page, { redirect: "manual" });
    assert.equal(response.status, 303, `${page} must require login`);
    assert.match(response.headers.get("location"), /^\/admin\/login\?next=/);
  }
  const loginPage = await call("/admin/login");
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /记住此设备 7 天/);
  const script = await call("/admin/session.js");
  assert.equal(script.status, 200);
  assert.match(await script.text(), /localStorage.removeItem/);
  assert.equal((await call("/api/admin/hifupay/cards")).status, 401);
  const login = await call("/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Admin-Request": "1" },
    body: JSON.stringify({ password })
  });
  assert.equal(login.status, 200, "Session login must succeed");
  const setCookie = login.headers.get("set-cookie") || "";
  // Never include the cookie in assertion output.
  assert.ok(setCookie.includes("HttpOnly") && setCookie.includes("Secure") && setCookie.includes("SameSite=Strict"), "Secure session cookie attributes missing");
  cookie = setCookie.split(";")[0];
  csrf = (await login.json()).data.csrf;
  for (const page of pages) {
    let response = await call(page, { headers: { Cookie: cookie }, redirect: "manual" });
    if (page === "/admin/zzshu") {
      assert.equal(response.status, 303, "/admin/zzshu must redirect to the unified payment-card page");
      assert.equal(response.headers.get("location"), "/admin/hifupay/cards#importPanel");
      response = await call(response.headers.get("location"), { headers: { Cookie: cookie }, redirect: "manual" });
    }
    assert.equal(response.status, 200, `${page} must accept the shared session`);
    const html = await response.text();
    const hasChannelCredentialInputs = page === "/admin" && html.includes('id="hifupayKey" type="password"') && html.includes('id="zzshuKey" type="password"') && html.includes('/admin/cards/workbench-settings.js');
    assert.ok(html.includes('/admin/session.js') && (!html.includes('type="password"') || hasChannelCredentialInputs), `${page} still contains legacy authentication`);
  }
  for (const asset of ["workbench.js","workbench-settings.js"]) {
    const response = await call("/admin/cards/" + asset, {headers:{Cookie:cookie}});
    assert.equal(response.status,200,"Workbench asset must be available behind the shared session");
    assert.match(response.headers.get("content-type") || "", /javascript/);
  }
  const home = await call("/admin", {headers:{Cookie:cookie}}).then(response=>response.text());
  assert.ok(["正在使用的支付卡","最近客户卡密","最近充值订单","录入支付卡"].every(text=>home.includes(text)),"Production workbench panels missing");
  const snapshotResponse = await call("/api/admin/workbench", {headers:{Cookie:cookie}});
  assert.equal(snapshotResponse.status,200,"Production workbench snapshot unavailable");
  const snapshot = (await snapshotResponse.json()).data;
  assert.ok(snapshot && Array.isArray(snapshot.cards) && snapshot.cards.every(card=>card.enabled),"Workbench must show only active cards");
  assert.ok(snapshot.orders.items.length <= 10 && snapshot.vouchers.items.length <= 20,"Workbench recent windows exceed their limits");
  console.log("Production workbench panels, assets and bounded snapshot verified without business mutations.");
  console.log("Admin login, shared session, protected pages and secure cookie verified.");
} finally {
  if (cookie && csrf) {
    const response = await call("/api/admin/logout", { method: "POST", headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf } });
    assert.equal(response.status, 200, "Verification session logout failed");
    assert.equal((await call("/api/admin/session", { headers: { Cookie: cookie } })).status, 401, "Revoked session still accepted");
    console.log("Verification session revoked.");
  }
}
