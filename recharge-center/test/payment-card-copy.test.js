import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("stored card copy is authenticated, CSRF protected, uncached and leaves business state unchanged",async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),"gptc-card-copy-"));
  process.env.ADMIN_TOKEN="copy-fixture-password";
  process.env.DATA_FILE=path.join(dir,"orders.json");process.env.ZZSHU_DB_FILE=path.join(dir,"usage.sqlite");
  process.env.RECOVERY_ENCRYPTION_KEY="copy-fixture-key";
  const {server}=await import("../src/server.js");
  const {zzshuService:z}=await import("../src/zzshu-service.js");
  const {JsonStore}=await import("../src/store.js");
  const {hifupayAdapter}=await import("../src/providers/hifupay-adapter.js");
  const {encryptSecretText}=await import("../src/utils.js");
  const original=hifupayAdapter.getPaymentCard;
  t.after(()=>{hifupayAdapter.getPaymentCard=original;fs.rmSync(dir,{recursive:true,force:true});});
  await z.importCards({text:"4242424242424242,12/40,096",source:"ZZS",maxSuccess:4});
  const card=z.store.listCards()[0],before=JSON.stringify(z.store.listCards());
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base="http://127.0.0.1:"+server.address().port,url="/api/admin/payment-cards/manual/"+card.id+"/copy-standard";
  const login=await fetch(base+"/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json",Origin:"https://www.gptc.cc","X-Admin-Request":"1"},body:JSON.stringify({password:"copy-fixture-password"})});
  const cookie=login.headers.get("set-cookie").split(";")[0],csrf=(await login.json()).data.csrf;
  const headers={"Content-Type":"application/json",Cookie:cookie,Origin:"https://www.gptc.cc","X-CSRF-Token":csrf};
  const post=(suffix,extra={})=>fetch(base+suffix,{method:"POST",headers,body:"{}",...extra});
  assert.equal((await post(url,{headers:{"Content-Type":"application/json"}})).status,401);
  assert.equal((await post(url,{headers:{...headers,"X-CSRF-Token":""}})).status,403);
  assert.equal((await post(url,{headers:{...headers,Origin:"https://example.test"}})).status,403);
  const copied=await post(url);assert.equal(copied.status,200);
  assert.equal(copied.headers.get("cache-control"),"no-store");
  assert.deepEqual((await copied.json()).data,{text:"4242424242424242----12/40----096----",lastFour:"4242"});
  assert.equal(JSON.stringify(z.store.listCards()),before);
  assert.equal(z.store.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,0);
  const audit=z.store.db.prepare("SELECT * FROM audit WHERE action='card_standard_format_read'").all();
  assert.equal(audit.length,1);
  assert.equal(JSON.stringify(audit).includes("4242424242424242"),false);
  assert.deepEqual(Object.keys(JSON.parse(audit[0].reason)),["operator"]);
  for(const suffix of ["/api/admin/zzshu/cards","/api/admin/workbench"]){
    const response=await fetch(base+suffix,{headers:{Cookie:cookie}});
    const text=await response.text();assert.equal(text.includes("4242424242424242"),false);
    assert.equal(text.includes("paymentCipher"),false);
  }
  assert.equal((await post("/api/admin/payment-cards/manual/not-found/copy-standard")).status,404);
  // A credential belonging to another PAN must never be returned for this row.
  const wrong=encryptSecretText(JSON.stringify({cardNumber:"4000000000000002",expMonth:12,expYear:2040,cvv:"321"}),"copy-fixture-key","zzshu-payment-card");
  z.store.db.prepare("UPDATE payment_cards SET payment_cipher=? WHERE id=?").run(wrong,card.id);
  const mismatched=await post(url);assert.equal(mismatched.status,503);
  assert.equal((await mismatched.text()).includes("4000000000000002"),false);
  z.store.db.prepare("UPDATE payment_cards SET payment_cipher='broken' WHERE id=?").run(card.id);
  assert.equal((await post(url)).status,503);
  assert.equal(z.store.retireManualCard(card.id).ok,true);
  assert.equal((await post(url)).status,404);
  // Sync cards use read-only sensitive detail lookup, with the same local-tail verification.
  const json=new JsonStore(process.env.DATA_FILE);
  json.syncHifupayCards([{id:"copy-h",lastFour:"0002",status:"active",balance:40}]);
  const beforeH=JSON.stringify(json.listHifupayCards());
  let detailReads=0;
  hifupayAdapter.getPaymentCard=async args=>{
    assert.deepEqual(args,{cardId:"copy-h",expectedLastFour:"0002"});detailReads++;
    return {cardNumber:"4000000000000002",expMonth:10,expYear:2030,cvv:"007"};
  };
  const hCopy=await post("/api/admin/payment-cards/h/copy-h/copy-standard");
  assert.equal(hCopy.status,200);
  assert.equal((await hCopy.json()).data.text,"4000000000000002----10/30----007----");
  assert.equal(detailReads,1);assert.equal(JSON.stringify(json.listHifupayCards()),beforeH);
  assert.equal(z.store.db.prepare("SELECT COUNT(*) AS n FROM orders").get().n,0);
});
