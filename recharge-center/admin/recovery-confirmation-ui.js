(() => {
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const drafts=new Map(),busy=new Set();
 const style=document.createElement('style');style.textContent=`
.quick-recharge{margin:12px 0 14px;padding:16px;border:1px solid #cfe3da;border-radius:12px;background:#f6fbf8;color:#19332e}.quick-recharge h3{margin:0 0 12px;font-size:18px}.quick-recharge .quick-account{font-weight:650;overflow-wrap:anywhere;margin:0 0 10px}.quick-recharge .quick-caption{color:#708079;font-size:12px;margin:8px 0}.quick-recharge form{display:block;width:100%}.quick-recharge .quick-choices{display:grid;gap:8px;margin:14px 0}.quick-recharge .quick-choice{display:flex;align-items:center;gap:9px;padding:10px 12px;background:#fff;border:1px solid #dbe7e2;border-radius:8px;font-size:14px;font-weight:500;margin:0}.quick-recharge input[type=radio]{width:16px;height:16px;min-height:16px;padding:0;margin:0;flex:none;accent-color:#08785c}.quick-recharge select{width:100%;max-width:100%;padding:10px;background:#fff;border:1px solid #cddbd5;border-radius:8px;font:inherit;margin-top:8px}.quick-recharge .quick-submit{width:100%;min-height:44px;background:#08785c;color:#fff;border:1px solid #08785c;border-radius:8px;padding:10px 14px;font:inherit;font-weight:650}.quick-recharge button:disabled{opacity:.5}.quick-recharge .quick-copy{min-height:36px;padding:7px 12px;background:#fff;color:#08785c;border:1px solid #b6d9cc;border-radius:7px;font:inherit}.quick-recharge .quick-message{white-space:pre-wrap;color:#08785c;font-size:13px;margin-top:10px}.quick-recharge .quick-message.error{color:#b63143}.recovery-advanced{border-top:1px solid #dbe7e2;margin-top:18px;padding-top:14px}.recovery-advanced>summary{cursor:pointer;font-size:14px;font-weight:600;color:#64748b;margin-bottom:14px}.recovery-advanced:not([open])>*:not(summary){display:none}`;
 document.head.append(style);
 async function mount(host,record,{onSaved=async()=>{}}={}){
  if(!host)return;
  host.innerHTML='<section class="quick-recharge"><h3>确认充值结果</h3><p class="quick-caption">正在读取可用支付卡…</p></section>';
  let data;
  try{data=await window.adminApi('/api/admin/recoveries/'+encodeURIComponent(record.id)+'/confirmation');}
  catch(error){if(host.isConnected)host.innerHTML='<section class="quick-recharge"><h3>确认充值结果</h3><p>'+esc(error.message)+'</p><button type="button" class="quick-copy" data-retry>重试读取</button></section>';host.querySelector('[data-retry]')?.addEventListener('click',()=>mount(host,record,{onSaved}));return;}
  if(!host.isConnected)return;
  const original=data.original,choice=drafts.get(record.id)||{choice:original?'original':'external',cardUid:''};
  const option=card=>'<option value="'+esc(card.uid)+'">•••• '+esc(card.lastFour)+' · '+esc(card.source)+' · 剩余 '+card.remaining+' 次</option>';
  const canConfirm=data.canConfirm;
  const actual=record.manualPaymentUse;
  const actualText=actual?(actual.cardUid?'实际用卡：•••• '+actual.lastFour+' · '+actual.source+' · 已记录 '+actual.uses+' 次':'实际用卡：其他渠道 / 未记录支付卡，不扣本站次数。'):'';
  host.innerHTML='<section class="quick-recharge"><h3>'+(data.completed?'已确认充值成功':'确认充值结果')+'</h3><p class="quick-account">'+esc(record.userEmail||'未知账号')+' · Plus</p>'+(record.hasOriginalJson?'<button type="button" class="quick-copy" data-copy>复制原始 JSON</button>':'<span class="quick-caption">未留存原始 JSON</span>')+
   (canConfirm?'<form><div class="quick-choices">'+(original?'<label class="quick-choice"><input type="radio" name="choice" value="original">使用原卡：•••• '+esc(original.lastFour)+' · '+esc(original.source)+'</label>':'')+'<div><label class="quick-choice"><input type="radio" name="choice" value="other">换其他支付卡</label><select name="cardUid" aria-label="实际使用的支付卡"><option value="">请选择实际使用的支付卡</option>'+data.cards.filter(card=>card.uid!==original?.uid).map(option).join('')+'</select></div><label class="quick-choice"><input type="radio" name="choice" value="external">其他渠道 / 不记录支付卡</label></div><p class="quick-caption" data-effect></p><button class="quick-submit" type="submit">确认已充值成功</button><p class="quick-caption">只登记已完成的结果，不会再次发起充值。</p></form>':'<p class="quick-caption">'+(data.completed?(actualText?esc(actualText)+'<br>':'')+'订单和客户卡密已同步完成，无需重复确认。':'当前订单已结案、已有更新提交或暂不可确认，可展开高级详情查看。')+'</p>')+'<div class="quick-message" role="status" aria-live="polite"></div></section>';
  const message=(text,error=false)=>{const el=host.querySelector('.quick-message');if(el){el.textContent=text;el.classList.toggle('error',error);}};
  host.querySelector('[data-copy]')?.addEventListener('click',async event=>{
   event.currentTarget.disabled=true;
   try{const detail=await window.adminApi('/api/admin/recoveries/'+encodeURIComponent(record.id)+'?reveal=1');if(!detail.secretJsonText)throw Error('原始 JSON 无法读取。');await navigator.clipboard.writeText(detail.secretJsonText);message('原始 JSON 已复制。');}catch(error){message(error.message,true);}finally{host.querySelector('[data-copy]')?.removeAttribute('disabled');}
  });
  const form=host.querySelector('form');if(!form)return;
  const select=form.querySelector('select');
  const savedRadio=form.querySelector('input[value="'+choice.choice+'"]');if(savedRadio)savedRadio.checked=true;
  select.value=choice.cardUid;
  function sync(){const current=form.querySelector('input:checked')?.value||'external';select.hidden=current!=='other';select.disabled=current!=='other';select.required=current==='other';drafts.set(record.id,{choice:current,cardUid:select.value});form.querySelector('[data-effect]').textContent=current==='original'?(record.useResolution==='frozen'?'原卡已有冻结转为已用，不重复扣次。':'记录原卡使用 1 次。'):current==='other'?'所选卡记 1 次；原卡冻结保持不变。':'不扣本站支付卡次数，原冻结保持不变。';}
  form.addEventListener('change',sync);sync();
  form.onsubmit=async event=>{event.preventDefault();if(busy.has(record.id)||!form.reportValidity())return;busy.add(record.id);const submit=form.querySelector('[type=submit]');submit.disabled=true;submit.textContent='正在确认…';
   try{const current=drafts.get(record.id);await window.adminApi('/api/admin/recoveries/'+encodeURIComponent(record.id)+'/confirm-success',{method:'POST',body:JSON.stringify(current)});drafts.delete(record.id);message('已确认成功，订单和卡密已同步。');await onSaved();}
   catch(error){message(error.message||'保存失败，请刷新核对后重试。',true);}finally{busy.delete(record.id);if(submit.isConnected){submit.disabled=false;submit.textContent='确认已充值成功';}}
  };
 }
 window.recoveryConfirmationUI={mount};
})();
