import assert from "node:assert/strict";

// Read-only production smoke check: no card, provider, or recharge mutations.
const base = "https://www.gptc.cc";
const password = process.env.ADMIN_TOKEN;
if (!password) throw new Error("ADMIN_TOKEN is required for login verification");
const pages = ["/admin", "/admin/cards", "/admin/cards/library", "/admin/cards/batch", "/admin/hifupay/cards", "/admin/zzshu", "/admin/pro-orders", "/admin/recoveries", "/admin/provider"];
const call = (url, options = {}) => fetch(base + url, { ...options, signal: AbortSignal.timeout(20000) });
let cookie, csrf;
try {
  for (const page of pages) {
    const response = await call(page, { redirect: "manual" });
    assert.equal(response.status, 303, `${page} must require login`);
    assert.match(response.headers.get("location"), /^\/admin\/login\?next=/);
  }
  const loginPage = await call("/admin/login");
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /记住此设备 7 天/);
  const script = await call("/admin/session.js");
  assert.equal(script.status, 200);
  assert.match(await script.text(), /localStorage.removeItem/);
  assert.equal((await call("/api/admin/hifupay/cards")).status, 401);
  const login = await call("/api/admin/login", {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base, "X-Admin-Request": "1" },
    body: JSON.stringify({ password })
  });
  assert.equal(login.status, 200, "Session login must succeed");
  const setCookie = login.headers.get("set-cookie") || "";
  // Never include the cookie in assertion output.
  assert.ok(setCookie.includes("HttpOnly") && setCookie.includes("Secure") && setCookie.includes("SameSite=Strict"), "Secure session cookie attributes missing");
  cookie = setCookie.split(";")[0];
  csrf = (await login.json()).data.csrf;
  for (const page of pages) {
    let response = await call(page, { headers: { Cookie: cookie }, redirect: "manual" });
    if (page === "/admin/zzshu") {
      assert.equal(response.status, 303, "/admin/zzshu must redirect to the unified payment-card page");
      assert.equal(response.headers.get("location"), "/admin/hifupay/cards#importPanel");
      response = await call(response.headers.get("location"), { headers: { Cookie: cookie }, redirect: "manual" });
    }
    assert.equal(response.status, 200, `${page} must accept the shared session`);
    const html = await response.text();
    if (["/admin","/admin/hifupay/cards"].includes(page)) {
      assert.ok(html.includes("<th>来源渠道</th>") && html.includes('/admin/cards/payment-card-source-ui.js') && html.includes('请选择卡片来源'), "Payment card origin UI missing");
      assert.ok(html.includes('id="importFormatter"') && html.includes('/admin/cards/payment-card-formatter.js'), "Payment card format output missing");
    }
    if(page==="/admin/cards")assert.ok(["stockStats","inventoryRows","generateDialog"].every(id=>html.includes('id="'+id+'"')),"Inventory-first card management page missing");
    const hasChannelCredentialInputs = page === "/admin" && html.includes('id="hifupayKey" type="password"') && html.includes('id="zzshuKey" type="password"') && html.includes('/admin/cards/workbench-settings.js');
    assert.ok(html.includes('/admin/session.js') && (!html.includes('type="password"') || hasChannelCredentialInputs), `${page} still contains legacy authentication`);
  }
  for (const asset of ["workbench.js","workbench-settings.js","payment-card-source-ui.js","payment-card-formatter.js","payment-card-input.js","card-inventory.js","card-download-names.js"]) {
    const response = await call("/admin/cards/" + asset, {headers:{Cookie:cookie}});
    assert.equal(response.status,200,"Workbench asset must be available behind the shared session");
    assert.match(response.headers.get("content-type") || "", /javascript/);
    if(asset==="workbench.js")assert.ok((await response.text()).includes("card-copy-standard"),"Home stored-card copy button missing");
  }
  const home = await call("/admin", {headers:{Cookie:cookie}}).then(response=>response.text());
  assert.ok(["正在使用的支付卡","客户卡密库存","最近充值订单","录入支付卡"].every(text=>home.includes(text)),"Production workbench panels missing");
  for (const page of ['/admin','/admin/cards','/admin/cards/generate','/admin/cards/library']) {
    const html=await call(page,{headers:{Cookie:cookie}}).then(response=>response.text());
    assert.ok(html.includes('/admin/cards/card-download-names.js'),'Shared download naming missing on '+page);
  }
  const snapshotResponse = await call("/api/admin/workbench", {headers:{Cookie:cookie}});
  assert.equal(snapshotResponse.status,200,"Production workbench snapshot unavailable");
  const snapshot = (await snapshotResponse.json()).data;
  assert.ok(snapshot && Array.isArray(snapshot.cards) && snapshot.cards.every(card=>card.enabled),"Workbench must show only active cards");
  assert.ok(snapshot.orders.items.length <= 10 && snapshot.vouchers.items.length <= 20,"Workbench recent windows exceed their limits");
  assert.ok(snapshot.attention && snapshot.attention.items.length <= 5 && snapshot.attention.total === snapshot.summary.attentionOrders,"Home attention summary missing or truncated totals");
  const stockResponse=await call("/api/admin/workbench?voucherStatus=stock",{headers:{Cookie:cookie}});
  assert.equal(stockResponse.status,200);
  const homeStock=(await stockResponse.json()).data;
  assert.ok(homeStock.vouchers.items.every(card=>card.operationalStatus==='unused'&&!card.hasSubmission&&!card.boundEmail&&!card.boundAccountId),"Home unused stock includes bound/submitted cards");
  assert.ok(snapshot.historyHandling && snapshot.historyHandling.cutoff === '2026-10-13T16:00:00.000Z',"Owner-confirmed history handling migration missing");
  assert.ok([...snapshot.orders.items,...snapshot.attention.items].every(order=>!order.workbenchHandledAt && (!Number.isFinite(Date.parse(order.createdAt)) || Date.parse(order.createdAt)>=Date.parse(snapshot.historyHandling.cutoff))),"Handled historical order still visible on home");
  console.log('Owner-confirmed historical order handling verified:',snapshot.historyHandling.count);
  assert.ok(['auto','manual'].includes(snapshot.plusFulfillmentMode),'Plus fulfillment mode missing');
  assert.ok(home.includes('plus-mode-manual')&&home.includes('plus-mode-auto'),'Plus mode controls missing');
  const manualCardsResponse=await call('/api/admin/plus/manual-cards',{headers:{Cookie:cookie}});
  assert.equal(manualCardsResponse.status,200,'Optional manual payment cards unavailable');
  assert.ok(Array.isArray((await manualCardsResponse.json()).data.cards),'Optional card list malformed');
  console.log('Plus fulfillment controls and optional-card read verified without switching production mode.');
  const poolPage=await call("/admin/hifupay/cards",{headers:{Cookie:cookie}}).then(response=>response.text());
  assert.ok(poolPage.includes('data-action="copy-standard"') && poolPage.includes("复制标准格式"),"Full pool stored-card copy button missing");
  const copyMissing=await call("/api/admin/payment-cards/manual/GPTC-COPY-SMOKE-NOT-A-CARD/copy-standard", {
    method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie,Origin:base,"X-CSRF-Token":csrf},body:"{}"
  });
  assert.equal(copyMissing.status,404,"Stored-card copy route must reject unknown cards");
  assert.equal((await copyMissing.json()).message,"支付卡不存在或已移出卡池。","Stored-card copy handler unavailable");
  assert.equal(copyMissing.headers.get("cache-control"),"no-store","Stored-card copy response must not be cached");
  console.log("Stored-card copy buttons and protected route verified without reading real card credentials.");
  const inventoryResponse=await call("/api/admin/card-inventory",{headers:{Cookie:cookie}});
  assert.equal(inventoryResponse.status,200,"Card inventory snapshot unavailable");
  assert.equal(inventoryResponse.headers.get("cache-control"),"no-store");
  const inventory=(await inventoryResponse.json()).data;
  assert.ok(inventory?.view==="unused" && inventory.items.length<=20 && inventory.items.every(card=>card.group==="unused" && !card.hasSubmission && !card.boundEmail && !card.boundAccountId && !card.archivedAt),"Default inventory contains non-distributable cards");
  assert.equal(Object.values(inventory.stock).reduce((sum,count)=>sum+count,0),inventory.matched,"Stock counts disagree with default inventory");
  console.log("Inventory-first entry, generation drawer, protected asset and unused-only snapshot verified without card mutations.");
  const poolResponse=await call("/api/admin/zzshu/cards",{headers:{Cookie:cookie}});
  assert.equal(poolResponse.status,200,"Full payment pool unavailable");
  const pool=(await poolResponse.json()).data;
  assert.ok(Array.isArray(pool),"Full payment pool response invalid");
  const manualPool=new Map(pool.filter(card=>card.credentialSource==="manual").map(card=>[card.id,card]));
  assert.ok(snapshot.cards.filter(card=>card.kind==="manual").every(card=>manualPool.get(card.id)?.sourceLabel===card.sourceLabel),"Channel labels differ between home and full pool");
  assert.ok(pool.filter(card=>card.credentialSource==="manual" && ["","手动导入","未分类","未标注"].includes(String(card.source||"").trim()) && ["天空","天空卡台"].includes(String(card.note||"").trim())).every(card=>card.sourceLabel==="天空"),"Legacy Sky notes are not shown as Sky origin");
  console.log("Origin selectors and legacy Sky labels match across home and full payment pool.");
  // Synthetic fixture only. Preview does not import credentials or spend card uses.
  const previewResponse = await call("/api/admin/zzshu/preview", {
    method:"POST", headers:{"Content-Type":"application/json",Cookie:cookie,Origin:base,"X-CSRF-Token":csrf},
    body:JSON.stringify({text:"卡号:4242424242424242;CVV321;有效期:12/40"})
  });
  assert.equal(previewResponse.status,200,"Sky preview endpoint unavailable");
  const preview=(await previewResponse.json()).data;
  assert.ok(preview?.length===1 && ["ready","duplicate","restore","pending"].includes(preview[0].status),"Sky format preview failed");
  assert.ok(!JSON.stringify(preview).includes("4242424242424242") && !JSON.stringify(preview).includes("321"),"Payment preview leaked credentials");
  const dashResponse=await call("/api/admin/zzshu/preview", {
    method:"POST",headers:{"Content-Type":"application/json",Cookie:cookie,Origin:base,"X-CSRF-Token":csrf},
    body:JSON.stringify({text:"4242424242424242----12/40----096----"})
  });
  assert.equal(dashResponse.status,200,"ZZS four-hyphen preview unavailable");
  const dashPreview=(await dashResponse.json()).data;
  assert.ok(dashPreview?.length===1 && ["ready","duplicate","restore","pending"].includes(dashPreview[0].status),"ZZS four-hyphen format rejected");
  assert.ok(!JSON.stringify(dashPreview).includes("4242424242424242") && !JSON.stringify(dashPreview).includes("096"),"Four-hyphen preview leaked credentials");
  console.log("Payment format output panels, shared parser and four-hyphen masked preview verified.");
  console.log("Payment card origin columns and Sky format masked preview verified without importing cards.");
  console.log("Production workbench panels, assets and bounded snapshot verified without business mutations.");
  console.log("Admin login, shared session, protected pages and secure cookie verified.");
} finally {
  if (cookie && csrf) {
    const response = await call("/api/admin/logout", { method: "POST", headers: { Cookie: cookie, Origin: base, "X-CSRF-Token": csrf } });
    assert.equal(response.status, 200, "Verification session logout failed");
    assert.equal((await call("/api/admin/session", { headers: { Cookie: cookie } })).status, 401, "Revoked session still accepted");
    console.log("Verification session revoked.");
  }
}
