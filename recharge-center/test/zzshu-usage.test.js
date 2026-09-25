import assert from "node:assert/strict";
import test from "node:test";

test("ZZS usage queries the read-only upstream route and exposes only allowed fields", async t => {
  process.env.ZZSHU_API_KEY = "fixture-key";
  const { config } = await import("../src/config.js");
  config.zzshuBaseUrl = "https://zzshu.example.test";
  const { zzshuAdapter } = await import("../src/providers/zzshu-adapter.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), "https://zzshu.example.test/api/v1/third-party/orders/history");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["X-API-Key"], "fixture-key");
    assert.deepEqual(JSON.parse(options.body), { page: 2, page_size: 20 });
    return { ok: true, status: 200, json: async () => ({ code: 0, data: {
      page: 2, total: 21, remaining: 3, items: [{ task_no: "33559", created_at: "2026-09-25 14:03:15",
        email: "fixture@example.test", plan_type: "plus", status: "success", renewal_cancelled: false,
        result_message: "开通成功但取消续费未完成：must-not-leak", cdk_cost: 1,
        token: { sessionToken: "must-not-leak" }, bank_card_no: "4242424242424242" }] } }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  const result = await zzshuAdapter.usage(2);
  assert.equal(result.ok, true);
  assert.equal(result.data.items[0].cancellation, "failed");
  assert.equal(result.data.items[0].status, "success");
  assert.equal(result.data.items[0].points, 1);
  for (const secret of ["fixture-key", "must-not-leak", "4242424242424242"])
    assert.equal(JSON.stringify(result.data).includes(secret), false);
});
