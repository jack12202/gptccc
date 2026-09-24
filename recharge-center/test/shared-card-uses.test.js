import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("H and ZZS share one card's use count and rotate only after it is exhausted", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-shared-uses-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { JsonStore } = await import("../src/store.js");
  const { ZzshuStore } = await import("../src/zzshu-store.js");
  const usage = new ZzshuStore(path.join(dir, "usage.sqlite"));
  const store = new JsonStore(path.join(dir, "orders.json"), usage);
  store.syncHifupayCards([
    { id: "first", lastFour: "1001", status: "active", balance: 40 },
    { id: "second", lastFour: "1002", status: "active", balance: 40 }
  ]);
  const firstId = usage.hifupayUsage("first").id;
  assert.equal(usage.updateCard(firstId, { maxSuccess: 2 }), true);
  const h = store.reserveHifupayCard({ orderId: "h-1", plan: "plus", identity: { email: "a@example.com" }, estimatedChargeUsd: 16 });
  assert.equal(h.cardId, "first");
  store.recordHifupayResult({ cardId: "first", orderId: "h-1", plan: "plus", identity: { email: "a@example.com" }, paymentConfirmed: true, status: "success" });
  assert.equal(usage.hifupayUsage("first").hSuccessCount, 1);

  const [voucher] = usage.createVouchers(1, "fixture", 3, () => "cipher");
  const z = usage.reserve(voucher.code, "b@example.com", "b", new Set(["first", "second"]), false);
  assert.equal(z.ok, true);
  assert.equal(z.credentialRef, "hifupay:first");
  usage.markSubmitting(z.orderId);
  usage.created(z.orderId, "upstream-order", "upstream-key");
  usage.settle(z.orderId, "success", "cancelled");
  assert.equal(usage.hifupayUsage("first").zzshuSuccessCount, 1);
  assert.equal(usage.listCards().find(card => card.hifupayId === "first").remainingUses, 0);

  const next = store.reserveHifupayCard({ orderId: "h-2", plan: "plus", identity: { email: "c@example.com" }, estimatedChargeUsd: 16 });
  assert.equal(next.cardId, "second");
});

test("a failed use freezes one slot while the same card can take another order", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-frozen-slot-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { ZzshuStore } = await import("../src/zzshu-store.js");
  const { config } = await import("../src/config.js");
  const previousConcurrency = config.zzshuConcurrency;
  config.zzshuConcurrency = 1;
  t.after(() => { config.zzshuConcurrency = previousConcurrency; });
  const usage = new ZzshuStore(path.join(dir, "usage.sqlite"));
  usage.ensureHifupayCard({ id: "shared", lastFour: "1001" }, 2, 0);
  const vouchers = usage.createVouchers(2, "fixture", 3, () => "cipher");
  const first = usage.reserve(vouchers[0].code, "a@example.com", "a", new Set(["shared"]), false);
  assert.equal(first.ok, true);
  usage.review(first.orderId, "上游支付结果待核查");
  const card = usage.listCards().find(item => item.hifupayId === "shared");
  assert.equal(card.frozenUses, 1);
  assert.equal(card.remainingUses, 1);
  const second = usage.reserve(vouchers[1].code, "b@example.com", "b", new Set(["shared"]), false);
  assert.equal(second.ok, true);
  assert.equal(second.credentialRef, "hifupay:shared");
});
