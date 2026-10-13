import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import {buildCardInventory,inventoryCard} from "../src/customer-card-inventory.js";

const now=new Date("2026-10-13T00:00:00Z");
const card=(id,extra={})=>({id,code:"FIXTURE-"+id,status:"unused",source:"微信",plan:"plus",createdAt:"2026-10-12T20:00:00Z",...extra});
test("inventory never classifies bound, submitted, processing, expired or used vouchers as reusable stock",()=>{
  const cases=[
    [{boundEmail:"bound@example.test"},"attention"],
    [{boundAccountId:"bound-account"},"attention"],
    [{hasSubmission:true},"attention"],
    [{orderId:"old-order"},"attention"],
    [{status:"locked"},"attention"],
    [{status:"used"},"used"],
    [{status:"disabled"},"other"],
    [{expiresAt:"2020-01-01"},"other"],
    [{expiresAt:"invalid"},"other"],
    [{plan:"obsolete"},"other"],
    [{archivedAt:"2026-01-01"},"archived"],
    [{code:""},"other"]
  ];
  for(const [extra,group]of cases)assert.equal(inventoryCard(card("a",extra),[],now).group,group);
  assert.equal(inventoryCard(card("a"),[{id:"o",status:"failed",retryAllowed:true,userEmail:"old@example.test"}],now).group,"attention");
  assert.match(inventoryCard(card("a"),[{id:"o",status:"failed",hifupaySafetyStatus:"released_unpaid",userEmail:"old@example.test"}],now).statusLabel,/原账号可重试/);
  assert.equal(inventoryCard(card("a"),[{id:"o",status:"success"}],now).group,"used");
  assert.equal(inventoryCard(card("a"),[],now).group,"unused");
  assert.match(inventoryCard(card("a",{boundEmail:"bound@example.test",expiresAt:"2020-01-01"}),[],now).statusLabel,/已过期/);
});

test("inventory counts, full searches, batches and Shanghai date filters work beyond the first page",()=>{
  const cards=Array.from({length:65},(_,i)=>card(String(i),{plan:i<60?"plus":"pro_x20",sequence:i+1,batchId:"batch",batchSize:65}));
  cards.push(card("bound",{hasSubmission:true}),card("used",{status:"used"}),card("archive",{archivedAt:"2026-01-01"}));
  const first=buildCardInventory(cards,[],{},now);
  assert.equal(first.view,"unused");assert.equal(first.items.length,20);assert.equal(first.matched,65);
  assert.deepEqual(first.stock,{plus:60,pro_x5:0,pro_x20:5});
  assert.equal(first.counts.attention,1);assert.equal(first.counts.used,1);assert.equal(first.counts.archived,1);
  assert.equal(buildCardInventory(cards,[],{search:"FIXTURE-64"},now).items[0].id,"64");
  assert.equal(buildCardInventory(cards,[],{plan:"pro_x20"},now).matched,5);
  assert.equal(buildCardInventory(cards,[],{date:"2026-10-13"},now).matched,65);
  assert.equal(buildCardInventory(cards,[],{date:"2026-10-12"},now).matched,0);
  assert.equal(buildCardInventory(cards,[],{page:999},now).items.length,5);
  assert.equal(buildCardInventory(cards,[],{size:10000},now).pageSize,100);
  assert.equal(buildCardInventory(cards,[],{view:"all"},now).matched,67);
  assert.equal(buildCardInventory(cards,[],{view:"archived"},now).items[0].id,"archive");
  assert.equal(buildCardInventory(cards,[],{search:"https://www.gptc.cc/activate/?provider=h&card=FIXTURE-64"},now).matched,1);
  assert.deepEqual(buildCardInventory(cards,[],{ids:"0,64",size:100},now).items.map(card=>card.id),["0","64"]);
  assert.equal(buildCardInventory(cards,[],{ids:"bound,64"},now).matched,1);
});

test("newest stock comes first and a generation batch keeps its original sequence",()=>{
  const cards=[card("old",{createdAt:"2020-01-01"}),card("new2",{createdAt:"2026-10-13",batchId:"new",sequence:2}),card("new1",{createdAt:"2026-10-13",batchId:"new",sequence:1})];
  assert.deepEqual(buildCardInventory(cards,[],{},now).items.map(card=>card.id),["new1","new2","old"]);
});

test("inventory entry and snapshot require login; generation enters unused inventory while bindings stay separate",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gptc-inventory-"));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  process.env.ADMIN_TOKEN="inventory-fixture";process.env.DATA_FILE=path.join(dir,"orders.json");
  process.env.ZZSHU_DB_FILE=path.join(dir,"usage.sqlite");process.env.RECOVERY_ENCRYPTION_KEY="inventory-fixture-key";
  const {server}=await import("../src/server.js"),{rechargeService:r}=await import("../src/recharge-service.js"),{JsonStore}=await import("../src/store.js");
  const store=new JsonStore(process.env.DATA_FILE),cards=r.createHCards({count:30,source:"微信"}).data.cards;
  r.createHCards({count:5,source:"代理",plan:"pro_x5"});r.createHCards({count:5,source:"代理",plan:"pro_x20"});
  store.updateHCard(cards[0].id,{hasSubmission:true,boundEmail:"bound@example.test"});
  store.updateHCard(cards[1].id,{status:"disabled",disabledAt:"2026-10-13T00:00:00Z"});
  store.updateHCard(cards[2].id,{status:"used",hasSubmission:true});
  store.updateHCard(cards[3].id,{archivedAt:"2026-10-13T00:00:00Z",hasSubmission:true});
  store.updateHCard(cards[4].id,{expiresAt:"2020-01-01T00:00:00Z"});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base="http://127.0.0.1:"+server.address().port;
  assert.equal((await fetch(base+"/api/admin/card-inventory")).status,401);
  for(const suffix of ["/admin/cards","/admin/cards/card-inventory.js","/admin/cards/generate"])assert.equal((await fetch(base+suffix,{redirect:"manual"})).status,303);
  const login=await fetch(base+"/api/admin/login",{method:"POST",headers:{Origin:"https://www.gptc.cc","X-Admin-Request":"1","Content-Type":"application/json"},body:JSON.stringify({password:"inventory-fixture"})});
  const cookie=login.headers.get("set-cookie").split(";")[0],csrf=(await login.json()).data.csrf;
  const headers={Cookie:cookie,Origin:"https://www.gptc.cc","X-CSRF-Token":csrf,"Content-Type":"application/json"};
  const get=suffix=>fetch(base+suffix,{headers:{Cookie:cookie}});
  const snapshot=async query=>(await (await get("/api/admin/card-inventory"+(query?"?"+query:""))).json()).data;
  const html=await (await get("/admin/cards")).text();assert.match(html,/可发放库存/);assert.match(html,/id="generateDialog"/);assert.match(html,/id="openGeneratedBatch"/);
  assert.ok(html.indexOf('id="inventoryRows"')<html.indexOf('id="generateDialog"'));
  new vm.Script(await (await get("/admin/cards/card-inventory.js")).text());
  const before=await snapshot();assert.equal(before.view,"unused");assert.equal(before.matched,35);assert.equal(before.items.length,20);
  assert.deepEqual(before.stock,{plus:25,pro_x5:5,pro_x20:5});
  assert.equal((await snapshot("view=attention")).items[0].id,cards[0].id);
  const generated=await fetch(base+"/api/admin/h-cards",{method:"POST",headers,body:JSON.stringify({count:3,plan:"plus",source:"卡网",productId:3})});
  assert.equal(generated.status,200);const batch=(await generated.json()).data.cards;
  const after=await snapshot("batch="+batch[0].batchId);assert.equal(after.matched,3);
  assert.deepEqual(after.items.map(card=>card.sequence),[1,2,3]);
  assert.equal((await snapshot()).stock.plus,28);
  // A voucher bound after selection disappears from the resale inventory.
  store.updateHCard(batch[0].id,{hasSubmission:true,boundAccountId:"new-customer",boundEmail:"new@example.test"});
  assert.equal((await snapshot("batch="+batch[0].batchId)).matched,2);
  assert.equal((await snapshot("view=attention&search="+batch[0].code)).items[0].id,batch[0].id);
});
