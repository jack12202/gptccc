import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("assigned Hifupay card feeds Zzshu direct just-in-time; no sensitive persistence or double count", async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"zzshu-bridge-"));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  process.env.DATA_FILE=path.join(dir,"orders.json");
  process.env.ZZSHU_DB_FILE=path.join(dir,"zzshu.sqlite");
  process.env.HIFUPAY_API_KEY="fixture-hifupay-key";
  process.env.ZZSHU_API_KEY="fixture-zzshu-key";
  process.env.ZZSHU_ENABLED="true";
  process.env.RECOVERY_ENCRYPTION_KEY="fixture-encryption-key";
  const {config}=await import("../src/config.js");
  config.hifupayBaseUrl="https://hifupay.example.test";
  config.zzshuBaseUrl="https://zzshu.example.test";
  const {JsonStore}=await import("../src/store.js");
  const {zzshuService}=await import("../src/zzshu-service.js");
  const h=new JsonStore(process.env.DATA_FILE);
  h.syncHifupayCards([1,2,3,4].map(n=>({id:`card-${n}`,lastFour:n===3?"4242":`900${n}`,status:"active",balance:n===4?1:40})));
  assert.equal(zzshuService.assignHifupayCard("card-3","zzshu").ok,true);
  assert.equal(zzshuService.assignHifupayCard("card-4","zzshu").ok,true);
  const voucher=zzshuService.createVouchers({count:1,source:"fixture"})[0];
  const pan="4242424242424242", cvv="123";
  let createCount=0;
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async (url,options)=>{
    const endpoint=new URL(url).pathname;
    if (endpoint==="/api/hfp/login") return {ok:true,status:200,text:async()=>JSON.stringify({success:true,apiKey:"fixture-h-session"})};
    if (endpoint==="/api/hfp/cards") return {ok:true,status:200,text:async()=>JSON.stringify({success:true,cards:[
      {id:"card-3",lastFour:"4242",status:"active",balance:40,cardNo:pan,cvv},
      {id:"card-4",lastFour:"9004",status:"active",balance:1,cardNo:"4111111111119004",cvv:"999"}
    ]})};
    if (endpoint==="/api/hfp/card-sensitive") {
      assert.equal(JSON.parse(options.body).cardId,"card-3");
      return {ok:true,status:200,json:async()=>({success:true,data:{fullCardNo:pan,expiryDate:"12/40",cvv}})};
    }
    if (endpoint==="/api/v1/third-party/orders/direct") {
      createCount++;
      const request=JSON.parse(options.body);
      assert.equal(request.cardNumber,pan);assert.equal(request.cvv,cvv);
      assert.equal(request.planType,"plus");
      return {ok:true,status:201,json:async()=>({code:0,data:{order_no:"upstream-1",card_key:"DIRECT-fixture"}})};
    }
    if (endpoint==="/api/v1/third-party/orders/status") return {ok:true,status:200,json:async()=>({code:0,data:{
      order_no:"upstream-1",card_key:"DIRECT-fixture",plan_type:"plus",status:"success",is_subscription_cancelled:1,
      payment_result:{success:true,status:"paid"},bank_card_no:pan,token:{sessionToken:"must-not-leak"}
    }})};
    throw Error(`Unexpected mock endpoint ${endpoint}`);
  };
  t.after(()=>{globalThis.fetch=oldFetch});
  const session={user:{id:"u-fixture",email:"fixture@example.test"},account:{id:"a-fixture",planType:"free"},
    accessToken:"fixture.jwt.token",sessionToken:"fixture-session",expires:"2040-01-01T00:00:00Z"};
  const submitted=await zzshuService.confirm({provider:"zzshu",cardInfo:voucher.code,secretJsonText:JSON.stringify(session)});
  assert.equal(submitted.ok,true);assert.equal(submitted.data.status,"processing");assert.equal(createCount,1);
  const orderId=submitted.data.orderId;
  const repeated=await zzshuService.confirm({provider:"zzshu",cardInfo:voucher.code,secretJsonText:JSON.stringify(session)});
  assert.equal(repeated.data.orderId,orderId);assert.equal(createCount,1);
  const finished=await zzshuService.refresh(orderId);
  assert.equal(finished.data.status,"success");assert.equal(finished.data.subscriptionCancellationStatus,"cancelled");
  await zzshuService.refresh(orderId);
  assert.equal(zzshuService.store.listCards().find(c=>c.lastFour==="4242").successCount,1);
  assert.equal(zzshuService.store.voucher(voucher.code).status,"used");
  const visible=JSON.stringify({submitted:submitted.data,finished:finished.data,cards:zzshuService.store.listCards()});
  for (const secret of [pan,"must-not-leak","fixture-h-session"]) assert.equal(visible.includes(secret),false);
  const persisted=fs.readFileSync(process.env.ZZSHU_DB_FILE);
  for (const secret of [pan,"must-not-leak"]) assert.equal(persisted.includes(Buffer.from(secret)),false);
});
