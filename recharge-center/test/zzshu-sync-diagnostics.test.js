import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("ZZS rejected check is visible; later paid opening settles once while cancellation remains pending", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-sync-diagnostics-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_FILE = path.join(dir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(dir, "zzshu.sqlite");
  process.env.ZZSHU_API_KEY = "fixture-key";
  process.env.ZZSHU_ENABLED = "true";
  process.env.RECOVERY_ENCRYPTION_KEY = "fixture-encryption-key";
  const { config } = await import("../src/config.js");
  config.zzshuBaseUrl = "https://zzshu.example.test";
  const { zzshuService } = await import("../src/zzshu-service.js");
  const { parsePaymentCards } = await import("../src/zzshu-cards.js");
  const store = zzshuService.store;
  store.addPaymentCard(parsePaymentCards("4242424242424242,12/40,123")[0],
    { credentialRef: "fixture-ref", source: "fixture", note: "", enabled: true, maxSuccess: 2 });
  const [voucher] = store.createVouchers(1, "fixture", 3, () => "fixture-cipher");
  const reservation = store.reserve(voucher.code, "fixture@example.test", "account-1");
  store.markSubmitting(reservation.orderId);
  store.created(reservation.orderId, "upstream-1", "query-1");
  const originalFetch = globalThis.fetch;
  let accepted = false;
  let checks = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, "/api/v1/third-party/orders/status");
    assert.equal(JSON.parse(options.body).cardKey, "query-1");
    checks++;
    return accepted
      ? { ok: true, status: 200, json: async () => ({ code: 0, data: {
          order_no: "upstream-1", card_key: "query-1", plan_type: "plus", status: "success",
          payment_result: { success: true, status: "paid" }, is_subscription_cancelled: 0,
          token: { sessionToken: "must-not-leak" }, bank_card_no: "4242424242424242"
        } }) }
      : { ok: false, status: 401, json: async () => ({ code: 40107, message: "must-not-leak" }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  await zzshuService.refresh(reservation.orderId);
  assert.equal(store.order(reservation.orderId).status, "processing");
  assert.equal(store.listOrders()[0].lastCheckResult, "api_rejected");
  assert.equal(store.listOrders()[0].lastCheckHttpStatus, 401);
  assert.equal(store.listOrders()[0].lastCheckCode, 40107);
  assert.equal(JSON.stringify(store.listOrders()).includes("must-not-leak"), false);
  accepted = true;
  await zzshuService.refresh(reservation.orderId);
  assert.equal(store.order(reservation.orderId).status, "success");
  assert.equal(store.order(reservation.orderId).cancellation, "unconfirmed");
  assert.equal(store.listOrders()[0].lastCheckResult, "paid");
  await zzshuService.refresh(reservation.orderId);
  assert.equal(store.listCards()[0].successCount, 1);
  assert.equal(store.voucher(voucher.code).status, "used");
  assert.equal(checks, 3);
});
