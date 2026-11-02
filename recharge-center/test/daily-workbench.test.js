import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildWorkbench} from '../src/admin-workbench.js';
import {buildDailyActivity} from '../src/daily-workbench.js';

test('daily success and redemption use Shanghai completion dates, deduplicate cards and retain disabled/archived redemptions',()=>{
 const now=new Date('2026-11-02T03:00:00Z'),today='2026-11-01T16:00:00Z',yesterday='2026-11-01T15:59:59Z';
 const cards=[{id:'v1',code:'ONE',status:'used',plan:'plus',createdAt:yesterday,usedAt:today},{id:'v2',code:'TWO',status:'disabled',plan:'pro_x5',archivedAt:today,usedAt:today},{id:'v3',code:'THREE',status:'used',usedAt:yesterday}];
 const records=[{id:'cross-day',status:'success',createdAt:yesterday,completedAt:today,customerCardId:'v1',customerCardCode:'ONE',plan:'plus',fulfillmentMode:'manual'},
  {id:'mirror',status:'success',createdAt:yesterday,completedAt:today,customerCardCode:'ONE',supersededBy:'cross-day'},
  {id:'archived-card',status:'success',createdAt:today,completedAt:today,customerCardId:'v2',customerCardCode:'TWO',plan:'pro_x5'},
  {id:'used-yesterday',status:'success',createdAt:yesterday,completedAt:yesterday,customerCardId:'v3'},
  {id:'pending',status:'needs_review',createdAt:today,completedAt:today},
  {id:'failed',status:'failed',createdAt:today,completedAt:today},
  {id:'closed',status:'failed',createdAt:today,workbenchHandledAt:today},
  {id:'legacy-unknown',status:'success',createdAt:today}];
 const result=buildDailyActivity(records,cards,now);
 assert.equal(result.summary.todaySuccess,2);assert.equal(result.summary.todayRedeemed,2);assert.equal(result.summary.todaySubmitted,5);assert.equal(result.summary.successTimeUnknown,1);
 assert.deepEqual(result.summary.todaySuccessByPlan,{plus:1,pro_x5:1,pro_x20:0});assert.deepEqual(result.summary.todaySuccessModes,{manual:1,auto:1});
 assert.deepEqual(result.redeemed.map(card=>card.id).sort(),['v1','v2']);
});

test('metric drilldowns match totals, clear date ambiguity, and count distinct legacy vouchers once',()=>{
 const now=new Date().toISOString(),past='2020-01-01T00:00:00Z';
 const records=[{id:'a',status:'success',createdAt:past,completedAt:now,customerCardCode:'LEGACY',userEmail:'one@example.test',plan:'plus'},
 {id:'b',status:'success',createdAt:past,completedAt:now,customerCardCode:'LEGACY',userEmail:'two@example.test',plan:'plus'},
 {id:'c',status:'needs_review',createdAt:now,workbenchHandledAt:now}, {id:'unknown',status:'success',createdAt:now,completedAt:'not a date'}];
 const input={hifupay:[],usageCards:[],customerCards:[],plusProvider:'zzshu',records};
 const home=buildWorkbench(input),success=buildWorkbench(input,{orderView:'today-success'}),redeemed=buildWorkbench(input,{voucherStatus:'today-redeemed'}),submitted=buildWorkbench(input,{orderView:'today-submitted'});
 assert.equal(home.summary.todaySuccess,2);assert.equal(success.orders.matched,2);assert.equal(home.summary.todayRedeemed,1);assert.equal(redeemed.vouchers.matched,1);
 assert.equal(redeemed.vouchers.items[0].redeemedAt,now);assert.equal(redeemed.vouchers.items[0].operationalStatus,'used');
 assert.equal(submitted.orders.matched,home.summary.todaySubmitted);assert.equal(home.summary.todaySubmitted,2);
 assert.equal(buildWorkbench(input,{voucherStatus:'today-redeemed',voucherPlan:'pro_x5'}).vouchers.matched,0);
});

test('native ZZS completion times and manual redemption reach the real workbench API model without persisting fabricated dates',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gptc-daily-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 process.env.DATA_FILE=path.join(dir,'orders.json');process.env.ZZSHU_DB_FILE=path.join(dir,'usage.sqlite');process.env.RECOVERY_ENCRYPTION_KEY='daily-fixture-key';process.env.ADMIN_TOKEN='daily-fixture';
 const {rechargeService:r}=await import('../src/recharge-service.js');const {zzshuService:z}=await import('../src/zzshu-service.js');
 await z.importCards({text:'4242424242424242,12/40,123',source:'fixture',maxSuccess:4});
 const [voucher]=z.createVouchers({count:1,source:'fixture'}),reserved=z.store.reserve(voucher.code,'native@example.test','native',null,true,'fixture-json');
 z.store.db.prepare('UPDATE orders SET created_at=? WHERE id=?').run('2020-01-01T00:00:00Z',reserved.orderId);z.store.settle(reserved.orderId,'success','cancelled');
 assert.ok(z.store.listOrders().find(order=>order.id===reserved.orderId).completedAt);
 r.updatePlusFulfillmentMode('manual');const [card]=r.createHCards({count:1,source:'fixture'}).data.cards;
 const submitted=await r.confirmRecharge({cardInfo:card.code,secretJsonText:JSON.stringify({user:{email:'manual@example.test'},account:{id:'manual'}}),provider:'h'});
 assert.equal(r.manualPlusAction(submitted.data.orderId,'mark-success',{}).ok,true);
 const home=r.getAdminWorkbench();assert.equal(home.summary.todaySuccess,2);assert.equal(home.summary.todayRedeemed,2);assert.equal(home.summary.todaySuccessModes.manual,1);
 const used=r.getAdminWorkbench({voucherStatus:'today-redeemed'});assert.equal(used.vouchers.items.length,2);assert.equal(used.vouchers.matched,home.summary.todayRedeemed);
});
