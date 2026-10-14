import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
test('all TXT exports share Beijing generation date, sanitized channel and last four with collision protection',()=>{
 const context=vm.createContext({window:{}});
 vm.runInContext(fs.readFileSync(new URL('../admin/card-download-names.js',import.meta.url),'utf8'),context);
 const names=context.window.cardDownloadNames.files([
  {createdAt:'2026-10-13T16:01:00Z',source:'微信',code:'HPLUS7E3E'},
  {createdAt:'2026-10-13T16:01:00Z',source:'微信',code:'OTHER7E3E'},
  {createdAt:'2026-10-13T15:59:00Z',source:'代理/公司',code:'HPLUS5CD6'},
  {createdAt:'bad',source:'',code:'HPLUS1234'}]);
 assert.deepEqual(Array.from(names),['20261014-微信-7E3E.txt','20261014-微信-7E3E-2.txt','20261013-代理-公司-5CD6.txt','日期未知-未分类-1234.txt']);
 for(const name of names)assert.equal(/[\\/:*?"<>|]/.test(name),false);
});
