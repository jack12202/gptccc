import {paymentCardTrace,readPaymentCardTrace} from './payment-card-trace.js';
const pending=new Set(['failed','needs_review','processing','manual_queued','manual_processing','needs_info']);
const reject=message=>({ok:false,status:409,message});
export function createRecoveryConfirmation({store,usage,listRecords,listCards}){
 usage.db.exec('CREATE TABLE IF NOT EXISTS recovery_confirmation_uses (order_key TEXT PRIMARY KEY, entry_json TEXT NOT NULL)');
 const booking=key=>{const row=usage.db.prepare('SELECT entry_json FROM recovery_confirmation_uses WHERE order_key=?').get(key);return row?JSON.parse(row.entry_json):null;};
 function context(id){
  const primary=store.getOrder(id),native=usage.order(id)||(primary?.provider==='zzshu'?usage.order(primary.upstreamTaskId):null);
  const records=listRecords();const record=records.find(row=>row.id===id);
  if(!record)return null;
  const trace=native?readPaymentCardTrace(native.payment_card_snapshot):readPaymentCardTrace(primary?.paymentCardSnapshot)||record.paymentCardTrace;
  const uid=trace?(trace.kind==='h'?'h:':'manual:')+trace.cardId:'';
  return {id,primary,native,record,trace,originalUid:uid,key:native?.id||id};
 }
 function canConfirm(c){return Boolean(c&&(c.record.plan||'plus')==='plus'&&!c.record.workbenchHandledAt&&!c.record.supersededBy&&pending.has(c.record.status));}
 function options(id){
  const c=context(id);if(!c)return {ok:false,status:404,message:'订单不存在。'};
  return {ok:true,status:200,data:{orderId:id,canConfirm:canConfirm(c),completed:c.record.status==='success',
   original:c.trace?{uid:c.originalUid,lastFour:c.trace.lastFour,source:c.trace.source}:null,
   cards:listCards().filter(card=>card.enabled&&!card.paused&&!card.occupied&&card.remaining>0&&!card.proProtected&&!card.pro5xSelected).map(card=>({uid:card.uid,lastFour:card.lastFour,source:card.sourceLabel||card.source,remaining:card.remaining}))}};
 }
 function confirm(id,body={}){
  if(!['original','other','external'].includes(body.choice))return {ok:false,status:400,message:'请选择实际使用的支付卡或其他渠道。'};
  let c=context(id);if(!c)return {ok:false,status:404,message:'订单不存在。'};
  const uid=body.choice==='original'?c.originalUid:body.choice==='other'?String(body.cardUid||''):'';
  if(body.choice==='other'&&uid===c.originalUid)return {ok:false,status:400,message:'使用原卡时请选择“使用原卡”。'};
  if(body.choice!=='external'&&!uid)return {ok:false,status:400,message:'请选择实际使用的支付卡。'};
  const previous=booking(c.key);
  if(previous&&(previous.choice!==body.choice||previous.cardUid!==uid))return reject('该订单已经确认，请勿更换用卡重复记账。');
  if(c.record.status==='success'&&!previous)return {ok:true,status:200,data:{orderId:id,status:'success',alreadyConfirmed:true}};
  if(!previous&&!canConfirm(c))return reject('订单已处理、已结案或已有更新的提交，请刷新后核对。');
  if(c.primary?.submissionInFlight||c.native?.status==='submitting'||c.native?.status==='reserved')return reject('充值请求尚在提交，请等待返回后确认。');
  const state=store.read(),primary=state.orders.find(order=>order.id===c.primary?.id);
  const customer=state.hCards.find(card=>card.id===c.record.customerCardId||card.id===primary?.hCardId);
  if(!previous&&customer&&(customer.disabledAt||customer.archivedAt||customer.status==='used'||customer.orderId&&![id,c.native?.id].includes(customer.orderId)))return reject('客户卡密状态已变化，请核对最新订单。');
  let entry;
  try{entry=usage.transaction(()=>{
    const existing=booking(c.key);if(existing)return existing;
    const native=c.native?usage.order(c.native.id):null;
    if(native){const voucher=usage.voucherForOrder(native.id),latest=usage.db.prepare('SELECT id FROM orders WHERE voucher_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(native.voucher_id);
      if(native.workbench_handled_at||native.status==='success'||!pending.has(native.status)||voucher.status==='used'||voucher.order_id&&voucher.order_id!==native.id||latest?.id!==native.id)throw Error('卡密已有更新的处理结果，请刷新核对。');}
    let selected,ownFrozen=false,hFrozen=false,alreadyConsumed=false;
    if(uid){
      const available=listCards();selected=available.find(card=>card.uid===uid);
      const original=body.choice==='original';
      const originalUsageId=native?.card_id||(uid.startsWith('h:')?usage.hifupayUsage(uid.slice(2))?.id:c.trace?.usageId);
      const raw=original?usage.db.prepare('SELECT * FROM payment_cards WHERE id=?').get(originalUsageId):null;
      if(!selected&&original&&raw)selected={usageId:raw.id,lastFour:raw.last_four,sourceLabel:c.trace.source};
      if(!selected?.usageId)throw Error('支付卡不存在，请选择其他卡或其他渠道。');
      const current=usage.db.prepare('SELECT * FROM payment_cards WHERE id=?').get(selected.usageId);
      ownFrozen=Boolean(original&&native&&native.card_id===current?.id&&native.use_resolution==='frozen');
      hFrozen=Boolean(original&&uid.startsWith('h:')&&usage.db.prepare('SELECT 1 FROM h_frozen_claims WHERE hifupay_id=? AND order_id=?').get(uid.slice(2),id));
      alreadyConsumed=Boolean(original&&native?.use_resolution==='consumed');
      if(!current||(!ownFrozen&&!hFrozen&&!alreadyConsumed&&(!current.enabled||current.paused||current.retired_at||(!original&&(selected.occupied||selected.proProtected||selected.pro5xSelected))||current.max_success-current.success_count-current.h_success_count-current.frozen_count<1)))throw Error('支付卡不可用或剩余次数不足，请重新选择。');
      if(ownFrozen||hFrozen)usage.db.prepare('UPDATE payment_cards SET frozen_count=MAX(0,frozen_count-1) WHERE id=?').run(current.id);
      if(!alreadyConsumed)usage.db.prepare('UPDATE payment_cards SET success_count=success_count+1 WHERE id=?').run(current.id);
      if(original&&uid.startsWith('h:')){
        usage.db.prepare('DELETE FROM h_frozen_claims WHERE hifupay_id=? AND order_id=?').run(uid.slice(2),id);
        usage.db.prepare('DELETE FROM h_card_claims WHERE hifupay_id=? AND order_id=?').run(uid.slice(2),id);
      }
    }
    const result={choice:body.choice,cardUid:uid,usageId:selected?.usageId||'',lastFour:selected?.lastFour||'',source:selected?.sourceLabel||selected?.source||'',uses:uid?1:0,confirmedAt:new Date().toISOString()};
    if(native){
      usage.db.prepare("UPDATE orders SET status='success',completed_at=CASE WHEN completed_at='' THEN ? ELSE completed_at END,auto_query=0,admin_frozen=0,retry_allowed=0,manual_payment_use=?,use_resolution=?,review_reason='管理员确认已在外部完成充值',updated_at=? WHERE id=?")
       .run(result.confirmedAt,JSON.stringify(result),body.choice==='original'?'consumed':native.use_resolution,result.confirmedAt,native.id);
      usage.db.prepare("UPDATE vouchers SET status='used',order_id=? WHERE id=?").run(native.id,native.voucher_id);
    }
    usage.db.prepare('INSERT INTO recovery_confirmation_uses(order_key,entry_json) VALUES(?,?)').run(c.key,JSON.stringify(result));
    usage.audit(c.key,'external_recharge_confirmed',JSON.stringify(result));return result;
  });}catch(error){return reject(error.message);}
  // The SQLite booking survives a JSON write failure, so a retry completes the mirror without a second debit.
  if(primary){Object.assign(primary,{status:'success',paymentConfirmed:true,completedAt:primary.completedAt||entry.confirmedAt,manualPaymentUse:entry,manualCompletedBy:'admin',subscriptionActionRequired:false,subscriptionActionHandledAt:entry.confirmedAt,message:'管理员确认已完成充值。',updatedAt:entry.confirmedAt});
    if(entry.choice==='original')for(const card of state.hifupayCards)card.inFlightOrders=(card.inFlightOrders||[]).filter(row=>row.orderId!==primary.id);
  }
  if(customer){customer.status='used';customer.usedAt ||= entry.confirmedAt;customer.updatedAt=entry.confirmedAt;}
  if(primary||customer)store.write(state);
  return {ok:true,status:200,data:{orderId:id,status:'success',manualPaymentUse:entry}};
 }
 return {options,confirm};
}
