import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

test("one payment-card page lists H and manual cards with shared counts and source-specific actions", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gptc-unified-card-ui-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.ADMIN_TOKEN = "unified-ui-test-password";
  process.env.DATA_FILE = path.join(dir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(dir, "usage.sqlite");
  const { server } = await import(`../src/server.js?unified-ui=${Date.now()}`);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + "/api/admin/login", { method: "POST", headers: { Origin: "https://www.gptc.cc", "X-Admin-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ password: "unified-ui-test-password" }) });
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await fetch(base + "/admin/hifupay/cards", { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>支付卡池<\/h1>/);
  assert.match(html, /全部支付卡/);
  assert.match(html, /导入手动支付卡/);
  assert.match(html, /批量设置总次数/);
  assert.ok(html.indexOf('id="importPanel"') < html.indexOf('<h2>全部支付卡</h2>'));
  assert.match(html, /id="importPanel" open/);
  assert.doesNotMatch(html, /嗨付支付卡<\/a>|ZZS 支付卡<\/a>/);
  assert.equal((await fetch(base + "/admin/hifupay/cards?tab=zzshu", { headers: { Cookie: cookie } })).status, 200);
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  const elements = new Map();
  const document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, { value: "", innerHTML: "", textContent: "", disabled: false, dataset: {},
      classList: { toggle() {}, add() {}, remove() {} }, querySelectorAll() { return []; } });
    return elements.get(id);
  } };
  const h = { id: "h-1", lastFour: "1001", enabled: true, status: "active", poolStatus: "ready", balance: 40,
    usedCount: 1, frozenCount: 1, maxUses: 4, remainingUses: 2, priority: 0, plusUsers: [{ email: "h@example.test" }] };
  const manual = { id: "m-1", lastFour: "2002", credentialSource: "manual", source: "团购", enabled: true,
    successCount: 1, frozenUses: 0, maxSuccess: 3, remainingUses: 2, successfulAccounts: [{ email: "m@example.test" }] };
  const calls = [], writes = [];
  const context = vm.createContext({ document, window: { adminApi: async (url, options) => {
    calls.push(url);
    if (options?.method === "POST") { writes.push({ url, body: JSON.parse(options.body) }); return {}; }
    if (url.startsWith("/api/admin/hifupay/cards")) return { cards: [h] };
    if (url === "/api/admin/zzshu/cards") return [manual, { ...manual, credentialSource: "hifupay", id: "duplicate" }];
    if (url === "/api/admin/zzshu/import-status") return { ready: true, message: "可导入" };
    throw Error("unexpected endpoint: " + url);
  } }, confirm: () => true, prompt: () => "5" });
  vm.runInContext(script, context);
  await vm.runInContext("load()", context);
  const rows = document.getElementById("cards");
  assert.match(rows.innerHTML, /•••• 1001/);
  assert.match(rows.innerHTML, /•••• 2002/);
  assert.doesNotMatch(rows.innerHTML, /duplicate/);
  assert.match(rows.innerHTML, /嗨付同步/);
  assert.match(rows.innerHTML, /团购/);
  assert.match(rows.innerHTML, /冻结 1/);
  assert.match(rows.innerHTML, /ZZS/);
  assert.match(document.getElementById("stats").innerHTML, /卡池总数/);
  assert.match(document.getElementById("stats").innerHTML, /<strong>4<\/strong><small>当前可轮选次数/);
  assert.match(rows.innerHTML, /剩余 <strong>2<\/strong> \/ 总 4/);
  assert.match(document.getElementById("total").textContent, /2 \/ 2/);
  vm.runInContext("expanded.add('manual:m-1');render()", context);
  assert.match(rows.innerHTML, /class="history-item"/);
  assert.match(rows.innerHTML, /class="history-email">m@example.test/);
  assert.match(rows.innerHTML, /class="history-meta"/);
  assert.match(rows.innerHTML, /data-action="manual-cap"/);
  assert.match(rows.innerHTML, /data-action="manual-retire"/);
  vm.runInContext("expanded.add('h:h-1');render()", context);
  assert.match(rows.innerHTML, /data-setting="priority"/);
  assert.match(rows.innerHTML, /data-action="protect-pro"/);
  document.getElementById("search").value = "团购";
  document.getElementById("search").oninput();
  assert.match(rows.innerHTML, /•••• 2002/);
  assert.doesNotMatch(rows.innerHTML, /•••• 1001/);
  assert.ok(calls.includes("/api/admin/zzshu/cards"));
  document.getElementById("search").value = "";
  document.getElementById("search").oninput();
  document.getElementById("selectPage").onclick();
  assert.equal(document.getElementById("selectedCount").textContent, "已选 2 张");
  await document.getElementById("bulkbar").onclick({ target: { closest: () => ({ dataset: { bulk: "disable" } }) } });
  assert.deepEqual(writes.map(write => write.url), ["/api/admin/hifupay/cards/h-1/disable", "/api/admin/zzshu/cards/m-1"]);
  assert.equal(document.getElementById("selectedCount").textContent, "已选 0 张");
  document.getElementById("selectPage").onclick();
  await document.getElementById("bulkbar").onclick({ target: { closest: () => ({ dataset: { bulk: "cap" } }) } });
  assert.deepEqual(writes.slice(2), [
    { url: "/api/admin/hifupay/cards/h-1/settings", body: { field: "maxUses", value: 5 } },
    { url: "/api/admin/zzshu/cards/m-1", body: { maxSuccess: 5, note: "" } }
  ]);
  vm.runInContext("cards.push({...cards[0],uid:'h:paused',id:'paused',state:'disabled',channels:[],remaining:5});render()", context);
  assert.match(document.getElementById("stats").innerHTML, /<strong>4<\/strong><small>当前可轮选次数/);
  assert.match(document.getElementById("stats").innerHTML, /<strong>9<\/strong><small>卡池剩余总次数（含不可轮选）/);
});
