import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("manual import persists encrypted cards and spends A, A, B exactly once", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zzshu-manual-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  process.env.DATA_FILE = path.join(dir, "orders.json");
  process.env.ZZSHU_DB_FILE = path.join(dir, "zzshu.sqlite");
  process.env.ZZSHU_ENABLED = "true";
  process.env.ZZSHU_API_KEY = "fixture-api-key";
  process.env.RECOVERY_ENCRYPTION_KEY = "fixture-encryption-key";
  const { zzshuService: service } = await import("../src/zzshu-service.js");
  const { rechargeService } = await import("../src/recharge-service.js");
  const { ZzshuStore } = await import("../src/zzshu-store.js");
  const { config } = await import("../src/config.js");
  config.zzshuBaseUrl = "https://fixture.example.test";
  config.zzshuConcurrency = 3;
  const a = "4242424242424242", b = "5555555555554444", cvv = "987";
  assert.equal(service.importStatus().ready, true);
  const first = await service.importCards({text:`${a},12/40,${cvv}\n${a},12/40,${cvv}\nbad`,source:"fixture",maxSuccess:2});
  assert.deepEqual(first.rows.map(row => row.status), ["imported","duplicate","error"]);
  assert.equal((await service.importCards({text:`${b},12/40,${cvv}`,source:"fixture",maxSuccess:1})).rows[0].status,"imported");
  assert.equal((await service.importCards({text:`${a},12/40,${cvv}`,source:"fixture",maxSuccess:99})).rows[0].status,"duplicate");
  const originalCards = service.store.listCards();
  assert.equal(originalCards.find(card => card.lastFour === "4242").maxSuccess,2);
  const visible = JSON.stringify({cards:originalCards,preview:service.preview(`${a},12/40,${cvv}`),rows:first.rows});
  for (const secret of [a,b,cvv,"fixture-api-key"]) assert.equal(visible.includes(secret),false);
  const stored = fs.readFileSync(process.env.ZZSHU_DB_FILE);
  for (const secret of [a,b,cvv,"fixture-api-key"]) assert.equal(stored.includes(Buffer.from(secret)),false);
  const reopened = new ZzshuStore(process.env.ZZSHU_DB_FILE);
  assert.equal(reopened.listCards().length,2);
  const session = JSON.stringify({user:{id:"u",email:"customer@example.test"},account:{id:"account",planType:"free"},
    accessToken:"fixture-access",sessionToken:"fixture-session",expires:"2040-01-01"});
  const vouchers = service.createVouchers({count:7,source:"fixture"});
  const {sha256} = await import("../src/utils.js");
  config.zzshuTestVoucherHash = sha256(vouchers[0].code);
  config.zzshuTestAccountHash = sha256("account");
  config.zzshuTestMode = true;
  const readiness = service.diagnostics();
  assert.equal(readiness.testVoucherStatus,"unused");
  assert.equal(readiness.apiKeyReady,true);
  assert.equal(readiness.manualCardSelectable,true);
  assert.equal(readiness.manualPaymentReadable,true);
  assert.equal(readiness.reservationProbe,"ready");
  assert.equal(service.store.voucher(vouchers[0].code).status,"unused");
  assert.equal(service.store.listOrders().length,0);
  const allowedVoucherHash = config.zzshuTestVoucherHash;
  config.zzshuTestVoucherHash = "";
  assert.equal((await service.confirm({cardInfo:vouchers[0].code,secretJsonText:session})).status,403);
  config.zzshuTestVoucherHash = allowedVoucherHash;
  assert.equal((await service.confirm({cardInfo:vouchers[1].code,secretJsonText:session})).status,403);
  const otherAccount = JSON.parse(session);
  otherAccount.account.id = "other-account";
  assert.equal((await service.confirm({cardInfo:vouchers[0].code,secretJsonText:JSON.stringify(otherAccount)})).status,403);
  assert.equal(service.diagnostics().recentPreSubmitFailures[0].reason,"测试卡密或账号门禁未通过");
  assert.equal(service.store.voucher(vouchers[0].code).status,"unused");
  const verified = await rechargeService.verifyCard(vouchers[0].code,"sange");
  assert.equal(verified.data.selectedProvider,"zzshu");
  const submitted = [];
  let status = "success";
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const endpoint = new URL(url).pathname;
    if (endpoint.endsWith("/direct")) {
      const body = JSON.parse(options.body);
      submitted.push(body.cardNumber);
      assert.equal(body.cvv,cvv);
      assert.equal(body.planType,"plus");
      return {ok:true,status:201,json:async()=>({code:0,data:{order_no:`up-${submitted.length}`,card_key:`key-${submitted.length}`}})};
    }
    if (endpoint.endsWith("/status")) {
      const key = JSON.parse(options.body).cardKey;
      return {ok:true,status:200,json:async()=>({code:0,data:{order_no:`up-${key.slice(4)}`,card_key:key,
        plan_type:"plus",status,is_subscription_cancelled:1,payment_result:{success:status === "success",status:status === "success"?"paid":"failed"},
        bank_card_no:a,token:JSON.parse(session)}})};
    }
    throw Error("Unexpected endpoint");
  };
  t.after(() => { globalThis.fetch = oldFetch; });
  for (let i=0;i<3;i++) {
    const result = i === 0
      ? await rechargeService.confirmRecharge({provider:"sange",cardInfo:vouchers[i].code,secretJsonText:session})
      : await service.confirm({cardInfo:vouchers[i].code,secretJsonText:session});
    if (i === 0) { config.zzshuTestMode = false; config.zzshuTestVoucherHash = ""; config.zzshuTestAccountHash = ""; }
    assert.equal(result.ok,true);
    assert.equal((await service.confirm({cardInfo:vouchers[i].code,secretJsonText:session})).data.orderId,result.data.orderId);
    assert.equal((await service.refresh(result.data.orderId)).data.status,"success");
    await service.refresh(result.data.orderId);
  }
  assert.deepEqual(submitted,[a,a,b]);
  assert.equal((await rechargeService.queryHCardStatus(vouchers[0].code,"h")).data.status,"success");
  const counts = service.store.listCards();
  assert.deepEqual(counts.map(c=>[c.lastFour,c.successCount,c.remainingUses]),[["4242",2,0],["4444",1,0]]);
  const fourth = await service.confirm({cardInfo:vouchers[3].code,secretJsonText:session});
  assert.equal(fourth.ok,false);
  assert.equal(service.store.voucher(vouchers[3].code).status,"unused");
  assert.equal(submitted.length,3);
  assert.equal(service.store.updateCard(counts[0].id,{maxSuccess:3}),true);
  assert.equal(service.store.listCards().find(c=>c.lastFour === "4242").remainingUses,1);
  const unknown = await service.confirm({cardInfo:vouchers[4].code,secretJsonText:session});
  assert.equal(unknown.data.status,"processing");
  assert.equal((await service.confirm({cardInfo:vouchers[5].code,secretJsonText:session})).ok,false);
  assert.equal(service.store.voucher(vouchers[5].code).status,"unused");
  assert.equal(reopened.recoverInterrupted(0),0);
  assert.equal(reopened.order(unknown.data.orderId).status,"processing");
  status = "failed";
  await service.refresh(unknown.data.orderId);
  assert.equal(service.store.order(unknown.data.orderId).status,"needs_review");
  assert.equal(service.store.manualResolve(unknown.data.orderId,"unpaid","fixture payment record checked"),true);
  assert.equal(service.store.voucher(vouchers[4].code).status,"unused");
  assert.equal(service.store.listCards().find(c=>c.lastFour === "4242").successCount,2);
  const retry = await service.confirm({cardInfo:vouchers[4].code,secretJsonText:session});
  assert.equal(retry.ok,true);
  assert.notEqual(retry.data.orderId,unknown.data.orderId);
  assert.equal(service.store.order(unknown.data.orderId).status,"failed");
  const redacted = JSON.stringify({order:retry.data,cards:service.store.listCards(),orders:service.store.listOrders()});
  for (const secret of [a,b,"fixture-api-key","fixture-session"]) assert.equal(redacted.includes(secret),false);
  assert.equal(redacted.includes('"cvv"'),false);
  const originalAdd = service.store.addPaymentCard;
  service.store.addPaymentCard = () => { throw Error("simulated storage failure"); };
  const partial = await service.importCards({text:"4000000000000002,12/40,456\nbroken",source:"fixture"});
  service.store.addPaymentCard = originalAdd;
  assert.deepEqual(partial.rows.map(row=>row.status),["error","error"]);
  assert.match(partial.rows[0].error,/保存失败/);
});
