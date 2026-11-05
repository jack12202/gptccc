import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function page(fetch) {
  const html = fs.readFileSync(new URL('../../activate/index.html', import.meta.url), 'utf8');
  const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(m=>m[1]).find(s=>s.includes('let currentStep'));
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value:'', textContent:'', style:{}, dataset:{}, checked:true, disabled:false,
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
  return {node,context,memory,timers,run:code=>vm.runInContext(code,context)};
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
  assert.match(p.node('resultBox').innerHTML,/复制充值链接/);
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


test('completed lookup identifies account, plan and Beijing completion time', async () => {
  const p = page(async () => ({text:async()=>JSON.stringify({success:true,data:{status:'success',canRecharge:false,
    boundAccount:'a***@example.com',plan:'plus',completedAt:'2026-10-10T13:30:00Z'}})}));
  await p.run('queryCardStatusFromInput()');
  assert.match(p.node('step1Notice').innerHTML,/a\*\*\*@example.com · Plus 充值成功/);
  assert.match(p.node('step1Notice').innerHTML,/21:30:00/);
  assert.match(p.node('step1Notice').innerHTML,/北京时间/);
  assert.match(p.run('completionTime("")'),/未记录/);
});

test('verified plan badge distinguishes all three plans', () => {
  const p = page(async()=>{});
  for (const [plan,label] of [['plus','Plus'],['pro_x5','Pro 5x'],['pro_x20','Pro 20x']]) {
    p.run(`currentPlan=${JSON.stringify(plan)};updateVerifiedCardDisplay("fixture")`);
    assert.equal(p.node('verifiedPlan').textContent,label);
    assert.equal(p.node('verifiedPlan').dataset.plan,plan);
    assert.equal(p.node('confirmPlan').textContent,label);
  }
});


test('incognito retry copies only a recharge link, restores the original card and clears the address fragment',async()=>{
  const p=page(async()=>{throw Error('no request expected before verification');});
  p.run('currentProvider="zzshu"');
  const link=p.run('sessionRetryLink()');
  const url=new URL(link);
  assert.equal(url.search,'');
  assert.equal(url.pathname,'/activate/');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('retryCard'),p.node('cardInfo').value);
  assert.equal(link.includes('fixture'),false);
  p.context.navigator.clipboard={writeText:async text=>{assert.equal(text,link);}};
  p.run('renderRetryBox({canRetry:true,actionRequired:"update_session"})');
  const content=p.node('resultBox').innerHTML;
  assert.match(content,/① 打开无痕窗口/);
  assert.match(content,/② 复制充值链接/);
  assert.doesNotMatch(content,/<details[^>]* open/);
  await p.run('copySessionRetryLink(document.getElementById("copyButton"))');
  assert.equal(p.node('copyButton').textContent,'已复制充值链接');
  p.node('cardInfo').value='';
  let cleaned='';
  p.context.window.location={search:'',hash:url.hash,pathname:'/activate/'};
  p.context.window.history={replaceState:(_a,_b,value)=>{cleaned=value;}};
  p.run('applyCardFromQuery()');
  assert.equal(p.node('cardInfo').value,'HPLUS'+'A'.repeat(32));
  assert.equal(p.run('currentProvider'),'zzshu');
  assert.equal(cleaned,'/activate/');
});


test('retryable expiry clears old task lock and allows same-browser submission with fresh JSON',async()=>{
  const p=page(async()=>({text:async()=>JSON.stringify({success:false,data:{orderId:'expired-task',canRetry:true,actionRequired:'update_session'}})}));
  await p.run('confirmRecharge()');
  assert.equal(p.run('currentTaskId'),'');
  assert.equal(p.run('currentOrderId'),'');
  assert.equal(p.run('submissionPending'),false);
  assert.equal(p.node('confirmRechargeBtn').textContent,'确认充值');
  assert.match(p.node('resultBox').innerHTML,/onclick="beginSessionRetry\(\)">重新提交/);
  p.run('beginSessionRetry()');
  assert.equal(p.run('currentStep'),2);
  assert.equal(p.node('secretJson').value,'');
  assert.equal(p.node('cardInfo').value,'HPLUS'+'A'.repeat(32));
  p.run('currentParsedSecret={userEmail:"first@example.test",fullAuthData:{}};document.getElementById("overwriteRecharge").checked=true;updateConfirmButtonState()');
  assert.equal(p.node('confirmRechargeBtn').disabled,false);
});

test('copied retry link verifies original card and enters fresh session step without old failure panel',async()=>{
  const paths=[];
  const p=page(async path=>{
    paths.push(path);
    return {text:async()=>JSON.stringify(path.endsWith('h-card-status')
      ? {success:true,data:{status:'failed',canRetry:true,canRecharge:true,actionRequired:'update_session'}}
      : {success:true,data:{success:true,provider:'zzshu',plan:'plus'}})};
  });
  p.context.window.location={search:'',hash:'#retryCard=HPLUS'+ 'A'.repeat(32)+'&provider=zzshu',pathname:'/activate/'};
  p.run('applyCardFromQuery()');
  p.timers.shift()();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(paths,['/api/recharge/h-card-status','/api/recharge/verify-card']);
  assert.equal(p.run('currentStep'),2);
  assert.equal(p.node('resultBox').innerHTML,undefined);
  assert.equal(p.run('currentTaskId'),'');
});
