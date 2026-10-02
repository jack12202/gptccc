import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function page(fetch) {
  const html = fs.readFileSync(new URL('../../activate/index.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('let currentStep'));
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value:'', textContent:'', style:{}, checked:true, disabled:false,
      classList:{add(){},remove(){},toggle(){}}, addEventListener(){}, firstChild:{textContent:''} });
    return nodes.get(id);
  };
  const memory = new Map(), timers=[];
  const context=vm.createContext({ URLSearchParams, console, fetch,
    document:{ body:{classList:{toggle(){}}}, getElementById:node, querySelectorAll:()=>[], addEventListener(){} },
    window:{location:{search:''},setTimeout:fn=>{timers.push(fn);return timers.length;},scrollTo(){},addEventListener(){}},
    sessionStorage:{setItem:(k,v)=>memory.set(k,v),getItem:k=>memory.get(k),removeItem:k=>memory.delete(k)},
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},navigator:{} });
  vm.runInContext(script.slice(0,script.lastIndexOf('    applySourceFromQuery();')),context);
  node('cardInfo').value='HPLUS'+'A'.repeat(32);
  node('secretJson').value='fixture';
  vm.runInContext('currentProvider="h";currentParsedSecret={userEmail:"first@example.test",userGptToken:"fixture",fullAuthData:{}}',context);
  return {node,context,memory,run:code=>vm.runInContext(code,context)};
}

test('lost submit response blocks another submit and refresh queries the original card',async()=>{
  let calls=0;
  const p=page(async()=>{calls++;throw Error('lost response');});
  await p.run('confirmRecharge()');
  assert.equal(calls,1);
  assert.equal(p.node('confirmRechargeBtn').disabled,true);
  assert.match(p.node('confirmRechargeBtn').textContent,/确认提交结果/);
  p.run('updateConfirmButtonState()');
  assert.equal(p.node('confirmRechargeBtn').disabled,true);
  await p.run('confirmRecharge()');
  assert.equal(calls,1);
  assert.equal(p.memory.size,1);
  assert.equal([...p.memory.values()][0],'1');
});

test('reopened card lookup shows success without another recharge or session JSON',async()=>{
  const paths=[];
  const p=page(async path=>{paths.push(path);return {text:async()=>JSON.stringify({success:true,data:{status:'success',statusLabel:'充值成功',canRecharge:false,message:'已完成'}})};});
  await p.run('queryCardStatusFromInput()');
  assert.deepEqual(paths,['/api/recharge/h-card-status']);
  assert.equal(p.node('confirmRechargeBtn').textContent,'充值已完成');
});

test('accepted but failed order shows waiting for help while a pre-submit rejection stays distinct',async()=>{
  const accepted=page(async()=>({text:async()=>JSON.stringify({success:false,message:'upstream payment failed',data:{orderId:'order-1'}})}));
  await accepted.run('confirmRecharge()');
  assert.match(accepted.node('step3Notice').innerHTML,/已提交，等待处理/);
  assert.match(accepted.node('resultBox').innerHTML,/已提交，等待处理/);
  assert.doesNotMatch(accepted.node('resultBox').innerHTML,/充值失败|upstream payment failed/);

  const rejected=page(async()=>({text:async()=>JSON.stringify({success:false,message:'卡密不存在'})}));
  await rejected.run('confirmRecharge()');
  assert.match(rejected.node('step3Notice').innerHTML,/暂未完成提交/);
  assert.doesNotMatch(rejected.node('step3Notice').innerHTML,/排队|等待人工核查/);
});

test('reopened failed submission stays in assistance state instead of auto submitting again',async()=>{
  const requests=[];
  const p=page(async path=>{
    requests.push(path);
    return {text:async()=>JSON.stringify({success:true,data:{status:'unused',canRecharge:true,hasPriorSubmission:true,
      statusLabel:'未使用',message:'可继续激活'}})};
  });
  assert.equal(await p.run('queryCardStatusFromInput()'),false);
  assert.deepEqual(requests,['/api/recharge/h-card-status']);
  assert.match(p.node('step1Notice').innerHTML,/已提交，等待处理/);
  assert.doesNotMatch(p.node('step1Notice').innerHTML,/未使用|可继续激活|充值失败/);
});

test('ZZS account check lets a parseable incomplete Session reach submission',async()=>{
  const p=page(async()=>{throw Error('no request expected');});
  p.run('currentProvider="zzshu"');
  p.node('secretJson').value=JSON.stringify({user:{id:'user',email:'first@example.test'},
    account:{id:'account',planType:'free'},accessToken:'fixture',expires:'2040-01-01'});
  await p.run('parseSecret()');
  assert.match(p.node('step2Notice').innerHTML,/账号信息识别成功/);
  assert.ok(p.run('currentParsedSecret'));
  assert.equal(p.run('currentStep'),3);
});

test('expired authorization offers same-card JSON replacement without keeping the old task lock',async()=>{
  const paths=[];
  const p=page(async path=>{
    paths.push(path);
    return {text:async()=>JSON.stringify({success:true,data:{orderId:'old-order',taskId:'old-order',status:'failed',canRetry:true,
      actionRequired:'update_session',message:'账号授权已失效，请获取新的 Session JSON，使用原卡密重新提交。'}})};
  });
  await p.run('confirmRecharge()');
  assert.match(p.node('resultBox').innerHTML,/使用原卡密，更新 JSON/);
  assert.doesNotMatch(p.node('resultBox').innerHTML,/401|已提交，等待处理/);
  p.run('beginSessionRetry()');
  assert.equal(p.run('currentTaskId'), '');
  assert.equal(p.run('currentOrderId'), '');
  assert.equal(p.run('currentStep'), 2);
  assert.equal(p.node('secretJson').value,'');
  assert.equal(p.run('currentParsedSecret'),null);
  assert.equal(p.memory.size,0);
  assert.equal(p.node('cardInfo').value,'HPLUS'+'A'.repeat(32));
  assert.deepEqual(paths,['/api/recharge/confirm']);
});

test('explicitly released prior submission restores the original card after a lost response',async()=>{
  const p=page(async()=>({text:async()=>JSON.stringify({success:true,data:{status:'failed',statusLabel:'可重新提交',canRecharge:true,canRetry:true,
    hasPriorSubmission:true,actionRequired:'update_session',message:'账号授权已失效，请获取新的 Session JSON，使用原卡密重新提交。'}})}));
  p.run('setSubmissionPending(true);currentTaskId="old-order";currentOrderId="old-order"');
  assert.equal(await p.run('queryCardStatusFromInput()'),true);
  assert.equal(p.run('currentTaskId'),'');
  assert.equal(p.run('currentOrderId'),'');
  assert.equal(p.run('submissionPending'),false);
  assert.match(p.node('step1Notice').innerHTML,/授权已失效/);
  assert.doesNotMatch(p.node('step1Notice').innerHTML,/等待人工核查/);
});
