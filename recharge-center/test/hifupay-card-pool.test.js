import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("hifupay card pool uses live balance and selects the lowest sufficient card", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-pool-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(path.join(tempDir, "orders.json"));
  store.syncHifupayCards([
    { id: "7172", lastFour: "4113", status: "active", balance: 50 },
    { id: "7667", lastFour: "6737", status: "active", balance: 66 }
  ]);

  // 第一张卡手动充值一次后余额为 $50，后续无需登记手动名额。
  for (let index = 1; index <= 3; index += 1) {
    const reservation = store.reserveHifupayCard({
      orderId: `plus-${index}`, plan: "plus",
      identity: { email: `user${index}@example.com` }, estimatedChargeUsd: 16,
      preferredCardId: "7172"
    });
    assert.equal(reservation.hifupayCardId, "7172");
    store.syncHifupayCards([
      { id: "7172", lastFour: "4113", status: "active", balance: Math.round((50 - index * 15.77) * 100) / 100 },
      { id: "7667", lastFour: "6737", status: "active", balance: 66 }
    ]);
    store.recordHifupayResult({ cardId: "7172", orderId: `plus-${index}`, plan: "plus", identity: { email: `user${index}@example.com` }, paymentConfirmed: true, status: "success" });
  }

  const first = store.listHifupayCards().find(card => card.id === "7172");
  assert.equal(first.balance, 2.69);
  assert.equal(first.poolStatus, "low_balance");
  assert.equal(first.automaticPlusUsed, 3);
  assert.equal(store.getHifupayEstimatedCharge("plus"), 15.77);

  const switched = store.reserveHifupayCard({ orderId: "plus-4", plan: "plus", identity: { email: "user4@example.com" }, estimatedChargeUsd: 16, preferredCardId: "7172" });
  assert.equal(switched.ok, true);
  assert.equal(switched.hifupayCardId, "7667");

  store.clearHifupayReservation("7667", "plus-4");
  store.syncHifupayCards([
    { id: "7172", lastFour: "4113", status: "active", balance: 2.69 },
    { id: "7667", lastFour: "6737", status: "active", balance: 15.76 }
  ]);
  const unavailable = store.reserveHifupayCard({ orderId: "plus-low", plan: "plus", identity: { email: "user5@example.com" }, estimatedChargeUsd: 16 });
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, "unavailable");

  store.syncHifupayCards([
    { id: "7172", lastFour: "4113", status: "active", balance: 2.69 },
    { id: "7667", lastFour: "6737", status: "active", balance: 16.5 }
  ]);
  const enough = store.reserveHifupayCard({ orderId: "plus-enough", plan: "plus", identity: { email: "user6@example.com" }, estimatedChargeUsd: store.getHifupayEstimatedCharge("plus") });
  assert.equal(enough.ok, true);
  assert.equal(enough.hifupayCardId, "7667");

  // 足额卡片同时可用时，优先余额较少的卡，而不是固定优先配置卡。
  store.clearHifupayReservation("7667", "plus-enough");
  store.syncHifupayCards([
    { id: "7172", lastFour: "4113", status: "active", balance: 18 },
    { id: "7667", lastFour: "6737", status: "active", balance: 40 }
  ]);
  const lowerBalanceFirst = store.reserveHifupayCard({ orderId: "plus-lower-first", plan: "plus", identity: { email: "user7@example.com" }, estimatedChargeUsd: 16, preferredCardId: "7667" });
  assert.equal(lowerBalanceFirst.ok, true);
  assert.equal(lowerBalanceFirst.hifupayCardId, "7172");
});

test("Plus selection excludes Pro-protected and over-66-dollar cards until manual release", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-protection-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const { JsonStore } = await import("../src/store.js");
  const dataFile = path.join(tempDir, "orders.json");
  const store = new JsonStore(dataFile);
  store.syncHifupayCards([
    { id: "pro-150", lastFour: "0150", status: "active", balance: 150 },
    { id: "pro-130", lastFour: "0130", status: "active", balance: 130 },
    { id: "plus-40", lastFour: "0040", status: "active", balance: 40 },
    { id: "plus-66", lastFour: "0066", status: "active", balance: 66 }
  ]);

  const protectedResult = store.protectHifupayCardForPro("plus-40", {
    type: "20X Pro",
    account: "pro-user@example.com",
    amountUsd: 150,
    renewalAt: "2026-10-15",
    note: "等待续费"
  });
  assert.equal(protectedResult.ok, true);

  const cards = new Map(store.listHifupayCards().map(card => [card.id, card]));
  assert.equal(cards.get("pro-150").poolStatus, "high_balance");
  assert.equal(cards.get("pro-130").poolStatus, "high_balance");
  assert.equal(cards.get("plus-40").poolStatus, "pro_protected");
  assert.equal(cards.get("plus-40").proReservation.account, "pro-user@example.com");
  assert.equal(cards.get("plus-66").poolStatus, "ready", "$66 is eligible; only balances above $66 are blocked");

  store.setHifupayCardPriority("plus-40", 0);
  store.setHifupayCardEnabled("plus-40", true);
  const selected = store.reserveHifupayCard({
    orderId: "plus-safe",
    plan: "plus",
    identity: { email: "plus-user@example.com" },
    estimatedChargeUsd: 16
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.hifupayCardId, "plus-66", "priority and enable must not bypass Pro protection");
  assert.equal(store.validateHifupayCardForSubmission({ cardId: "plus-66", orderId: "plus-safe", plan: "plus", estimatedChargeUsd: 16 }).ok, true);

  const reloaded = new JsonStore(dataFile);
  assert.equal(reloaded.listHifupayCards().find(card => card.id === "plus-40").proProtected, true, "protection survives a restart");
  reloaded.clearHifupayReservation("plus-66", "plus-safe");
  reloaded.setHifupayCardEnabled("plus-66", false);
  const noneAvailable = reloaded.reserveHifupayCard({
    orderId: "plus-blocked",
    plan: "plus",
    identity: { email: "blocked@example.com" },
    estimatedChargeUsd: 16
  });
  assert.equal(noneAvailable.ok, false);
  assert.match(noneAvailable.message, /Pro|66/);

  const released = reloaded.releaseHifupayCardProProtection("plus-40");
  assert.equal(released.ok, true);
  const afterRelease = reloaded.reserveHifupayCard({
    orderId: "plus-after-release",
    plan: "plus",
    identity: { email: "released@example.com" },
    estimatedChargeUsd: 16
  });
  assert.equal(afterRelease.ok, true);
  assert.equal(afterRelease.hifupayCardId, "plus-40");
});

test("final submission validation fails closed when protection changes", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-final-check-test-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(path.join(tempDir, "orders.json"));
  store.syncHifupayCards([{ id: "card-1", lastFour: "0001", status: "active", balance: 40 }]);
  const reservation = store.reserveHifupayCard({
    orderId: "order-1",
    plan: "plus",
    identity: { email: "test@example.com" },
    estimatedChargeUsd: 16
  });
  assert.equal(reservation.ok, true);

  const state = store.read();
  state.hifupayProReservations.push({
    id: "hpro-test",
    cardId: "card-1",
    status: "active",
    account: "protected@example.com",
    type: "5X Pro",
    createdAt: new Date().toISOString()
  });
  store.write(state);
  const finalCheck = store.validateHifupayCardForSubmission({
    cardId: "card-1",
    orderId: "order-1",
    plan: "plus",
    estimatedChargeUsd: 16
  });
  assert.equal(finalCheck.ok, false);
  assert.equal(finalCheck.status, "pro_protected");
});
