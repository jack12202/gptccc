import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("documented pre-create rejection releases voucher; cardholder verification holds the same order", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-upstream-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_FILE = path.join(dir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(dir, "zzshu.sqlite");
  process.env.ZZSHU_ENABLED = "true";
  process.env.ZZSHU_API_KEY = "fixture-key";
  process.env.RECOVERY_ENCRYPTION_KEY = "fixture-encryption-key";
  const { zzshuService: service } = await import("../src/zzshu-service.js");
  const { zzshuCredentialStore } = await import("../src/zzshu-credential-store.js");
  const originalPreflight = zzshuCredentialStore.verifySaved;
  zzshuCredentialStore.verifySaved = async () => ({ ok: true, points: 9 });
  t.after(() => { zzshuCredentialStore.verifySaved = originalPreflight; });
  const { config } = await import("../src/config.js");
  config.zzshuBaseUrl = "https://fixture.example.test";
  const pan = "4242424242424242";
  assert.equal((await service.importCards({ text: `${pan},12/40,123`, source: "fixture", maxSuccess: 2 })).rows[0].status, "imported");
  const vouchers = service.createVouchers({ count: 2, source: "fixture" });
  const session = JSON.stringify({ user: { id: "u", email: "customer@example.test" },
    account: { id: "a", planType: "free" }, accessToken: "fixture.jwt.token",
    sessionToken: "fixture-session", expires: "2040-01-01T00:00:00Z" });
  let directCalls = 0;
  let status = "processing";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith("/direct")) {
      directCalls++;
      return directCalls === 1
        ? { ok: false, status: 429, json: async () => ({ code: 42902, message: "capacity full", data: null }) }
        : directCalls === 3
          ? { ok: false, status: 400, json: async () => ({ code: 40027, message: "expired session", data: null }) }
        : { ok: true, status: 201, json: async () => ({ code: 0, data: { order_no: "up-2", card_key: "DIRECT-2" } }) };
    }
    if (endpoint.endsWith("/status")) return { ok: true, status: 200, json: async () => ({ code: 0, data: {
      order_no: "up-2", card_key: "DIRECT-2", plan_type: "plus", status,
      verification: status === "processing" ? { client_secret: "secret-must-not-leak" } : null,
      payment_result: status === "success" ? { success: true, status: "paid" } : null,
      is_subscription_cancelled: 1
    } }) };
    throw Error("unexpected mock endpoint");
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const rejected = await service.confirm({ cardInfo: vouchers[0].code, secretJsonText: session });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 429);
  assert.equal(service.store.voucher(vouchers[0].code).status, "unused");
  assert.equal(service.store.listOrders()[0].status, "failed");
  assert.equal(service.store.listCards()[0].successCount, 0);
  assert.equal(service.store.listCards()[0].remainingUses, 1);
  assert.equal(service.store.listCards()[0].frozenUses, 1);

  const other = JSON.parse(session);
  other.user.email = "other@example.test";
  other.account.id = "other";
  const mismatch = await service.confirm({ cardInfo: vouchers[0].code, secretJsonText: JSON.stringify(other) });
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.message, /绑定首次/);
  assert.equal(directCalls, 1);

  const created = await service.confirm({ cardInfo: vouchers[1].code, secretJsonText: session });
  assert.equal(created.ok, true);
  assert.equal(created.data.status, "processing");
  const waiting = await service.refresh(created.data.orderId);
  assert.equal(waiting.data.status, "needs_review");
  assert.match(waiting.data.message, /银行卡持有人验证/);
  assert.equal(service.store.listCards()[0].occupiedOrderId, null);
  assert.equal(service.store.listCards()[0].frozenUses, 2);
  assert.equal(JSON.stringify(waiting.data).includes("secret-must-not-leak"), false);
  assert.equal(fs.readFileSync(process.env.ZZSHU_DB_FILE).includes(Buffer.from("secret-must-not-leak")), false);
  assert.equal((await service.confirm({ cardInfo: vouchers[1].code, secretJsonText: session })).data.orderId, created.data.orderId);
  assert.equal(directCalls, 2);

  status = "success";
  const finished = await service.refresh(created.data.orderId);
  assert.equal(finished.data.status, "success");
  assert.equal(service.store.voucher(vouchers[1].code).status, "used");
  assert.equal(service.store.listCards()[0].successCount, 1);
  await service.refresh(created.data.orderId);
  assert.equal(service.store.listCards()[0].successCount, 1);
  assert.equal(service.store.resolveFrozenUse(rejected.data?.orderId || service.store.listOrders().find(item => item.status === "failed").id, "release", "upstream rejected before creation"), true);
  const expiredSession = await service.confirm({ cardInfo: vouchers[0].code, secretJsonText: session });
  assert.equal(expiredSession.ok, false);
  assert.match(expiredSession.message, /重新获取完整 Session/);
  assert.equal(service.store.voucher(vouchers[0].code).status, "unused");
  assert.equal(service.store.listCards()[0].remainingUses, 0);
});
