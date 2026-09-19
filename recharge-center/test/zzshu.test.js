import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZzshuStore } from "../src/zzshu-store.js";
import { parsePaymentCards, publicPreview } from "../src/zzshu-cards.js";
import { zzshuAdapter } from "../src/providers/zzshu-adapter.js";
import { config } from "../src/config.js";

const fakePan = "4242424242424242"; // Test fixture only; never a customer card.
test("strict comma import, expiry, batch duplicates and masked preview", () => {
  const rows = parsePaymentCards(`${fakePan},12/40,123\n${fakePan},12/40,123\n1111222233334444 12/40 123\n123456789012,01/20,123`, new Set(),new Date("2026-09-01"));
  assert.deepEqual(rows.map(r=>r.status),["ready","duplicate","error","error"]);
  assert.equal(JSON.stringify(publicPreview(rows)).includes(fakePan),false);
  assert.equal(JSON.stringify(publicPreview(rows)).includes("123"),false);
});

test("atomic reservation, provider-scoped vouchers, serial card, exactly-once success and restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"zzshu-test-"));
  try {
    const file = path.join(dir,"test.sqlite");
    const a = new ZzshuStore(file), b = new ZzshuStore(file);
    const row = parsePaymentCards(`${fakePan},12/40,123`)[0];
    assert.equal(a.addPaymentCard(row,{credentialRef:"test-ref",source:"fixture",note:"",enabled:true,maxSuccess:5}),true);
    assert.equal(b.addPaymentCard(row,{credentialRef:"test-ref-2",source:"fixture",note:"",enabled:true,maxSuccess:5}),false);
    const codes = a.createVouchers(7,"test",3,code=>`encrypted-${code.slice(-4)}`);
    const first = a.reserve(codes[0].code,"one@example.test","acc-one");
    assert.equal(first.ok,true);
    assert.equal(b.reserve(codes[0].code,"one@example.test","acc-one").orderId,first.orderId);
    assert.equal(b.reserve(codes[1].code,"two@example.test","acc-two").ok,false);
    a.created(first.orderId,"up-1","query-1");
    assert.equal(b.settle(first.orderId,"success","unconfirmed"),true);
    assert.equal(a.settle(first.orderId,"success","cancelled"),false);
    assert.equal(b.order(first.orderId).cancellation,"cancelled");
    for (let i=1;i<5;i++) {
      const r=b.reserve(codes[i].code,`u${i}@example.test`,`acc-${i}`);
      assert.equal(r.ok,true);
      a.settle(r.orderId,"success");
    }
    assert.equal(a.listCards()[0].successCount,5);
    assert.equal(a.reserve(codes[5].code,"last@example.test","last").ok,false);
    assert.equal(a.voucher(codes[5].code).status,"unused");
    assert.equal(a.voucher("HPLUS"+codes[0].code.slice(6)),undefined);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("unknown is held; manual resolution is audited and pauses repeated failed cards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"zzshu-test-"));
  try {
    const s = new ZzshuStore(path.join(dir,"test.sqlite"));
    s.addPaymentCard(parsePaymentCards(`${fakePan},12/40,123`)[0],{credentialRef:"ref",source:"test",note:"",enabled:true,maxSuccess:5});
    const vouchers=s.createVouchers(2,"test",3,()=>"cipher");
    const first=s.reserve(vouchers[0].code,"first@example.test","first");
    s.markSubmitting(first.orderId); s.review(first.orderId,"响应丢失");
    assert.equal(s.reserve(vouchers[1].code,"second@example.test","second").ok,false);
    assert.equal(s.manualResolve(first.orderId,"unpaid","checked payment ledger"),true);
    assert.equal(s.reserve(vouchers[1].code,"second@example.test","second").ok,true);
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM audit").get().n,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("restart turns interrupted reservations into review without resubmitting or releasing cards", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"zzshu-restart-"));
  try {
    const file = path.join(dir,"test.sqlite"), first = new ZzshuStore(file);
    first.addPaymentCard(parsePaymentCards(`${fakePan},12/40,123`)[0],
      {credentialRef:"fixture-ref",source:"fixture",note:"",enabled:true,maxSuccess:5});
    const codes = first.createVouchers(2,"fixture",3,()=>"cipher");
    const reservation = first.reserve(codes[0].code,"first@example.test","account-1");
    first.markSubmitting(reservation.orderId);
    first.db.prepare("UPDATE orders SET updated_at=? WHERE id=?").run("2020-01-01T00:00:00.000Z",reservation.orderId);
    const restarted = new ZzshuStore(file);
    assert.equal(restarted.recoverInterrupted(30000),1);
    assert.equal(restarted.order(reservation.orderId).status,"needs_review");
    assert.match(restarted.order(reservation.orderId).review_reason,/禁止自动重发/);
    assert.equal(restarted.reconciliationIds(10).includes(reservation.orderId),false);
    assert.equal(restarted.reserve(codes[1].code,"second@example.test","account-2").ok,false);
    assert.equal(restarted.voucher(codes[0].code).status,"reserved");
    assert.equal(restarted.recoverInterrupted(30000),0);
    assert.equal(restarted.db.prepare("SELECT count(*) AS n FROM audit WHERE action='interrupted_recovery'").get().n,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("upstream response allowlist omits PAN, Session and API key", async () => {
  const oldFetch=globalThis.fetch,oldEnabled=config.zzshuEnabled,oldKey=config.zzshuApiKey,oldUrl=config.zzshuBaseUrl;
  config.zzshuEnabled=true;config.zzshuApiKey="fake-key";config.zzshuBaseUrl="https://example.test";
  globalThis.fetch=async (_url,options)=> {
    assert.equal(options.headers["X-API-Key"],"fake-key");
    return {ok:true,status:200,json:async()=>({code:0,data:{order_no:"u1",card_key:"k1",plan_type:"plus",status:"success",
      payment_result:{success:true,status:"paid",bank_card_no:fakePan},bank_card_no:fakePan,
      token:{accessToken:"secret-token",sessionToken:"secret-session"},is_subscription_cancelled:0}})};
  };
  try {
    const result=await zzshuAdapter.status("k1");
    assert.equal(result.data.paid,true);
    for (const sensitive of [fakePan,"secret-token","secret-session","fake-key"]) assert.equal(JSON.stringify(result.data).includes(sensitive),false);
  } finally {globalThis.fetch=oldFetch;config.zzshuEnabled=oldEnabled;config.zzshuApiKey=oldKey;config.zzshuBaseUrl=oldUrl;}
});

test("direct create is Plus-only and sends the full Session without region rotation", async () => {
  const oldFetch=globalThis.fetch,oldEnabled=config.zzshuEnabled,oldKey=config.zzshuApiKey,oldUrl=config.zzshuBaseUrl;
  config.zzshuEnabled=true;config.zzshuApiKey="fixture-key";config.zzshuBaseUrl="https://example.test";
  const token={user:{id:"user-fixture",email:"user@example.test"},account:{id:"acc",planType:"free"},
    accessToken:"fake.jwt.payload",sessionToken:"fake.session",expires:"2040-01-01"};
  globalThis.fetch=async (url,options)=> {
    assert.match(String(url),/\/api\/v1\/third-party\/orders\/direct$/);
    const body=JSON.parse(options.body);
    assert.equal(body.orderType,"direct"); assert.equal(body.planType,"plus");
    assert.deepEqual(body.token,token); assert.equal("region" in body,false);
    return {ok:true,status:201,json:async()=>({code:0,data:{order_no:"n1",card_key:"DIRECT-fixture"}})};
  };
  try {
    const result=await zzshuAdapter.create({token,payment:{cardNumber:fakePan,expMonth:12,expYear:2040,cvv:"123"}});
    assert.equal(result.ok,true);
  } finally {globalThis.fetch=oldFetch;config.zzshuEnabled=oldEnabled;config.zzshuApiKey=oldKey;config.zzshuBaseUrl=oldUrl;}
});
