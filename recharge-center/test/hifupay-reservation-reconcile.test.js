import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

test("stale hifupay reservations freeze one use after two explicit unpaid confirmations", async t => {
  const balances = new Map([
    ["7870", 18.73],
    ["8907", 22.5],
    ["9000", 25],
    ["9100", 30],
    ["9200", 31],
    ["9300", 32],
    ["9400", 45],
    ["9500", 29],
    ["9600", 28]
  ]);
  const upstream = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/hfp/login") {
      sendJson(res, 200, { success: true, apiKey: "session-key" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/hfp/cards") {
      sendJson(res, 200, {
        cards: [...balances].map(([id, balance]) => ({ id, lastFour: id, status: "active", balance }))
      });
      return;
    }
    if (req.method === "GET" && req.url?.startsWith("/api/status/")) {
      const taskId = decodeURIComponent(req.url.slice("/api/status/".length));
      if (taskId === "task-network") {
        sendJson(res, 503, { error: "temporary unavailable" });
        return;
      }
      if (taskId === "task-ambiguous") {
        sendJson(res, 200, { status: "failed", paymentConfirmed: false, logs: ["payment polling timed out"] });
        return;
      }
      if (taskId === "task-processing") {
        sendJson(res, 200, { status: "running", paymentConfirmed: false });
        return;
      }
      sendJson(res, 200, {
        status: "failed",
        paymentConfirmed: false,
        logs: ["poll 23 status=open pay=unpaid", "payment polling timeout status=open pay=unpaid"]
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-reconcile-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const previous = Object.fromEntries([
    "DATA_FILE",
    "HIFUPAY_BASE_URL",
    "HIFUPAY_API_KEY",
    "HIFUPAY_FAILURE_CONFIRM_SECONDS",
    "HIFUPAY_STALE_RESERVATION_MINUTES",
    "HIFUPAY_PROCESSING_LOOKBACK_HOURS",
    "HIFUPAY_BALANCE_TOLERANCE_USD"
  ].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.DATA_FILE = path.join(tempDir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(tempDir, "zzshu.sqlite");
  process.env.HIFUPAY_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.HIFUPAY_API_KEY = "test-key";
  process.env.HIFUPAY_FAILURE_CONFIRM_SECONDS = "60";
  process.env.HIFUPAY_STALE_RESERVATION_MINUTES = "10";
  process.env.HIFUPAY_PROCESSING_LOOKBACK_HOURS = "168";
  process.env.HIFUPAY_BALANCE_TOLERANCE_USD = "0.5";

  const { JsonStore } = await import(`../src/store.js?reconcile=${Date.now()}`);
  const { rechargeService } = await import(`../src/recharge-service.js?reconcile=${Date.now()}`);
  const store = new JsonStore(process.env.DATA_FILE);
  const remoteCards = () => [...balances].map(([id, balance]) => ({ id, lastFour: id, status: "active", balance }));
  store.syncHifupayCards(remoteCards());

  function createReservedOrder(taskId, cardId, { stale = true, strictCard = true } = {}) {
    const order = store.createOrder({
      provider: "h",
      cardMask: "HPLU****TEST",
      productId: 3,
      status: "processing",
      message: "processing"
    });
    store.createRechargeSession({ orderId: order.id, userEmail: `${cardId}@example.com` });
    const reservation = store.reserveHifupayCard({
      orderId: order.id,
      plan: "plus",
      identity: { email: `${cardId}@example.com` },
      estimatedChargeUsd: 16,
      preferredCardId: cardId
    });
    assert.equal(reservation.ok, true);
    if (strictCard) assert.equal(reservation.cardId, cardId);
    store.updateOrder(order.id, {
      upstreamTaskId: taskId,
      hifupayCardId: reservation.cardId,
      hifupayCardLastFour: reservation.cardId
    });
    if (stale) {
      const state = store.read();
      const inFlight = state.hifupayCards.flatMap(card => card.inFlightOrders).find(item => item.orderId === order.id);
      inFlight.reservedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString();
      store.write(state);
    }
    return order.id;
  }

  const unpaidOrderId = createReservedOrder("task-unpaid", "7870");
  const first = await rechargeService.queryTaskStatus({ orderId: unpaidOrderId });
  assert.equal(first.ok, true);
  assert.equal(first.data.status, "needs_review");
  assert.match(first.data.message, /安全复核/);
  let unpaidOrder = store.getOrder(unpaidOrderId);
  assert.equal(unpaidOrder.hifupaySafetyStatus, "confirming_unpaid");
  assert.equal(unpaidOrder.hifupayUnpaidConfirmationCount, 1);
  assert.equal(store.inspectHifupayReservation("7870", unpaidOrderId).ok, true);

  await rechargeService.queryTaskStatus({ orderId: unpaidOrderId });
  unpaidOrder = store.getOrder(unpaidOrderId);
  assert.equal(unpaidOrder.hifupayUnpaidConfirmationCount, 1, "an immediate repeat must not count as the second confirmation");
  assert.equal(store.inspectHifupayReservation("7870", unpaidOrderId).ok, true);

  store.updateOrder(unpaidOrderId, { hifupayUnpaidLastConfirmedAt: new Date(Date.now() - 61_000).toISOString() });
  const confirmed = await rechargeService.queryTaskStatus({ orderId: unpaidOrderId });
  assert.equal(confirmed.data.status, "needs_review");
  unpaidOrder = store.getOrder(unpaidOrderId);
  assert.equal(unpaidOrder.hifupaySafetyStatus, "await_admin_unpaid");
  assert.equal(store.listHifupayCards().find(card => card.id === "7870").frozenCount, 1);
  assert.equal(store.inspectHifupayReservation("7870", unpaidOrderId).ok, true);

  const idempotent = await rechargeService.queryTaskStatus({ orderId: unpaidOrderId });
  assert.equal(idempotent.data.status, "needs_review");
  assert.equal(store.getOrder(unpaidOrderId).hifupaySafetyStatus, "await_admin_unpaid");

  balances.set("7870", 10);
  store.syncHifupayCards(remoteCards());
  const changedOrderId = createReservedOrder("task-balance-changed", "8907");
  await rechargeService.queryTaskStatus({ orderId: changedOrderId });
  store.updateOrder(changedOrderId, { hifupayUnpaidLastConfirmedAt: new Date(Date.now() - 61_000).toISOString() });
  balances.set("8907", 20.5);
  const changed = await rechargeService.queryTaskStatus({ orderId: changedOrderId });
  assert.equal(changed.data.status, "needs_review");
  assert.equal(store.getOrder(changedOrderId).hifupaySafetyStatus, "balance_changed");
  assert.equal(store.inspectHifupayReservation("8907", changedOrderId).ok, true);
  balances.set("8907", 22.5);
  await rechargeService.queryTaskStatus({ orderId: changedOrderId });
  assert.equal(store.getOrder(changedOrderId).hifupaySafetyStatus, "balance_changed", "a manual-review reservation must not be released by a later retry");
  assert.equal(store.inspectHifupayReservation("8907", changedOrderId).ok, true);

  const ambiguousOrderId = createReservedOrder("task-ambiguous", "9000");
  const ambiguous = await rechargeService.queryTaskStatus({ orderId: ambiguousOrderId });
  assert.equal(ambiguous.data.status, "needs_review");
  assert.equal(store.getOrder(ambiguousOrderId).hifupaySafetyStatus, "manual_review");
  assert.equal(store.getOrder(ambiguousOrderId).hifupayUnpaidConfirmationCount, 0);
  assert.equal(store.inspectHifupayReservation("9000", ambiguousOrderId).ok, true);

  const networkOrderId = createReservedOrder("task-network", "9100");
  const network = await rechargeService.queryTaskStatus({ orderId: networkOrderId });
  assert.equal(network.ok, false);
  assert.equal(store.getOrder(networkOrderId).status, "processing");
  assert.equal(store.getOrder(networkOrderId).hifupaySafetyStatus, "");
  assert.equal(store.inspectHifupayReservation("9100", networkOrderId).ok, true);

  const concurrentOrderId = createReservedOrder("task-concurrent-unpaid", "9200");
  await rechargeService.queryTaskStatus({ orderId: concurrentOrderId });
  store.updateOrder(concurrentOrderId, { hifupayUnpaidLastConfirmedAt: new Date(Date.now() - 61_000).toISOString() });
  await Promise.all([
    rechargeService.queryTaskStatus({ orderId: concurrentOrderId }),
    rechargeService.queryTaskStatus({ orderId: concurrentOrderId })
  ]);
  assert.equal(store.getOrder(concurrentOrderId).status, "needs_review");
  assert.equal(store.getOrder(concurrentOrderId).hifupaySafetyStatus, "await_admin_unpaid");
  assert.equal(store.inspectHifupayReservation("9200", concurrentOrderId).ok, true);

  const processingOrderId = createReservedOrder("task-processing", "9600");
  const recentOrderId = createReservedOrder("task-processing", "9500", { stale: false });
  const manualOrderId = createReservedOrder("task-ambiguous", "9400", { strictCard: false });
  const manualCardId = store.getOrder(manualOrderId).hifupayCardId;
  await rechargeService.queryTaskStatus({ orderId: manualOrderId });
  assert.equal(rechargeService.clearHifupayReservation(manualCardId, manualOrderId, "太短").status, 409);
  assert.equal(store.inspectHifupayReservation(manualCardId, manualOrderId).ok, true);
  assert.equal(rechargeService.clearHifupayReservation(manualCardId, manualOrderId, "已核对嗨付记录确认没有扣款").ok, true);
  assert.equal(store.getOrder(manualOrderId).status, "failed");
  assert.equal(store.getOrder(manualOrderId).hifupaySafetyStatus, "released_unpaid_manual");
  assert.equal(store.inspectHifupayReservation(manualCardId, manualOrderId).ok, false);
  const staleOrders = store.listStaleHifupayReservationOrders({ staleMinutes: 10, lookbackHours: 168, limit: 20 });
  assert.ok(staleOrders.some(item => item.orderId === processingOrderId));
  assert.ok(!staleOrders.some(item => item.orderId === recentOrderId));
  assert.ok(!staleOrders.some(item => item.orderId === ambiguousOrderId));
  assert.ok(!staleOrders.some(item => item.orderId === changedOrderId));
  const dailySafetyOrders = store.listStaleHifupayReservationOrders({
    staleMinutes: 10,
    lookbackHours: 168,
    limit: 20,
    includeManualReview: true
  });
  assert.ok(dailySafetyOrders.some(item => item.orderId === ambiguousOrderId));
  assert.ok(dailySafetyOrders.some(item => item.orderId === changedOrderId));
});
