import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('all TXT exports share Beijing generation date, sanitized channel and last four with collision protection',()=>{
 const context=vm.createContext({window:{}});
 vm.runInContext(fs.readFileSync(new URL('../admin/card-download-names.js',import.meta.url),'utf8'),context);
 const names=context.window.cardDownloadNames.files([
  {sequence:7,createdAt:'2026-10-13T16:01:00Z',source:'微信',code:'HPLUS7E3E'},
  {sequence:7,createdAt:'2026-10-13T16:01:00Z',source:'微信',code:'OTHER7E3E'},
  {createdAt:'2026-10-13T15:59:00Z',source:'代理/公司',code:'HPLUS5CD6'},
  {createdAt:'bad',source:'',code:'HPLUS1234'}]);
 assert.deepEqual(Array.from(names),['007-20261014-微信-7E3E.txt','007-20261014-微信-7E3E-2.txt','无序号-20261013-代理-公司-5CD6.txt','无序号-日期未知-未分类-1234.txt']);
 for(const name of names)assert.equal(/[\\/:*?"<>|]/.test(name),false);
});

test('filtered exports preserve original sequence rather than renumber selected rows',()=>{
 const context=vm.createContext({window:{}});vm.runInContext(fs.readFileSync(new URL('../admin/card-download-names.js',import.meta.url),'utf8'),context);
 const cards=[{sequence:2,code:'CODE0002',source:'卡网',createdAt:'2026-10-19'},{sequence:10,code:'CODE0010',source:'卡网',createdAt:'2026-10-19'}];
 const names=Array.from(context.window.cardDownloadNames.files(cards));assert.match(names[0],/^002-/);assert.match(names[1],/^010-/);
 assert.equal(context.window.cardDownloadNames.files([cards[1]])[0],names[1]);
});

test('batch inventory sorts original sequence before per-card timestamps, including after status filtering',async()=>{
 const {buildCardInventory}=await import('../src/customer-card-inventory.js');
 const cards=[{id:'a',batchId:'batch',sequence:1,status:'unused',code:'CODE0001',plan:'plus',createdAt:'2026-10-19T01:00:00Z'},
 {id:'b',batchId:'batch',sequence:2,status:'used',code:'CODE0002',plan:'plus',createdAt:'2026-10-19T01:00:01Z'},
 {id:'c',batchId:'batch',sequence:3,status:'unused',code:'CODE0003',plan:'plus',createdAt:'2026-10-19T01:00:02Z'}];
 assert.deepEqual(buildCardInventory(cards,[],{batch:'batch',view:'all'}).items.map(c=>c.sequence),[1,2,3]);
 assert.deepEqual(buildCardInventory(cards,[],{batch:'batch'}).items.map(c=>c.sequence),[1,3]);
});
