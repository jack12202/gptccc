import assert from "node:assert/strict";
import test from "node:test";

test("ZZS 上游状态完整映射为充值系统状态", async t => {
  process.env.ZZSHU_ENABLED = "true";
  process.env.ZZSHU_API_KEY = "fixture-key";
  process.env.ZZSHU_BASE_URL = "https://fixture.example.test";
  const originalFetch = globalThis.fetch;
  let responseData = {};
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ code: 0, data: {
    order_no: "order-1", card_key: "key-1", plan_type: "plus", is_subscription_cancelled: 0, ...responseData
  } }) });
  t.after(() => { globalThis.fetch = originalFetch; });
  const { zzshuAdapter } = await import("../src/providers/zzshu-adapter.js");

  const cases = [
    [{ status: "pending" }, "processing"],
    [{ status: "processing" }, "processing"],
    [{ status: "success", payment_result: { success: true, status: "paid" } }, "success"],
    [{ status: "failed", payment_result: { success: false, status: "failed" } }, "unpaid"],
    [{ status: "processing", verification: { required: true } }, "verification_required"],
    [{ status: "success", payment_result: null }, "needs_review"],
    [{ status: "failed", payment_result: null }, "needs_review"],
    [{ status: "unexpected_state" }, "unknown"]
  ];
  for (const [upstream, expected] of cases) {
    responseData = upstream;
    const result = await zzshuAdapter.status("key-1");
    assert.equal(result.ok, true);
    assert.equal(result.data.status, expected);
  }
});
