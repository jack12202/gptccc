import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildWorkbench,workbenchPaymentCards } from '../src/admin-workbench.js';

const fixture = (id,extra={}) => ({id,credentialSource:'manual',enabled:1,remainingUses:2,maxSuccess:4,successCount:1,frozenUses:1,lastFour:'4242',source:'fixture',...extra});
test('workbench omits stopped cards but keeps exhausted, frozen, paused and occupied cards with correct eligibility',()=>{
  const h={id:'h',sharedUsageId:'shared-h',enabled:true,lastFour:'1001',remainingUses:2,maxUses:4,usedCount:1,frozenCount:1,status:'active',balance:40,poolStatus:'ready',inFlightCount:0};
  const manual=[fixture('ready'),fixture('paused',{paused:1}),fixture('busy',{occupiedOrderId:'pending'}),fixture('empty',{remainingUses:0}),fixture('stopped',{enabled:0}),fixture('shared-h',{credentialSource:'hifupay',hifupayId:'h'})];
  const cards=workbenchPaymentCards([h],manual,16);
  assert.equal(cards.some(c=>c.id==='stopped'),false);assert.equal(cards.some(c=>c.id==='empty'),true);
  assert.deepEqual(cards.filter(c=>c.channels.length).map(c=>c.id).sort(),['h','ready']);
  assert.deepEqual(cards.find(c=>c.id==='h').channels,['嗨付','ZZS']);
  assert.deepEqual(workbenchPaymentCards([{...h,poolStatus:'high_balance',balance:90}],manual,16).find(c=>c.id==='h').channels,['ZZS']);
  for(const mutation of [{paused:1},{occupiedOrderId:'z-order'},{enabled:0}]){
    const usage=manual.map(c=>c.id==='shared-h'?{...c,...mutation}:c),rows=workbenchPaymentCards([h],usage,16);
    assert.equal(rows.find(c=>c.id==='h')?.channels.length||0,0);
  }
  assert.equal(workbenchPaymentCards([{...h,missingFromUpstream:true}],manual,16).find(c=>c.id==='h').channels.length,0);
  assert.equal(workbenchPaymentCards([{...h,proProtected:true}],manual,16).find(c=>c.id==='h').channels.length,0);
});

test('recent windows do not truncate full searches or older unresolved orders and voucher states follow current attempts',()=>{
  const records=Array.from({length:25},(_,i)=>({id:'o-'+i,customerCardId:'v-'+i,userEmail:'user-'+i+'@example.test',plan:'plus',provider:'zzshu',status:i===24?'needs_review':'success',createdAt:new Date(Date.UTC(2026,9,12,12-i)).toISOString(),salesChannel:'fixture'}));
  const vouchers=Array.from({length:45},(_,i)=>({id:'v-'+i,code:'CODE-'+i,status:i<24?'used':'unused',plan:'plus',source:'fixture',batchId:i<20?'new-batch':'old-batch',createdAt:'2026-10-11T18:00:00Z'}));
  const input={hifupay:[],usageCards:[fixture('ready')],records,customerCards:vouchers,plusProvider:'zzshu'};
  const result=buildWorkbench(input);
  assert.equal(result.orders.items.length,10);assert.equal(result.vouchers.items.length,20);assert.equal(result.summary.attentionOrders,1);
  assert.equal(result.vouchers.counts.needs_review,1);assert.equal(result.vouchers.counts.unused,20);
  assert.equal(buildWorkbench(input,{orderView:'attention'}).orders.items[0].id,'o-24');
  assert.equal(buildWorkbench(input,{orderSearch:'user-24@'}).orders.items.length,1);
  assert.equal(buildWorkbench(input,{voucherSearch:'CODE-44'}).vouchers.items[0].id,'v-44');
  assert.equal(buildWorkbench(input,{voucherStatus:'needs_review'}).vouchers.items[0].id,'v-24');
  assert.equal(buildWorkbench(input,{batch:'old-batch'}).vouchers.matched,25);
  assert.equal(buildWorkbench(input,{voucherDate:'2026-10-12'}).vouchers.matched,45);
  assert.equal(buildWorkbench(input,{voucherDate:'2026-10-11'}).vouchers.matched,0);
  assert.equal(buildWorkbench(input,{orderPage:999}).orders.items.length,5);
  assert.equal(buildWorkbench(input,{voucherPage:-10}).vouchers.page,1);
  assert.equal(buildWorkbench(input,{orderProvider:'h'}).orders.matched,0);
  assert.equal(buildWorkbench({...input,plusProvider:'h'}).summary.selectableUses,0);
  assert.equal(buildWorkbench(input).summary.selectableUses,2);
  assert.equal(buildWorkbench(input,{batch:'new-batch'}).vouchers.counts.used,20);
  assert.equal(buildWorkbench(input,{batch:'new-batch'}).vouchers.counts.unused,0);
  const resolving={...input,records:[{...records[24],status:'failed',retryAllowed:true,useResolution:'released'}]};
  assert.equal(buildWorkbench(resolving).summary.attentionOrders,0);
  const failed={...input,records:[{...records[24],status:'failed',retryAllowed:false,useResolution:'frozen',userEmail:'bound@example.test'}]};
  const failedCard=buildWorkbench(failed,{voucherSearch:'CODE-24'}).vouchers.items[0];
  assert.equal(failedCard.operationalStatus,'needs_review');assert.equal(failedCard.boundEmail,'bound@example.test');assert.equal(failedCard.hasSubmission,true);
});

test('home and assets require the shared session; bounded snapshot joins card, voucher and order mutations',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gptc-workbench-api-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  process.env.ADMIN_TOKEN='workbench-fixture';process.env.DATA_FILE=path.join(dir,'orders.json');process.env.ZZSHU_DB_FILE=path.join(dir,'usage.sqlite');process.env.RECOVERY_ENCRYPTION_KEY='workbench-fixture-key';
  const {server}=await import('../src/server.js');const {rechargeService}=await import('../src/recharge-service.js');
  const {zzshuService}=await import('../src/zzshu-service.js');const {JsonStore}=await import('../src/store.js');
  const store=new JsonStore(process.env.DATA_FILE);
  const cards=rechargeService.createHCards({count:30,source:'fixture'}).data.cards;
  const order=store.createOrder({provider:'h',status:'needs_review',hCardId:cards[0].id},{userEmail:'old@example.test',accountId:'old-account'});
  store.updateOrder(order.id,{createdAt:'2020-01-01T00:00:00Z'});
  for(let i=1;i<15;i++)store.createOrder({provider:'h',status:'success',hCardId:cards[i].id},{userEmail:'user-'+i+'@example.test'});
  await zzshuService.importCards({text:'4242424242424242,12/40,123\n4000056655665556,12/40,123',source:'fixture',maxSuccess:4});
  const [active,stopped]=zzshuService.store.listCards();zzshuService.store.updateCard(stopped.id,{enabled:false});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/api/admin/workbench')).status,401);
  assert.equal((await fetch(base+'/admin/cards/workbench.js',{redirect:'manual'})).status,303);
  const login=await fetch(base+'/api/admin/login',{method:'POST',headers:{Origin:'https://www.gptc.cc','Content-Type':'application/json','X-Admin-Request':'1'},body:JSON.stringify({password:'workbench-fixture'})});
  const cookie=login.headers.get('set-cookie').split(';')[0],csrf=(await login.json()).data.csrf;
  const headers={Cookie:cookie,Origin:'https://www.gptc.cc','X-CSRF-Token':csrf,'Content-Type':'application/json'};
  const get=suffix=>fetch(base+suffix,{headers:{Cookie:cookie}});
  const snap=async query=>(await (await get('/api/admin/workbench'+(query?'?'+query:''))).json()).data;
  const html=await (await get('/admin')).text();assert.match(html,/正在使用的支付卡/);assert.match(html,/最近客户卡密/);assert.match(html,/最近充值订单/);assert.match(html,/录入支付卡/);
  for(const asset of ['workbench.js','workbench-settings.js']){const response=await get('/admin/cards/'+asset);assert.equal(response.status,200);new vm.Script(await response.text());}
  const initial=await snap();assert.equal(initial.orders.items.length,10);assert.equal(initial.vouchers.items.length,20);assert.equal(initial.cards.length,1);assert.equal(initial.cards[0].id,active.id);
  assert.equal(initial.summary.unusedVouchers,15);assert.equal((await snap('orderView=attention')).orders.items[0].id,order.id);
  assert.equal((await snap('voucherSearch='+cards[0].code)).vouchers.items[0].operationalStatus,'needs_review');
  const before=initial.summary.remainingUses;
  const result=await fetch(base+'/api/admin/zzshu/cards/'+active.id+'/add-uses',{method:'POST',headers,body:JSON.stringify({amount:1,requestId:'workbench-fixture-request-1'})});assert.equal(result.status,200);
  const after=await snap();assert.equal(after.summary.remainingUses,before+1);assert.equal(after.cards.length,1);
  const visible=JSON.stringify(after);assert.equal(visible.includes('4242424242424242'),false);assert.equal(visible.includes('workbench-fixture-key'),false);assert.equal(visible.includes('payment_cipher'),false);assert.equal(visible.includes('secretJsonText'),false);
});
