import crypto from 'node:crypto';
import {encryptSecretText} from './utils.js';
import {config} from './config.js';
export function createManualPlusService({store,usage,listCards}) {
  usage.db.exec(`CREATE TABLE IF NOT EXISTS manual_plus_usage(order_id TEXT PRIMARY KEY, card_uid TEXT NOT NULL, usage_id TEXT NOT NULL, uses INTEGER NOT NULL, last_four TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL)`);
  const publicOrder=order=>({orderId:order.id,taskId:order.id,status:order.status,plan:'plus',planLabel:'Plus',provider:'h',providerLabel:'充值服务',canRetry:false,
    completedAt:order.completedAt||'',message:order.status==='success'?'充值成功。':order.status==='needs_info'?'需要补充资料，请联系客服核实。':'已进入充值队列，请稍后，完成后可在本页查询结果。'});
  function submit(code,text,source) {
    let raw;try{raw=JSON.parse(text);}catch{return {ok:false,status:400,message:'请提交完整的 JSON 对象。'};}
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return {ok:false,status:400,message:'请提交完整的 JSON 对象。'};
    const auth=raw.fullAuthData&&typeof raw.fullAuthData==='object'?raw.fullAuthData:raw;
    const email=String(auth.userEmail||auth.user?.email||'').trim(),accountId=String(auth.account?.id||'').trim();
    if(!email&&!accountId)return {ok:false,status:400,message:'资料中缺少账号信息，请重新提交。'};
    const key=config.recoveryEncryptionKey||config.adminToken||'local-development-only';
    const result=store.createProOrder({manualPlus:true,code,identity:{email,accountId},source,
      ciphertext:encryptSecretText(code,key,'recharge-card-info'),session:{userEmail:email,accountId,validForAuto:true,
        rawSecretCiphertext:encryptSecretText(text,key,'recharge-secret-json'),tokenHash:'',authDataCiphertext:''}});
    return result.ok?{ok:true,status:200,data:publicOrder(result.order)}:result;
  }
  const eligible=card=>Boolean(card.usageId&&card.enabled&&!card.paused&&!card.occupied&&!card.proProtected&&!card.pro5xSelected&&card.remaining>0);
  function action(id,operation,body={}) {
    const state=store.read(),order=state.orders.find(o=>o.id===id);
    if(order?.plan!=='plus'||order.fulfillmentMode!=='manual')return {ok:false,status:404,message:'未找到 Plus 人工订单。'};
    const note=String(body.note||'').trim().slice(0,1000);
    if(order.status==='success'&&operation==='mark-success')return {ok:true,status:200,data:publicOrder(order)};
    if(!['manual_queued','manual_processing','needs_info'].includes(order.status))return {ok:false,status:409,message:'订单当前不可人工处理。'};
    const card=state.hCards.find(c=>c.id===order.hCardId);
    if(!card||card.orderId!==id||card.status!=='locked'||card.disabledAt||card.archivedAt)return {ok:false,status:409,message:'客户卡密状态已变化，请核查。'};
    if(operation==='mark-success'){
      const uid=String(body.cardUid||''),uses=uid?Number(body.uses??1):0;
      if(uid&&(!Number.isInteger(uses)||uses<1||uses>100))return {ok:false,status:400,message:'消耗次数必须是 1～100 的整数。'};
      let booking;
      try{booking=usage.transaction(()=>{
        const previous=usage.db.prepare('SELECT * FROM manual_plus_usage WHERE order_id=?').get(id);
        if(previous){if(previous.card_uid!==uid||previous.uses!==uses)throw Error('该订单已记录用卡，请保持原选择重试，避免重复扣次。');return previous;}
        let selected;
        if(uid){selected=listCards().find(c=>c.uid===uid);if(!selected||!eligible(selected))throw Error('所选支付卡不可用、已占用或受保护。');
          const changed=usage.db.prepare('UPDATE payment_cards SET success_count=success_count+? WHERE id=? AND enabled=1 AND paused=0 AND retired_at IS NULL AND max_success-success_count-h_success_count-frozen_count>=?').run(uses,selected.usageId,uses);
          if(changed.changes!==1)throw Error('支付卡剩余次数不足，请调整次数或重新选择。');}
        const entry={order_id:id,card_uid:uid,usage_id:selected?.usageId||'',uses,last_four:selected?.lastFour||'',source:selected?.sourceLabel||'',created_at:new Date().toISOString()};
        usage.db.prepare('INSERT INTO manual_plus_usage VALUES(?,?,?,?,?,?,?)').run(...Object.values(entry));
        usage.audit(id,'manual_plus_confirm',JSON.stringify({cardUid:uid,uses}));return entry;
      });}catch(error){return {ok:false,status:409,message:error.message};}
      order.manualPaymentUse={cardUid:booking.card_uid,usageId:booking.usage_id,uses:booking.uses,lastFour:booking.last_four,source:booking.source};
      Object.assign(order,{status:'success',paymentConfirmed:true,completedAt:new Date().toISOString(),manualCompletedBy:'admin',message:'充值成功。'});
      Object.assign(card,{status:'used',usedAt:order.completedAt,updatedAt:order.completedAt});
    }else if(['manual-processing','needs-info','note'].includes(operation)){
      if(operation!=='note')order.status=operation==='needs-info'?'needs_info':'manual_processing';
    }else return {ok:false,status:400,message:'不支持的操作。'};
    order.processingNote=note||order.processingNote||'';order.updatedAt=new Date().toISOString();
    state.rechargeLogs.push({id:'manual-plus-'+crypto.randomUUID(),orderId:id,step:'plus.admin.'+operation,requestSummary:JSON.stringify(order.manualPaymentUse||{}),responseSummary:'admin',createdAt:order.updatedAt});
    store.write(state);return {ok:true,status:200,data:publicOrder(order)};
  }
  return {submit,action,publicOrder,cards:()=>listCards().filter(eligible).map(c=>({uid:c.uid,lastFour:c.lastFour,source:c.sourceLabel,remaining:c.remaining}))};
}
