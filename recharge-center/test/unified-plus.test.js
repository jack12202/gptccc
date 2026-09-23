import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("new Plus cards switch before use and keep their chosen provider after submission", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-unified-plus-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_FILE = path.join(dir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(dir, "zzshu.sqlite");
  process.env.ZZSHU_ENABLED = "true";
  process.env.ZZSHU_API_KEY = "fixture-key";
  process.env.HIFUPAY_API_KEY = "fixture-hifupay-key";
  process.env.RECOVERY_ENCRYPTION_KEY = "fixture-secret";
  const { rechargeService } = await import("../src/recharge-service.js");
  const { zzshuService } = await import("../src/zzshu-service.js");
  const { JsonStore } = await import("../src/store.js");
  const local = new JsonStore(process.env.DATA_FILE);
  const old = local.createHCards({ count: 1 })[0];
  const created = rechargeService.createHCards({ count: 2, plan: "plus" });
  assert.equal(created.ok, true);
  const [first, second] = created.data.cards;
  assert.equal(local.getHCardByCode(old.code).unified, false);
  assert.equal(local.getHCardByCode(first.code).unified, true);
  assert.equal(zzshuService.store.voucher(first.code).status, "unused");
  const removable = rechargeService.createHCards({ count: 1, plan: "plus" }).data.cards[0];
  assert.ok(zzshuService.store.voucher(removable.code));
  assert.equal(rechargeService.deleteHCard(removable.id).ok, true);
  assert.equal(zzshuService.store.voucher(removable.code), undefined);
  assert.equal(rechargeService.getProviderSettings().plusProvider, "h");
  assert.equal(rechargeService.updatePlusProvider("zzshu").ok, true);
  assert.equal((await rechargeService.verifyCard(first.code, "h")).data.selectedProvider, "zzshu");
  assert.equal((await rechargeService.verifyCard(old.code, "zzshu")).data.selectedProvider, "h");

  const session = JSON.stringify({ user: { id: "user", email: "new@example.test" },
    account: { id: "account", planType: "free" }, accessToken: "fixture-access",
    sessionToken: "fixture-session", expires: "2040-01-01" });
  const unavailable = await rechargeService.confirmRecharge({ cardInfo: first.code, provider: "h", secretJsonText: session });
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.message, /暂无可用支付卡/);
  assert.equal(zzshuService.store.voucher(first.code).status, "unused");
  assert.equal(local.getHCardByCode(first.code).status, "unused");
  assert.equal(rechargeService.updatePlusProvider("h").ok, true);
  assert.equal((await rechargeService.verifyCard(first.code, "h")).data.selectedProvider, "h");
  assert.equal((await rechargeService.verifyCard(second.code, "h")).data.selectedProvider, "h");
  assert.equal(rechargeService.updatePlusProvider("zzshu").ok, true);
  assert.equal((await zzshuService.importCards({ text: "4242424242424242,12/40,123", source: "fixture", maxSuccess: 1 })).rows[0].status, "imported");
  let creates = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith("/direct")) {
      creates += 1;
      assert.equal(JSON.parse(options.body).cardNumber, "4242424242424242");
      return { ok: true, status: 201, json: async () => ({ code: 0, data: { order_no: "order-1", card_key: "key-1" } }) };
    }
    if (endpoint.endsWith("/status")) return { ok: true, status: 200, json: async () => ({ code: 0,
      data: { order_no: "order-1", card_key: "key-1", plan_type: "plus", status: "success",
        is_subscription_cancelled: 1, payment_result: { success: true, status: "paid" } } }) };
    throw new Error("unexpected fixture endpoint");
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  const started = await rechargeService.confirmRecharge({ cardInfo: first.code, provider: "h", secretJsonText: session });
  assert.equal(started.ok, true);
  assert.equal(started.data.provider, "zzshu");
  assert.equal(creates, 1);
  assert.equal(rechargeService.updatePlusProvider("h").ok, true);
  assert.equal((await rechargeService.verifyCard(first.code, "h")).data.selectedProvider, "zzshu");
  const duplicate = await rechargeService.confirmRecharge({ cardInfo: first.code, provider: "h", secretJsonText: session });
  assert.equal(duplicate.data.orderId, started.data.orderId);
  assert.equal(creates, 1);
  assert.equal((await rechargeService.getStatus(started.data.orderId)).data.status, "success");
  assert.equal(local.getHCardByCode(first.code).status, "used");
  assert.equal(zzshuService.store.voucher(first.code).status, "used");
  assert.equal((await rechargeService.verifyCard(first.code, "h")).ok, false);
  const hAttempt = await rechargeService.confirmRecharge({ cardInfo: second.code, provider: "zzshu", secretJsonText: session });
  assert.equal(hAttempt.data.provider, "h");
  assert.equal(local.getHCardByCode(second.code).routedProvider, "h");
  assert.equal(zzshuService.store.voucher(second.code).status, "unused");
  assert.equal(creates, 1);
  assert.equal(rechargeService.updatePlusProvider("invalid").ok, false);
});
