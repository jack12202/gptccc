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

test("hifupay adapter never calls start for high-balance or Pro-protected cards", async t => {
  let balance = 150;
  let startCalls = 0;
  const upstream = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/hfp/login") {
      sendJson(res, 200, { success: true, apiKey: "session-key" });
      return;
    }
    if (req.method === "POST" && req.url === "/api/hfp/cards") {
      sendJson(res, 200, { cards: [{ id: "protected-card", lastFour: "7657", status: "active", balance }] });
      return;
    }
    if (req.method === "POST" && req.url === "/api/start") {
      startCalls += 1;
      sendJson(res, 200, { taskId: "must-not-start" });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-adapter-protection-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const previous = Object.fromEntries([
    "DATA_FILE",
    "HIFUPAY_BASE_URL",
    "HIFUPAY_API_KEY",
    "HIFUPAY_PLUS_MAX_BALANCE_USD"
  ].map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.DATA_FILE = path.join(tempDir, "orders.json");
  process.env.HIFUPAY_BASE_URL = `http://127.0.0.1:${upstream.address().port}`;
  process.env.HIFUPAY_API_KEY = "test-key";
  process.env.HIFUPAY_PLUS_MAX_BALANCE_USD = "66";

  const { hifupayAdapter } = await import(`../src/providers/hifupay-adapter.js?protection=${Date.now()}`);
  const { JsonStore } = await import("../src/store.js");
  const store = new JsonStore(process.env.DATA_FILE);
  const [highBalanceCode] = store.createHCards({ count: 1, productId: 3 });
  const highBalanceResult = await hifupayAdapter.startRecharge({
    cardInfo: highBalanceCode.code,
    orderId: "high-balance-order",
    fullAuthData: { user: { email: "plus@example.com" }, account: { id: "plus-account" }, accessToken: "token" }
  });
  assert.equal(highBalanceResult.ok, false);
  assert.equal(highBalanceResult.status, 409);
  assert.equal(startCalls, 0);

  balance = 40;
  store.syncHifupayCards([{ id: "protected-card", lastFour: "7657", status: "active", balance }]);
  const protection = store.protectHifupayCardForPro("protected-card", {
    type: "20X Pro",
    account: "pro@example.com",
    amountUsd: 150
  });
  assert.equal(protection.ok, true);
  const [proProtectedCode] = store.createHCards({ count: 1, productId: 3 });
  const proProtectedResult = await hifupayAdapter.startRecharge({
    cardInfo: proProtectedCode.code,
    orderId: "pro-protected-order",
    fullAuthData: { user: { email: "second@example.com" }, account: { id: "second-account" }, accessToken: "token" }
  });
  assert.equal(proProtectedResult.ok, false);
  assert.equal(proProtectedResult.status, 409);
  assert.equal(startCalls, 0);
});
