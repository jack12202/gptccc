import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

test('customer card library searches partial codes and copies the successful order JSON', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gptc-library-ui-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  process.env.DATA_FILE = path.join(dir, 'orders.json');
  process.env.ADMIN_TOKEN = 'fixture-admin';
  const {server} = await import(`../src/server.js?library-ui=${Date.now()}`);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(base + '/api/admin/login', {method:'POST', headers:{Origin:'https://www.gptc.cc', 'X-Admin-Request':'1', 'Content-Type':'application/json'}, body:JSON.stringify({password:'fixture-admin'})});
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const response = await fetch(base + '/admin/cards/library', {headers:{Cookie:cookie}});
  assert.equal(response.status, 200);
  const html = await response.text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const first = 'HPLUS' + 'A'.repeat(28) + '9D2F';
  const second = 'HPLUS' + 'B'.repeat(28) + '9D2F';
  const third = 'HPLUS' + 'C'.repeat(28) + '1234';
  const cards = [
    {id:'card-a',code:first,plan:'plus',status:'used',source:'fixture',boundEmail:'alice@example.test'},
    {id:'card-b',code:second,plan:'plus',status:'locked',source:'fixture',boundEmail:'bob@example.test'},
    {id:'card-c',code:third,plan:'plus',status:'unused',source:'fixture'}
  ];
  const records = [
    {id:'newer-failed',customerCardId:'card-a',customerCardCode:first,paymentCardLastFour:'9911',provider:'zzshu',status:'failed',createdAt:'2026-09-24T12:00:00Z',hasOriginalJson:true,userEmail:'alice@example.test'},
    {id:'successful',customerCardId:'card-a',customerCardCode:first,paymentCardLastFour:'9911',provider:'zzshu',status:'success',createdAt:'2026-09-23T12:00:00Z',hasOriginalJson:true,userEmail:'alice@example.test'},
    {id:'missing-json',customerCardId:'card-b',customerCardCode:second,hifupayCardLastFour:'5664',provider:'h',status:'failed',createdAt:'2026-09-24T11:00:00Z',hasOriginalJson:false,userEmail:'bob@example.test'}
  ];
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id,{value:'',checked:false,textContent:'',innerHTML:'',style:{},dataset:{},
      classList:{toggle(){}}, addEventListener(name,handler){this[name]=handler}});
    return nodes.get(id);
  };
  const calls = [], clipboard = [];
  const api = async url => {
    calls.push(url);
    if (url.startsWith('/api/admin/h-cards?')) return {cards};
    if (url === '/api/admin/recharge-records') return {records};
    if (url.includes('/api/admin/recoveries/')) return {secretJsonText:'{"fixture":true}'};
    throw Error('unexpected URL');
  };
  const context = vm.createContext({document:{getElementById:element,querySelectorAll:()=>[]},
    window:{adminApi:api,location:{origin:'https://www.gptc.cc'},setTimeout(){}},
    navigator:{clipboard:{writeText:async value=>clipboard.push(value)}},
    URL, Blob, TextEncoder, Uint8Array, console, confirm:()=>true});
  vm.runInContext(script,context);
  await vm.runInContext('loadLibrary()',context);
  assert.equal(calls.filter(url=>url === '/api/admin/recharge-records').length,2);
  element('cardSearch').value = '9d2f';
  vm.runInContext('applyFilter()',context);
  assert.equal(element('libraryCount').textContent,'2 / 3 张');
  assert.match(element('libraryCards').innerHTML,/data-order-id="successful"/);
  assert.doesNotMatch(element('libraryCards').innerHTML,/data-order-id="newer-failed"/);
  assert.match(element('libraryCards').innerHTML,/未留存 JSON/);
  assert.match(element('libraryCards').innerHTML,/\/admin\/recoveries\?cardId=card-a/);
  element('cardSearch').value = second.slice(8,18).toLowerCase();
  vm.runInContext('applyFilter()',context);
  assert.equal(element('libraryCount').textContent,'1 / 3 张');
  element('cardSearch').value = `https://www.gptc.cc/activate/?provider=h&card=${first}`;
  vm.runInContext('applyFilter()',context);
  assert.equal(element('libraryCount').textContent,'1 / 3 张');
  element('cardSearch').value = 'alice@';
  vm.runInContext('applyFilter()',context);
  assert.equal(element('libraryCount').textContent,'1 / 3 张');
  await element('libraryCards').click({target:{closest:()=>({dataset:{cardAction:'copy-json',orderId:'successful'}})}});
  assert.deepEqual(clipboard,['{"fixture":true}']);
  await element('libraryCards').click({target:{closest:()=>({dataset:{cardAction:'copy-link',cardCode:first}})}});
  assert.equal(clipboard[1],`https://www.gptc.cc/activate/?provider=h&card=${first}`);

  const orderResponse = await fetch(base + '/admin/recoveries', {headers:{Cookie:cookie}});
  assert.equal(orderResponse.status,200);
  const orderScript = (await orderResponse.text()).match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(orderScript);
  const orderNodes = new Map();
  const orderElement = id => {
    if (!orderNodes.has(id)) orderNodes.set(id,{value:'',checked:false,textContent:'',innerHTML:'',style:{},disabled:false,
      classList:{toggle(){}},addEventListener(name,handler){this[name]=handler}});
    return orderNodes.get(id);
  };
  const orderContext = vm.createContext({document:{getElementById:orderElement},URLSearchParams,console,
    window:{location:{search:'?cardId=card-a'},history:{replaceState(){}},setInterval(){},adminApi:async()=>({records})}});
  vm.runInContext(orderScript,orderContext);
  await vm.runInContext('loadRecoveries()',orderContext);
  assert.equal(orderElement('recoveryCount').textContent,'2 / 3 条');
  assert.match(orderElement('recoveries').innerHTML,new RegExp(first));
  assert.match(orderElement('recoveries').innerHTML,/\*\*\*\*9911/);
  assert.doesNotMatch(orderElement('recoveries').innerHTML,/bob@example.test|\*\*\*\*5664/);
  orderElement('clearCardOrderFilter').click();
  assert.equal(orderElement('recoveryCount').textContent,'3 / 3 条');
  orderElement('recordSearch').value='9d2f';
  vm.runInContext('applyRecordFilters()',orderContext);
  assert.equal(orderElement('recoveryCount').textContent,'3 / 3 条');
});
