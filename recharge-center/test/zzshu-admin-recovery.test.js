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
  const { encryptSecretText } = await import("../src/utils.js");
  const { server } = await import("../src/server.js");
  store.addPaymentCard(parsePaymentCards("4242424242424242,12/40,123")[0],
    { credentialRef: "fixture-ref", source: "fixture", note: "", enabled: true, maxSuccess: 2 });
  const [voucher] = store.createVouchers(1, "fixture", 3,
    code => encryptSecretText(code, "fixture-encryption-key", "zzshu-voucher"));
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
  assert.equal(record.customerCardCode, voucher.code);
  assert.equal(record.customerCardId, "");
  assert.equal(record.paymentCardLastFour, "4242");
  assert.equal(record.accountId, "account-1");
  assert.equal(record.salesChannel, "fixture");
  assert.equal(record.status, "needs_review");
  assert.equal(record.hasUpstreamQueryKey, false);
  assert.match(record.processingNote, /创建响应丢失/);
  const { zzshuCredentialStore } = await import("../src/zzshu-credential-store.js");
  const rotated = await post("/api/admin/zzshu/credential/verify-and-save", { apiKey: "fixture-new-key", replace: true });
  assert.equal(rotated.status, 409);
  assert.equal(store.order(order.orderId).status, "needs_review");
  const pendingCards = await fetch(base + "/api/admin/zzshu/cards", { headers: { Cookie: cookie } }).then(response => response.json());
  assert.equal(pendingCards.data[0].successfulAccounts.length, 0);
  assert.equal(pendingCards.data[0].pendingAccount.email, "fixture@example.test");
  const resolution = `/api/admin/zzshu/orders/${order.orderId}/resolve`;
  assert.equal((await post(resolution, { outcome: "success", reason: "fixture upstream payment checked" })).status, 200);
  assert.equal((await post(resolution, { outcome: "success", reason: "fixture upstream payment checked" })).status, 409);
  assert.equal(store.listCards()[0].successCount, 1);
  const cardsResponse = await fetch(base + "/api/admin/zzshu/cards", { headers: { Cookie: cookie } }).then(response => response.json());
  assert.equal(cardsResponse.data[0].successfulAccounts.length, 1);
  assert.equal(cardsResponse.data[0].successfulAccounts[0].email, "fixture@example.test");
  assert.equal(cardsResponse.data[0].successfulAccounts[0].accountId, "account-1");
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

test("processing ZZS order can be closed only with a recorded upstream task and evidence", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-zzshu-processing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { ZzshuStore } = await import("../src/zzshu-store.js");
  const { parsePaymentCards } = await import("../src/zzshu-cards.js");
  const store = new ZzshuStore(path.join(dir, "orders.sqlite"));
  store.addPaymentCard(parsePaymentCards("4242424242424242,12/40,123")[0],
    { credentialRef: "fixture-ref", source: "fixture", note: "", enabled: true, maxSuccess: 1 });
  const [voucher] = store.createVouchers(1, "fixture", 3, () => "fixture-cipher");
  const order = store.reserve(voucher.code, "paid@example.test", "account-2");
  store.markSubmitting(order.orderId);
  assert.equal(store.manualResolve(order.orderId, "success", "上游订单已付款，账号已开通"), false);
  store.created(order.orderId, "upstream-2", "query-2");
  assert.equal(store.manualResolve(order.orderId, "success", "证据不足"), false);
  assert.equal(store.manualResolve(order.orderId, "success", "上游订单已付款，账号已开通"), true);
  assert.equal(store.order(order.orderId).status, "success");
  assert.equal(store.voucher(voucher.code).status, "used");
  assert.equal(store.listCards()[0].successCount, 1);
});
