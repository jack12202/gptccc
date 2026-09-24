import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("recent retained Session JSON backfills account UUID without exposing the token", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-account-id-sync-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_FILE = path.join(dir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(dir, "zzshu.sqlite");
  process.env.RECOVERY_ENCRYPTION_KEY = "account-id-fixture-key";
  const { JsonStore } = await import("../src/store.js");
  const { rechargeService } = await import("../src/recharge-service.js");
  const { encryptSecretText } = await import("../src/utils.js");
  const store = new JsonStore(process.env.DATA_FILE);
  const accountId = "2628a750-ef4f-4cd3-a417-6626e9ab4f80";
  const sessionJson = JSON.stringify({ user: { email: "recent@example.test" }, account: { id: accountId }, accessToken: "private-token" });
  const recent = store.createOrder({ provider: "h", cardMask: "HPLUS****TEST", status: "success" });
  store.createRechargeSession({ orderId: recent.id, userEmail: "recent@example.test",
    rawSecretCiphertext: encryptSecretText(sessionJson, "account-id-fixture-key", "recharge-secret-json") });
  const old = store.createOrder({ provider: "h", cardMask: "HPLUS****OLD", status: "success" });
  store.createRechargeSession({ orderId: old.id, userEmail: "old@example.test",
    rawSecretCiphertext: encryptSecretText(sessionJson, "account-id-fixture-key", "recharge-secret-json") });
  const state = store.read();
  state.orders.find(item => item.id === old.id).createdAt = new Date(Date.now() - 10 * 86400000).toISOString();
  store.write(state);

  assert.deepEqual(rechargeService.syncRecentAccountIds(), { scanned: 1, updated: 1, missing: 0 });
  assert.deepEqual(rechargeService.syncRecentAccountIds(), { scanned: 1, updated: 0, missing: 0 });
  const saved = store.read();
  assert.equal(saved.rechargeSessions.find(item => item.orderId === recent.id).accountId, accountId);
  assert.equal(saved.rechargeSessions.find(item => item.orderId === old.id).accountId, "");
  const record = rechargeService.listRechargeSubmissions().data.records.find(item => item.id === recent.id);
  assert.equal(record.accountId, accountId);
  assert.equal(record.userEmail, "recent@example.test");
  assert.equal(JSON.stringify(record).includes("private-token"), false);
  assert.equal(rechargeService.getRecoverySubmission(recent.id).data.accountId, accountId);
});
