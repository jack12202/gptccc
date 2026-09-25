import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("admin API reports a gateway HTML response without parsing it as JSON", async () => {
  const script = fs.readFileSync(path.join(import.meta.dirname, "../admin/session.js"), "utf8");
  const calls = [];
  const context = {
    URL, location: { href: "https://www.gptc.cc/admin", pathname: "/admin" },
    history: { replaceState() {} }, localStorage: { removeItem() {} },
    document: { addEventListener() {} },
    window: { addEventListener() {} },
    fetch: async url => {
      calls.push(url);
      if (url === "/api/admin/session") return {
        status: 200, ok: true, json: async () => ({ success: true, data: { csrf: "fixture-csrf" } })
      };
      return { status: 520, ok: false, headers: { get: name => name === "cf-ray" ? "fixture-ray-SJC" : null },
        json: async () => { throw new SyntaxError("Unexpected token '<'"); } };
    }
  };
  vm.runInNewContext(script, context);
  await assert.rejects(context.window.adminApi("/api/admin/zzshu/credential/check"), error => {
    assert.match(error.message, /本站接口返回非 JSON 响应（HTTP 520）/);
    assert.match(error.message, /fixture-ray-SJC/);
    assert.doesNotMatch(error.message, /Unexpected token/);
    return true;
  });
  assert.deepEqual(calls, ["/api/admin/session", "/api/admin/zzshu/credential/check"]);
});
