import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("four Hifupay cards partition into H and Zzshu without copy or cross-channel selection", async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"zzshu-roles-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  process.env.DATA_FILE=path.join(dir,"orders.json");
  process.env.ZZSHU_DB_FILE=path.join(dir,"zzshu.sqlite");
  const {JsonStore}=await import("../src/store.js");
  const {ZzshuStore}=await import("../src/zzshu-store.js");
  const h=new JsonStore(process.env.DATA_FILE), z=new ZzshuStore(process.env.ZZSHU_DB_FILE);
  h.syncHifupayCards([1,2,3,4].map(n=>({id:`card-${n}`,lastFour:`900${n}`,status:"active",balance:40})));
  assert.equal(z.assignHifupay({id:"card-3",lastFour:"9003"},"zzshu").ok,true);
  assert.equal(z.assignHifupay({id:"card-4",lastFour:"9004"},"zzshu").ok,true);
  assert.deepEqual([1,2,3,4].map(n=>z.role(`card-${n}`).role),["h","h","zzshu","zzshu"]);
  const vouchers=z.createVouchers(3,"fixture",3,()=>"fixture-cipher");
  const allowed=new Set(["card-3","card-4"]);
  const first=z.reserve(vouchers[0].code,"a@example.test","a",allowed);
  const second=z.reserve(vouchers[1].code,"b@example.test","b",allowed);
  assert.equal(first.ok,true); assert.equal(second.ok,true);
  assert.deepEqual(new Set([first.credentialRef,second.credentialRef]),new Set(["hifupay:card-3","hifupay:card-4"]));
  assert.equal(z.reserve(vouchers[2].code,"c@example.test","c",allowed).ok,false);
  assert.equal(z.assignHifupay({id:"card-3",lastFour:"9003"},"h").ok,false);
  assert.equal(z.claimH("card-3","h-order"),false);
  const hReservation=h.reserveHifupayCard({orderId:"h-order",plan:"plus",identity:{email:"h@example.test"},estimatedChargeUsd:16});
  assert.equal(hReservation.ok,true);
  assert.ok(["card-1","card-2"].includes(hReservation.cardId));
  assert.equal(z.role(hReservation.cardId).hOrderId,"h-order");
  assert.equal(z.assignHifupay({id:hReservation.cardId,lastFour:hReservation.lastFour},"zzshu").ok,false);
  h.clearHifupayReservation(hReservation.cardId,"h-order");
  assert.equal(z.role(hReservation.cardId).hOrderId,null);
  const dbText=fs.readFileSync(process.env.ZZSHU_DB_FILE);
  assert.equal(dbText.includes(Buffer.from("4242424242424242")),false);
});

test("card-sensitive response is checked against selected card and never returned to admin", async () => {
  const {hifupayAdapter}=await import("../src/providers/hifupay-adapter.js");
  const {config}=await import("../src/config.js");
  const oldFetch=globalThis.fetch,oldUrl=config.hifupayBaseUrl,oldKey=config.hifupayApiKey;
  config.hifupayBaseUrl="https://example.test";config.hifupayApiKey="fixture-api-key";
  const pan="4242424242424242";
  globalThis.fetch=async (url,options)=> {
    if (String(url).endsWith("/api/hfp/login")) return {ok:true,status:200,text:async()=>JSON.stringify({success:true,apiKey:"fixture-session-key"})};
    assert.match(String(url),/\/api\/hfp\/card-sensitive$/);
    assert.equal(JSON.parse(options.body).cardId,"fixture-card");
    return {ok:true,status:200,json:async()=>({success:true,data:{fullCardNo:pan,expiryDate:"12/40",cvv:"123"}})};
  };
  try {
    const payment=await hifupayAdapter.getPaymentCard({cardId:"fixture-card",expectedLastFour:"4242"});
    assert.deepEqual(payment,{cardNumber:pan,expMonth:12,expYear:2040,cvv:"123"});
    await assert.rejects(()=>hifupayAdapter.getPaymentCard({cardId:"fixture-card",expectedLastFour:"9999"}),/不匹配/);
  } finally {globalThis.fetch=oldFetch;config.hifupayBaseUrl=oldUrl;config.hifupayApiKey=oldKey;}
});
