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
    assert.equal(a.confirmCancellation(first.orderId,"checked upstream cancellation"),false);
    for (let i=1;i<5;i++) {
      const r=b.reserve(codes[i].code,i === 1 ? "two@example.test" : `u${i}@example.test`,i === 1 ? "acc-two" : `acc-${i}`);
      assert.equal(r.ok,true);
      a.settle(r.orderId,"success");
    }
    assert.equal(a.listCards()[0].successCount,5);
    assert.equal(a.listCards()[0].successfulAccounts.length,5);
    assert.equal(a.listCards()[0].successfulAccounts.filter(item => item.orderId === first.orderId).length,1);
    assert.equal(a.listCards()[0].successfulAccounts.find(item => item.orderId === first.orderId).email,"one@example.test");
    assert.equal(new ZzshuStore(file).listCards()[0].successfulAccounts.length,5);
    assert.equal(a.reserve(codes[5].code,"last@example.test","last").ok,false);
    assert.equal(a.voucher(codes[5].code).status,"unused");
    assert.equal(a.voucher("HPLUS"+codes[0].code.slice(6)),undefined);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("manual renewal closure needs evidence and does not spend the card again", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-cancel-"));
  try {
    const s = new ZzshuStore(path.join(dir, "test.sqlite"));
    s.addPaymentCard(parsePaymentCards(`${fakePan},12/40,123`)[0],
      { credentialRef: "fixture-ref", source: "fixture", note: "", enabled: true, maxSuccess: 2 });
    const [voucher] = s.createVouchers(1, "fixture", 3, () => "cipher");
    const order = s.reserve(voucher.code, "fixture@example.test", "account-1");
    assert.equal(s.settle(order.orderId, "success", "unconfirmed"), true);
    assert.equal(s.confirmCancellation(order.orderId, "short"), false);
    assert.equal(s.confirmCancellation(order.orderId, "checked upstream cancellation"), true);
    assert.equal(s.confirmCancellation(order.orderId, "checked upstream cancellation"), false);
    assert.equal(s.order(order.orderId).cancellation, "cancelled");
    assert.equal(s.listCards()[0].successCount, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ZZS order keeps its encrypted Session reference across restart without exposing it in lists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"zzshu-session-"));
  try {
    const file = path.join(dir,"test.sqlite"), first = new ZzshuStore(file);
    first.addPaymentCard(parsePaymentCards(`${fakePan},12/40,123`)[0],
      {credentialRef:"fixture-ref",source:"fixture",note:"",enabled:true,maxSuccess:1});
    const [voucher] = first.createVouchers(1,"fixture",3,()=>"voucher-cipher");
    const reservation = first.reserve(voucher.code,"user@example.test","account-1",null,true,"session-cipher");
    assert.equal(reservation.ok,true);
    assert.equal(first.sessionCipher(reservation.orderId),"session-cipher");
    assert.equal(JSON.stringify(first.listOrders()).includes("session-cipher"),false);
    const restarted = new ZzshuStore(file);
    assert.equal(restarted.sessionCipher(reservation.orderId),"session-cipher");
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("retiring a manual payment card removes its credentials without losing order history or duplicate protection", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-retire-"));
  try {
    const file = path.join(dir, "test.sqlite"), s = new ZzshuStore(file);
    const row = parsePaymentCards(`${fakePan},12/40,123`)[0];
    s.addPaymentCard(row, { credentialRef: "local:fixture", paymentCipher: "encrypted-fixture-payment", source: "fixture", note: "", enabled: true, maxSuccess: 2 });
    const cardId = s.listCards()[0].id;
    const vouchers = s.createVouchers(2, "fixture", 3, () => "cipher");
    const order = s.reserve(vouchers[0].code, "fixture@example.test", "account-1");
    assert.match(s.retireManualCard(cardId).reason, /未完成订单/);
    assert.equal(s.listCards().length, 1);
    assert.equal(s.settle(order.orderId, "success", "cancelled"), true);
    assert.equal(s.retireManualCard(cardId).ok, true);
    assert.equal(s.listCards().length, 0);
    assert.equal(s.paymentCipher("local:fixture"), "");
    assert.equal(s.db.prepare("SELECT payment_cipher AS cipher FROM payment_cards WHERE id=?").get(cardId).cipher, null);
    assert.equal(s.order(order.orderId).status, "success");
    assert.equal(s.db.prepare("SELECT success_count AS count FROM payment_cards WHERE id=?").get(cardId).count, 1);
    assert.equal(s.updateCard(cardId, { enabled: true }), false);
    assert.equal(s.addPaymentCard(row, { credentialRef: "local:new", source: "fixture", note: "", enabled: true, maxSuccess: 1 }), false);
    assert.equal(s.reserve(vouchers[1].code, "next@example.test", "account-2").ok, false);
    assert.equal(s.voucher(vouchers[1].code).status, "unused");
    assert.equal(new ZzshuStore(file).listCards().length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("ZZS retirement cannot remove a Hifupay sourced card", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-retire-h-"));
  try {
    const s = new ZzshuStore(path.join(dir, "test.sqlite"));
    assert.equal(s.assignHifupay({ id: "7172", lastFour: "4113" }, "zzshu").ok, true);
    const card = s.listCards().find(item => item.credentialSource === "hifupay");
    assert.match(s.retireManualCard(card.id).reason, /嗨付来源/);
    assert.equal(s.listCards().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("administrator history includes ZZS orders older than the first 500", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-history-"));
  try {
    const s = new ZzshuStore(path.join(dir, "test.sqlite"));
    s.addPaymentCard(parsePaymentCards(`${fakePan},12/40,123`)[0],
      { credentialRef: "fixture-ref", source: "fixture", note: "", enabled: true, maxSuccess: 1 });
    s.createVouchers(501, "fixture", 3, () => "cipher");
    const cardId = s.db.prepare("SELECT id FROM payment_cards LIMIT 1").get().id;
    const vouchers = s.db.prepare("SELECT id FROM vouchers").all();
    const insert = s.db.prepare("INSERT INTO orders(id,voucher_id,card_id,email,account_id,status,created_at,updated_at) VALUES(?,?,?,?,?,'failed',?,?)");
    vouchers.forEach((voucher, index) => insert.run(`history-${index}`, voucher.id, cardId, "fixture@example.test", `account-${index}`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z"));
    assert.equal(s.listOrders().length, 501);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("failed reconciliation attempts move behind other pending orders", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-reconcile-"));
  try {
    const s = new ZzshuStore(path.join(dir, "test.sqlite"));
    for (const pan of ["4242424242424242", "4000000000000002"]) {
      s.addPaymentCard(parsePaymentCards(`${pan},12/40,123`)[0],
        { credentialRef: `fixture-${pan.slice(-4)}`, source: "fixture", note: "", enabled: true, maxSuccess: 1 });
    }
    s.createVouchers(2, "fixture", 3, () => "cipher");
    const cards = s.db.prepare("SELECT id FROM payment_cards ORDER BY id").all();
    const vouchers = s.db.prepare("SELECT id FROM vouchers ORDER BY id").all();
    for (let index = 0; index < 2; index++) {
      s.db.prepare("INSERT INTO orders(id,voucher_id,card_id,email,account_id,status,upstream_order_no,upstream_card_key,created_at,updated_at) VALUES(?,?,?,?,?,'processing',?,?,?,?)")
        .run(`pending-${index}`, vouchers[index].id, cards[index].id, "fixture@example.test", `account-${index}`, `upstream-${index}`, `query-${index}`, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    }
    assert.deepEqual(s.reconciliationIds(1), ["pending-0"]);
    s.markChecked("pending-0", false);
    assert.deepEqual(s.reconciliationIds(1), ["pending-1"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("unknown result freezes one use while remaining card uses stay available", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"zzshu-test-"));
  try {
    const s = new ZzshuStore(path.join(dir,"test.sqlite"));
    s.addPaymentCard(parsePaymentCards(`${fakePan},12/40,123`)[0],{credentialRef:"ref",source:"test",note:"",enabled:true,maxSuccess:5});
    const vouchers=s.createVouchers(2,"test",3,()=>"cipher");
    const first=s.reserve(vouchers[0].code,"first@example.test","first");
    s.markSubmitting(first.orderId); s.review(first.orderId,"响应丢失");
    const second=s.reserve(vouchers[1].code,"second@example.test","second");
    assert.equal(second.ok,true);
    assert.equal(s.listCards()[0].frozenUses,1);
    assert.equal(s.manualResolve(first.orderId,"unpaid","checked payment ledger"),true);
    assert.equal(s.manualResolve(first.orderId,"unpaid","checked payment ledger"),false);
    assert.equal(s.order(first.orderId).status,"failed");
    assert.equal(s.voucher(vouchers[0].code).status,"unused");
    assert.equal(s.listCards()[0].successfulAccounts.length,0);
    assert.equal(s.order(second.orderId).status,"reserved");
    assert.equal(s.resolveFrozenUse(first.orderId,"release","checked payment ledger"),true);
    assert.equal(s.listCards()[0].frozenUses,0);
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM audit").get().n,2);
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
    assert.equal(restarted.reserve(codes[1].code,"second@example.test","account-2").ok,true);
    assert.equal(restarted.voucher(codes[0].code).status,"reserved");
    assert.equal(restarted.recoverInterrupted(30000),0);
    assert.equal(restarted.db.prepare("SELECT count(*) AS n FROM audit WHERE action='interrupted_recovery'").get().n,1);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test("concurrent reservations cannot claim the same manual card", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),"zzshu-concurrent-"));
  try {
    const file = path.join(dir,"test.sqlite"), first = new ZzshuStore(file), second = new ZzshuStore(file);
    first.addPaymentCard(parsePaymentCards(`${fakePan},12/40,123`)[0],
      {credentialRef:"local:fixture",paymentCipher:"cipher",source:"fixture",note:"",enabled:true,maxSuccess:2});
    const codes = first.createVouchers(2,"fixture",3,()=>"cipher");
    const results = await Promise.all([
      Promise.resolve().then(() => first.reserve(codes[0].code,"a@example.test","a")),
      Promise.resolve().then(() => second.reserve(codes[1].code,"b@example.test","b"))
    ]);
    assert.deepEqual(results.map(result=>result.ok).sort(),[false,true]);
    assert.equal(first.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE status='reserved'").get().n,1);
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


test("failed and unavailable vouchers retain their first account across restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-binding-"));
  try {
    const file = path.join(dir, "state.sqlite"), s = new ZzshuStore(file);
    const [v] = s.createVouchers(1, "fixture", 3, () => "cipher");
    assert.equal(s.reserve(v.code, "first@example.test", "first").ok, false);
    assert.match(s.reserve(v.code, "second@example.test", "second").reason, /绑定首次/);
    s.addPaymentCard(parsePaymentCards(`${fakePan},12/40,123`)[0], {credentialRef:"fixture", source:"fixture", note:"", enabled:true, maxSuccess:3});
    const first = s.reserve(v.code, "first@example.test", "first");
    assert.equal(first.ok, true);
    s.settle(first.orderId, "failed");
    const restarted = new ZzshuStore(file);
    assert.equal(restarted.voucher(v.code).status, "unused");
    assert.match(restarted.reserve(v.code, "second@example.test", "second").reason, /绑定首次/);
    const retry = restarted.reserve(v.code, "first@example.test", "first");
    assert.equal(retry.ok, true);
    assert.notEqual(retry.orderId, first.orderId);
    assert.equal(restarted.listCards()[0].successCount, 0);
    assert.equal(restarted.reserve(v.code, "first@example.test", "first").orderId, retry.orderId);
    assert.match(restarted.reserve(v.code, "second@example.test", "second").reason, /绑定首次/);
    s.db.close(); restarted.db.close();
  } finally { fs.rmSync(dir, {recursive:true,force:true}); }
});
