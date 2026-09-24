import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { JsonStore } from "../src/store.js";
import { ZzshuStore } from "../src/zzshu-store.js";
import { createProService } from "../src/pro-orders.js";
import { encryptSecretText } from "../src/utils.js";
import { config } from "../src/config.js";

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-pro-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "orders.json");
  const usageStore = new ZzshuStore(path.join(dir, "usage.sqlite"));
  const store = new JsonStore(file, usageStore);
  store.syncHifupayCards([{ id: "fixed", lastFour: "1234", status: "active", balance: 500 },
    { id: "backup", lastFour: "9999", status: "active", balance: 50 }]);
  const calls = [];
  const adapter = { async listCards() { return { ok: true, data: { cards: options.remoteCards || [{ id: "fixed", balance: 500, status: "active" }, { id: "backup", balance: 600, status: "active" }] } }; },
    async startPro5x(input) { calls.push(input); return options.start ? options.start(input) : { ok: true, data: { taskId: "TASK-1" } }; },
    async queryTaskStatus() { return options.status?.() || { ok: true, data: { status: "processing", raw: { paymentConfirmed: false } } }; } };
  const service = createProService({ store, adapter });
  const code = plan => store.createHCards({ plan, count: 1 })[0].code;
  const submit = (card, email = "owner@example.com") => {
    const key = config.recoveryEncryptionKey || config.adminToken || "local-development-only";
    return store.createProOrder({ code: card, identity: { email }, source: "test", ciphertext: "encrypted-card",
      session: { userEmail: email, tokenHash: "hashed", authDataCiphertext: encryptSecretText('{"accessToken":"fake"}', key, "recharge-auth-data"),
        rawSecretCiphertext: encryptSecretText('{"accessToken":"fake"}', key, "recharge-secret-json") } });
  };
  return { store, usageStore, service, calls, code, submit, file };
}

test("Pro 20x and default Pro 5x stay manual, encrypted and idempotent", async t => {
  const x = fixture(t);
  assert.equal(x.service.settings().enabled, false);
  assert.equal(x.service.settings().estimatedChargeUsd, 93);
  assert.equal(x.service.settings().safetyBufferUsd, 7);
  for (const plan of ["pro_x5", "pro_x20"]) {
    const card = x.code(plan);
    const a = x.submit(card), b = x.submit(card);
    assert.equal(a.order.id, b.order.id);
    assert.equal(b.existing, true);
    assert.equal(a.order.status, "manual_queued");
    assert.equal(x.submit(card, "other@example.com").ok, false);
    assert.equal((await x.service.query({ orderId: a.order.id, cardInfo: "wrong" })).status, 404);
    assert.equal(x.service.detail(a.order.id).secretJsonText, '{"accessToken":"fake"}');
    assert.equal(x.service.action(a.order.id, "manual-processing").ok, true);
    assert.equal(x.service.action(a.order.id, "mark-success", { note: "done" }).ok, true);
    assert.equal(x.service.action(a.order.id, "mark-success").ok, true);
    assert.equal(x.store.getHCardByCode(card).status, "used");
  }
  await x.service.drain();
  assert.equal(x.calls.length, 0);
  assert.equal(x.store.listProOrders().length, 2);
});

test("manual Pro order can select a payment card without submitting a recharge", async t => {
  const x = fixture(t);
  const order = x.submit(x.code("pro_x20")).order;
  assert.equal(x.service.selectCard(order.id, "fixed").ok, true);
  assert.equal(x.service.detail(order.id).hifupayCardId, "fixed");
  assert.equal(x.calls.length, 0);
  assert.equal(x.service.selectCard(order.id, "missing").status, 409);
  assert.equal(x.service.action(order.id, "mark-success").ok, true);
  assert.equal(x.service.selectCard(order.id, "backup").status, 409);
});

test("operator 93 plus 7 rule requires at least 100 USD before automatic order", t => {
  const x = fixture(t);
  x.service.updateSettings({ enabled: true, cardId: "fixed", region: "EG", estimatedChargeUsd: 93, safetyBufferUsd: 7 });
  x.store.syncHifupayCards([{ id: "fixed", balance: 99.99, status: "active" }]);
  assert.equal(x.submit(x.code("pro_x5")).order.fulfillmentMode, "manual");
  x.store.syncHifupayCards([{ id: "fixed", balance: 100, status: "active" }]);
  const order = x.submit(x.code("pro_x5")).order;
  assert.equal(order.fulfillmentMode, "auto");
  assert.equal(order.estimatedChargeUsd + order.safetyBufferUsd, 100);
});

test("strict fixed card, plus isolation, concurrent queue and snapshot across setting changes", async t => {
  const x = fixture(t);
  const settings = { enabled: true, cardId: "fixed", region: "EG", estimatedChargeUsd: 100, safetyBufferUsd: 10 };
  assert.equal(x.service.updateSettings(settings).ok, true);
  const first = x.submit(x.code("pro_x5")), second = x.submit(x.code("pro_x5"));
  assert.equal(first.order.fulfillmentMode, "auto");
  assert.equal(x.store.reserveHifupayCard({ orderId: "plus-1", plan: "plus", identity: { email: "p@x.com" }, estimatedChargeUsd: 15 }).hifupayCardId, "backup");
  x.store.clearHifupayReservation("backup", "plus-1");
  x.service.updateSettings({ ...settings, enabled: false, cardId: "backup" });
  assert.equal(x.store.getOrder(first.order.id).hifupayCardId, "fixed");
  assert.equal(x.submit(x.code("pro_x5")).order.fulfillmentMode, "manual");
  await x.service.drain();
  assert.equal(x.calls.length, 1);
  assert.equal(x.calls[0].cardId, "fixed");
  assert.equal(x.calls[0].region, "EG");
  assert.equal(x.store.getOrder(second.order.id).status, "queued");
  assert.equal(x.service.action(first.order.id, "mark-success").status, 409);
});

test("unavailable selected card never falls back or submits", async t => {
  const x = fixture(t, { remoteCards: [{ id: "fixed", balance: 1, status: "active" }, { id: "backup", balance: 600, status: "active" }] });
  x.service.updateSettings({ enabled: true, cardId: "fixed", region: "EG", estimatedChargeUsd: 100, safetyBufferUsd: 10 });
  const order = x.submit(x.code("pro_x5")).order;
  await x.service.drain();
  assert.equal(x.store.getOrder(order.id).status, "manual_queued");
  assert.equal(x.calls.length, 0);
  assert.equal(x.store.listHifupayCards().find(c => c.id === "fixed").inFlightCount, 0);
});

test("timeout and restart retain reservation, require explicit no-charge attestation", async t => {
  const x = fixture(t, { start: () => { throw new Error("timeout"); } });
  x.service.updateSettings({ enabled: true, cardId: "fixed", region: "EG", estimatedChargeUsd: 100, safetyBufferUsd: 0 });
  const card = x.code("pro_x5"), order = x.submit(card).order;
  await x.service.drain();
  assert.equal(x.store.getOrder(order.id).status, "needs_review");
  assert.equal(x.store.listHifupayCards().find(c => c.id === "fixed").inFlightCount, 1);
  assert.equal(x.service.action(order.id, "mark-success").status, 409);
  const restarted = createProService({ store: new JsonStore(x.file, x.usageStore), adapter: { ...{} } });
  restarted.recoverOnStart();
  assert.equal(x.store.getOrder(order.id).status, "needs_review");
  assert.equal((await x.service.confirmNoCharge(order.id)).status, 409);
  assert.equal((await x.service.confirmNoCharge(order.id, { confirmedNoCharge: true, note: "上游核实未受理" })).ok, true);
  assert.equal(x.store.listHifupayCards().find(c => c.id === "fixed").inFlightCount, 0);
  assert.equal(x.service.action(order.id, "mark-success").ok, true);
  assert.equal((await x.service.query({ cardInfo: card })).data.status, "success");
});

test("payment confirmation succeeds independently of cancellation and cannot charge twice", async t => {
  let status = { ok: true, data: { status: "success", autoCancelDone: false, upstreamStatus: "completed", raw: { paymentConfirmed: true } } };
  const x = fixture(t, { status: () => status });
  x.service.updateSettings({ enabled: true, cardId: "fixed", region: "EG", estimatedChargeUsd: 100, safetyBufferUsd: 0 });
  const card = x.code("pro_x5"), order = x.submit(card).order;
  await x.service.drain();
  assert.equal(x.store.getOrder(order.id).upstreamTaskId, "TASK-1");
  const result = await x.service.query({ cardInfo: card, orderId: order.id });
  assert.equal(result.data.status, "success");
  assert.equal(result.data.subscriptionCancellationStatus, "failed");
  assert.equal(x.store.getHCardByCode(card).status, "used");
  await x.service.drain();
  assert.equal(x.calls.length, 1);
});

test("known task can move to manual only after two explicit unpaid checks and unchanged live balance", async t => {
  const x = fixture(t, { status: () => ({ ok: true, data: { status: "failed", upstreamStatus: "failed", unpaidTerminal: true,
    raw: { paymentConfirmed: false } } }) });
  x.service.updateSettings({ enabled: true, cardId: "fixed", region: "EG", estimatedChargeUsd: 100, safetyBufferUsd: 0 });
  const order = x.submit(x.code("pro_x5")).order;
  await x.service.drain();
  await x.service.refresh(order.id);
  assert.equal((await x.service.confirmNoCharge(order.id, { confirmedNoCharge: true, note: "上游未扣款" })).status, 409);
  assert.equal(x.store.getOrder(order.id).hifupayUnpaidConfirmationCount, 1);
  x.store.updateOrder(order.id, { hifupayUnpaidLastConfirmedAt: new Date(Date.now() - 120000).toISOString() });
  const result = await x.service.confirmNoCharge(order.id, { confirmedNoCharge: true, note: "第二次确认未扣款" });
  assert.equal(result.ok, true);
  assert.equal(x.store.getOrder(order.id).status, "manual_queued");
});
