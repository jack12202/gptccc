import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {annotateRepeatedOrders,isExpiredOrder,orderRetentionMs} from '../src/order-housekeeping.js';
import {buildWorkbench} from '../src/admin-workbench.js';

test('pending work counts customer vouchers, keeps retries in history, and uses the latest attempt including successful/closed attempts',()=>{
 const records=[
  {id:'new',userEmail:'A@example.test',customerCardCode:'CODE-1',status:'failed',createdAt:'2026-11-02T02:00:00Z'},
  {id:'old',userEmail:'a@example.test',customerCardCode:'CODE-1',status:'failed',createdAt:'2026-11-02T01:00:00Z'},
  {id:'other',userEmail:'a@example.test',customerCardCode:'CODE-2',status:'failed',createdAt:'2026-11-02T00:00:00Z'}];
 const input={hifupay:[],usageCards:[],customerCards:[],plusProvider:'zzshu',records};
 assert.equal(buildWorkbench(input).summary.attentionOrders,2);
 assert.equal(buildWorkbench(input,{orderView:'attention'}).orders.matched,2);
 assert.equal(annotateRepeatedOrders(records).length,3);
 assert.equal(buildWorkbench({...input,records:records.map(o=>o.id==='new'?{...o,status:'success'}:o)}).summary.attentionOrders,1);
 assert.equal(buildWorkbench({...input,records:records.map(o=>o.id==='new'?{...o,workbenchHandledAt:'closed'}:o)}).summary.attentionOrders,1);
 assert.equal(buildWorkbench({...input,records:records.map(o=>({...o,customerCardCode:'',customerCardId:''}))}).summary.attentionOrders,3);
});

test('expiry uses a full 24 hours from submission rather than the repeatedly updated poll timestamp',()=>{
 const now=Date.now();
 assert.equal(isExpiredOrder({status:'failed',createdAt:new Date(now-orderRetentionMs+1).toISOString()},now),false);
 assert.equal(isExpiredOrder({status:'needs_review',createdAt:new Date(now-orderRetentionMs).toISOString(),updatedAt:new Date(now).toISOString()},now),true);
 for(const status of ['success','submitting','reserved'])assert.equal(isExpiredOrder({status,createdAt:'2020-01-01'},now),false);
 assert.equal(isExpiredOrder({status:'failed',createdAt:'bad date'},now),false);
});

test('reimport resets remaining uses, closes frozen attempts, preserves secrets/history and never double-charges late results; housekeeping archives expired tasks without changing usage',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gptc-reset-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 process.env.DATA_FILE=path.join(dir,'orders.json');process.env.ZZSHU_DB_FILE=path.join(dir,'usage.sqlite');process.env.RECOVERY_ENCRYPTION_KEY='fixture-reset-key';process.env.ADMIN_TOKEN='fixture-admin';
 const {zzshuService:s}=await import('../src/zzshu-service.js');
 const {rechargeService:r}=await import('../src/recharge-service.js');
 const {JsonStore}=await import('../src/store.js');const json=new JsonStore();
 const text='4242424242424242,12/40,123';
 assert.equal((await s.importCards({text,source:'fixture',maxSuccess:4})).rows[0].status,'imported');
 const codes=s.createVouchers({count:5,source:'fixture'});
 const success=s.store.reserve(codes[0].code,'done@example.test','done',null,true,'keep-success-json');s.store.settle(success.orderId,'success','cancelled');
 const frozen=s.store.reserve(codes[1].code,'frozen@example.test','frozen',null,true,'keep-frozen-json');s.store.review(frozen.orderId,'fixture unknown payment');
 const card=s.store.listCards()[0];assert.equal(card.frozenUses,1);s.store.updateCard(card.id,{enabled:false});
 assert.equal(s.preview(text)[0].status,'update');
 const result=await s.importCards({text,source:'updated-source',maxSuccess:4});assert.equal(result.rows[0].status,'updated');assert.equal(result.rows[0].remainingUses,4);
 const reset=s.store.listCards()[0];assert.equal(reset.id,card.id);assert.equal(reset.remainingUses,4);assert.equal(reset.frozenUses,0);assert.equal(reset.enabled,1);assert.equal(reset.occupiedOrderId,null);assert.equal(reset.successCount,1);
 assert.equal(s.store.sessionCipher(frozen.orderId),'keep-frozen-json');assert.ok(s.store.order(frozen.orderId).workbench_handled_at);assert.equal(s.store.order(frozen.orderId).auto_query,0);
 assert.equal(s.store.settle(frozen.orderId,'success'),false);assert.equal(s.store.manualDisposition(frozen.orderId,'success',{reason:'must not alter a closed order'}),false);
 assert.equal(s.store.listCards().find(card=>card.credentialSource==='manual').remainingUses,4);
 assert.equal((await s.importCards({text,source:'fixture',maxSuccess:4})).rows[0].remainingUses,4);
 assert.equal(s.store.listCards().find(card=>card.credentialSource==='manual').remainingUses,4); // Repeat import is replacement, not addition.
 const expired=s.store.reserve(codes[2].code,'old@example.test','old',null,true,'keep-expired-json');s.store.review(expired.orderId,'fixture');
 const old=new Date(Date.now()-25*60*60*1000).toISOString();s.store.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run(old,expired.orderId);
 json.syncHifupayCards([{id:'fixture-h',lastFour:'1001',status:'active',balance:40}]);
 const primary=json.createOrder({provider:'h',status:'needs_review',hifupayCardId:'fixture-h'},{userEmail:'primary@example.test',accountId:'p',rawSecretCiphertext:'preserve-primary-session'});
 assert.equal(s.store.claimH('fixture-h',primary.id),true);s.store.freezeH('fixture-h',primary.id);assert.equal(s.store.hifupayUsage('fixture-h').frozenUses,1);json.updateOrder(primary.id,{createdAt:old});
 r.runOrderHousekeeping();assert.ok(s.store.order(expired.orderId).workbench_handled_at);assert.equal(s.store.sessionCipher(expired.orderId),'keep-expired-json');
 assert.ok(json.getOrder(primary.id).workbenchHandledAt);assert.equal(s.store.hifupayUsage('fixture-h').frozenUses,1);assert.equal(json.getRecoveryOrder(primary.id).session.rawSecretCiphertext,'preserve-primary-session');assert.equal(json.getRecoveryOrder(primary.id).session.userEmail,'primary@example.test');
 assert.equal(s.store.listCards().find(card=>card.credentialSource==='manual').remainingUses,3);assert.equal(s.store.listCards().find(card=>card.credentialSource==='manual').frozenUses,1);
 assert.equal(s.store.order(expired.orderId).status,'needs_review');assert.equal(json.getOrder(primary.id).status,'needs_review');
 assert.equal(r.getAdminWorkbench().attention.total,0);
 assert.equal(r.runOrderHousekeeping().nativeClosed,0);assert.equal(r.runOrderHousekeeping().primaryClosed,0);
 const recent=s.store.reserve(codes[3].code,'recent@example.test','recent',null,true,'recent-json');s.store.review(recent.orderId,'fixture');
 r.runOrderHousekeeping();assert.equal(s.store.order(recent.orderId).workbench_handled_at,'');
 assert.equal(r.getAdminWorkbench().attention.total,1);
 assert.equal(s.store.order(success.orderId).status,'success');
 // Wait for a live upstream request before resetting, then make the new remaining count authoritative.
 const {zzshuAdapter}=await import('../src/providers/zzshu-adapter.js');
 s.store.db.prepare("UPDATE orders SET status='processing',upstream_order_no='upstream-test',upstream_card_key='key-test' WHERE id=?").run(recent.orderId);
 let resolve;const response=new Promise(done=>resolve=done);const original=zzshuAdapter.status;
 zzshuAdapter.status=()=>response;t.after(()=>{zzshuAdapter.status=original;});
 const refresh=s.refresh(recent.orderId);let imported=false;
 const importing=s.importCards({text,source:'fixture',maxSuccess:3}).then(result=>{imported=true;return result;});
 await new Promise(done=>setTimeout(done,10));assert.equal(imported,false);assert.equal(s.store.manualCandidate(),undefined);
 r.runOrderHousekeeping(Date.now()+25*60*60*1000);assert.equal(s.store.order(recent.orderId).workbench_handled_at,'');
 resolve({ok:true,status:200,data:{cardKey:'key-test',orderNo:'upstream-test',planType:'plus',status:'success',paid:true,cancellation:'cancelled'}});
 await refresh;await importing;assert.equal(s.store.listCards().find(card=>card.credentialSource==='manual').remainingUses,3);assert.equal(s.store.listCards().find(card=>card.credentialSource==='manual').successCount,2);assert.equal(s.store.listCards().find(card=>card.credentialSource==='manual').frozenUses,0);assert.equal(s.store.order(expired.orderId).use_resolution,'released');
});
