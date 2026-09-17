import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("Hifupay admin groups cards, searches all groups and expands actions without changing card data", async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-hifupay-admin-ui-"));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  process.env.ADMIN_TOKEN = "ui-test-password";
  process.env.DATA_FILE = path.join(tempDir, "orders.json");
  const { server } = await import(`../src/server.js?admin-ui=${Date.now()}`);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const loginResponse = await fetch(`${base}/api/admin/login`, { method: "POST", headers: { Origin: "https://www.gptc.cc", "X-Admin-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ password: "ui-test-password" }) });
  const cookie = loginResponse.headers.get("set-cookie").split(";")[0];
  const response = await fetch(`${base}/admin/hifupay/cards`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /搜索全部分类/);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, {
        value: "", innerHTML: "", textContent: "", disabled: false,
        classList: { add() {}, remove() {} }
      });
      return elements.get(id);
    }
  };
  const context = vm.createContext({ document, location: { search: "", hash: "" }, URLSearchParams,
    window: { adminApi: () => new Promise(() => {}) }, fetch: () => { throw Error("No request expected"); } });
  vm.runInContext(script, context);
  const cards = [
    { id: "plus", enabled: true, poolStatus: "ready", status: "active", balance: 40, availableBalance: 40, lastFour: "1001", automaticPlusUsed: 1, priority: 0, plusUsers: [{ email: "plus@example.com" }] },
    { id: "pro", enabled: true, poolStatus: "pro_protected", proProtected: true, proReservation: { type: "20X Pro", account: "pro@example.com", renewalAt: "2026-10-15" }, status: "active", balance: 150, availableBalance: 150, lastFour: "1002", automaticPlusUsed: 0, priority: 0 },
    { id: "low", enabled: true, poolStatus: "low_balance", status: "active", balance: 0.01, availableBalance: 0.01, lastFour: "1003", automaticPlusUsed: 4, priority: 0 },
    { id: "off", enabled: false, poolStatus: "pro_protected", proProtected: true, status: "active", balance: 10, availableBalance: 10, lastFour: "1004", automaticPlusUsed: 0, priority: 0 }
  ];
  context.cardsForTest = cards;
  vm.runInContext("allCards=cardsForTest;applyCardSearch()", context);
  const rows = document.getElementById("cards");
  const tabs = document.getElementById("cardTabs");
  assert.match(tabs.innerHTML, /Plus 可用 1/);
  assert.match(tabs.innerHTML, /Pro 保护 1/);
  assert.match(tabs.innerHTML, /需处理 1/);
  assert.match(tabs.innerHTML, /已禁用 1/);
  assert.match(rows.innerHTML, /ID plus/);
  assert.doesNotMatch(rows.innerHTML, /ID low|plus@example.com|data-setting="priority"/);

  document.getElementById("cardSearch").value = "pro@example.com";
  document.getElementById("cardSearch").oninput();
  assert.match(rows.innerHTML, /ID pro/);
  assert.doesNotMatch(rows.innerHTML, /ID off/);
  assert.match(document.getElementById("count").textContent, /全库搜索/);
  document.getElementById("cardSearch").value = "";
  document.getElementById("cardSearch").oninput();
  document.getElementById("cards").onclick({ target: { closest(selector) { return selector === "[data-toggle]" ? { dataset: { toggle: "plus" } } : null; } } });
  assert.match(rows.innerHTML, /plus@example.com/);
  assert.match(rows.innerHTML, /data-setting="priority"/);
  assert.match(rows.innerHTML, /data-action="protect-pro"/);
  assert.match(rows.innerHTML, /data-action="disable"/);
  tabs.onclick({ target: { closest() { return { dataset: { category: "disabled" } }; } } });
  assert.match(rows.innerHTML, /ID off/);
  assert.doesNotMatch(rows.innerHTML, /ID pro/);

  context.cardsForTest = Array.from({ length: 21 }, (_, index) => ({
    ...cards[0], id: `ready-${index}`, lastFour: String(index).padStart(4, "0")
  }));
  vm.runInContext("allCards=cardsForTest;activeCategory='ready';page=0;applyCardSearch()", context);
  assert.match(document.getElementById("pageInfo").textContent, /1 \/ 2/);
  assert.match(rows.innerHTML, /ID ready-19/);
  assert.doesNotMatch(rows.innerHTML, /ID ready-20/);
  document.getElementById("nextPage").onclick();
  assert.match(rows.innerHTML, /ID ready-20/);
  assert.doesNotMatch(rows.innerHTML, /ID ready-0</);
});
