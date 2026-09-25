import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("ZZS gateway outage rejects a new submission before reserving payment or voucher", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-preflight-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_FILE = path.join(dir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(dir, "zzshu.sqlite");
  process.env.ZZSHU_ENABLED = "true";
  process.env.ZZSHU_API_KEY = "fixture-key";
  process.env.RECOVERY_ENCRYPTION_KEY = "fixture-encryption-key";
  const { zzshuService } = await import("../src/zzshu-service.js");
  const { zzshuCredentialStore } = await import("../src/zzshu-credential-store.js");
  const originalPreflight = zzshuCredentialStore.verifySaved;
  zzshuCredentialStore.verifySaved = async () => ({ ok: false, upstreamHttpStatus: 520 });
  t.after(() => { zzshuCredentialStore.verifySaved = originalPreflight; });
  const imported = await zzshuService.importCards({ text: "4242424242424242,12/40,123", source: "fixture" });
  assert.equal(imported.rows[0].status, "imported");
  const [voucher] = zzshuService.createVouchers({ count: 1, source: "fixture" });
  const session = JSON.stringify({ user: { id: "user-1", email: "fixture@example.test" },
    account: { id: "account-1", planType: "free" }, accessToken: "fixture-access",
    sessionToken: "fixture-session", expires: "2040-01-01" });
  const result = await zzshuService.confirm({ cardInfo: voucher.code, secretJsonText: session });
  assert.equal(result.ok, false);
  assert.equal(result.status, 503);
  assert.match(result.message, /尚未提交/);
  assert.equal(zzshuService.store.listOrders().length, 0);
  assert.equal(zzshuService.store.voucher(voucher.code).status, "unused");
  assert.equal(zzshuService.store.listCards()[0].occupiedOrderId, null);
  assert.equal(zzshuService.store.listCards()[0].successCount, 0);
});
