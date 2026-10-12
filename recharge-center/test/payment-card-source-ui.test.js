import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('origin controls show missing channels, distinct choices and escape custom labels',()=>{
  const context=vm.createContext({window:{}});
  vm.runInContext(fs.readFileSync(new URL('../admin/payment-card-source-ui.js',import.meta.url),'utf8'),context);
  const ui=context.window.paymentCardSourceUI;
  const missing=ui.row({kind:'manual',uid:'manual:fixture',lastFour:'4242',sourceLabel:'未标注',sourceMissing:true});
  assert.match(missing,/未标注 · 选择渠道/);
  assert.match(missing,/origin-missing/);
  for(const name of ['天空','ZZS / 吱吱鼠','其他渠道…'])assert.ok(missing.includes(name));
  const sky=ui.row({kind:'manual',uid:'manual:fixture',lastFour:'4242',sourceLabel:'天空'});
  assert.match(sky,/value="天空" selected/);
  assert.match(sky,/origin-sky/);
  assert.doesNotMatch(sky,/手动导入/);
  assert.match(ui.row({kind:'manual',uid:'fixture',sourceLabel:'<script>fixture</script>'}),/&lt;script&gt;/);
  const select={value:''},custom={value:''};
  ui.bindImport(select,custom);
  assert.equal(custom.hidden,true);
  assert.throws(()=>ui.importSource(select,custom),/请选择卡片来源/);
  select.value='天空';assert.equal(ui.importSource(select,custom),'天空');
  select.value='__custom__';select.onchange();assert.equal(custom.hidden,false);assert.equal(custom.required,true);
  assert.throws(()=>ui.importSource(select,custom),/请选择卡片来源/);
  custom.value='其他真实来源';assert.equal(ui.importSource(select,custom),'其他真实来源');
});
