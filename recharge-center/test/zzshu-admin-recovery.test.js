import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("admin can resolve an unknown ZZS order once and separately confirm renewal closure", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-zzshu-admin-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ADMIN_TOKEN = "fixture-admin-password";
  process.env.DATA_FILE = path.join(dir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(dir, "zzshu.sqlite");
  process.env.RECOVERY_ENCRYPTION_KEY = "fixture-encryption-key";
  const { sharedZzshuStore: store } = await import("../src/zzshu-store.js");
  const { parsePaymentCards } = await import("../src/zzshu-cards.js");
  const { server } = await import("../src/server.js");
  store.addPaymentCard(parsePaymentCards("4242424242424242,12/40,123")[0],
    { credentialRef: "fixture-ref", source: "fixture", note: "", enabled: true, maxSuccess: 2 });
  const [voucher] = store.createVouchers(1, "fixture", 3, () => "fixture-cipher");
  const order = store.reserve(voucher.code, "fixture@example.test", "account-1");
  store.markSubmitting(order.orderId);
  store.review(order.orderId, "创建响应丢失，等待核查");
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/admin/login", {
    method: "POST", headers: { Origin: "https://www.gptc.cc", "Content-Type": "application/json", "X-Admin-Request": "1" },
    body: JSON.stringify({ password: "fixture-admin-password" })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const csrf = (await login.json()).data.csrf;
  const post = (suffix, body) => fetch(base + suffix, {
    method: "POST", headers: { Cookie: cookie, Origin: "https://www.gptc.cc", "X-CSRF-Token": csrf, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  const before = await fetch(base + "/api/admin/recharge-records", { headers: { Cookie: cookie } }).then(response => response.json());
  const record = before.data.records.find(item => item.id === order.orderId);
  assert.equal(record.status, "needs_review");
  assert.equal(record.hasUpstreamQueryKey, false);
  assert.match(record.processingNote, /创建响应丢失/);
  const resolution = `/api/admin/zzshu/orders/${order.orderId}/resolve`;
  assert.equal((await post(resolution, { outcome: "success", reason: "fixture upstream payment checked" })).status, 200);
  assert.equal((await post(resolution, { outcome: "success", reason: "fixture upstream payment checked" })).status, 409);
  assert.equal(store.listCards()[0].successCount, 1);
  const cancellation = `/api/admin/zzshu/orders/${order.orderId}/confirm-cancellation`;
  assert.equal((await post(cancellation, { reason: "fixture upstream renewal checked" })).status, 200);
  assert.equal((await post(cancellation, { reason: "fixture upstream renewal checked" })).status, 409);
  assert.equal(store.order(order.orderId).cancellation, "cancelled");
  assert.equal(store.listCards()[0].successCount, 1);
  const manualCardId = store.listCards()[0].id;
  const retirement = `/api/admin/zzshu/cards/${manualCardId}/retire`;
  assert.equal((await post(retirement, {})).status, 200);
  assert.equal((await post(retirement, {})).status, 409);
  assert.equal(store.listCards().length, 0);
  assert.equal(store.order(order.orderId).status, "success");

  const { zzshuCredentialStore } = await import("../src/zzshu-credential-store.js");
  const originalVerify = zzshuCredentialStore.verify;
  t.after(() => { zzshuCredentialStore.verify = originalVerify; });
  let beginVerify;
  const verifying = new Promise(resolve => { beginVerify = resolve; });
  let finishVerify;
  zzshuCredentialStore.verify = async () => {
    beginVerify();
    return new Promise(resolve => { finishVerify = resolve; });
  };
  const replacing = post("/api/admin/zzshu/credential/verify-and-save", { apiKey: "fixture-replacement-key" });
  await verifying;
  const duringReplacement = await post("/api/recharge/confirm", { cardInfo: voucher.code });
  assert.equal(duringReplacement.status, 503);
  finishVerify({ ok: true, points: 0 });
  assert.equal((await replacing).status, 200);
});
