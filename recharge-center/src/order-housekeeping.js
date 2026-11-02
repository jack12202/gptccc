export const orderRetentionMs=24*60*60*1000;
export const housekeepingReason='超过 24 小时，按管理员设置自动结案；仅移出待办，原占用和次数不变，JSON 和历史保留';
export function isExpiredOrder(order,now=Date.now()){
  const created=Date.parse(order.createdAt);
  return !order.workbenchHandledAt && !order.submissionInFlight && Number.isFinite(created) && created<=now-orderRetentionMs &&
    ['failed','needs_review','manual_queued','manual_processing','needs_info','processing','queued'].includes(order.status);
}
// Attempts stay in history. Only the most recent attempt for an account + customer voucher is actionable.
export function annotateRepeatedOrders(records){
  const key=order=>{
    const account=String(order.userEmail||order.accountId||'').trim().toLowerCase();
    const card=String(order.customerCardCode||order.customerCardId||order.submissionCodeHash||'').trim().toUpperCase();
    return account&&card?JSON.stringify([account,card]):'order:'+order.id;
  };
  const latest=new Map();
  for(const order of records){const k=key(order),previous=latest.get(k);if(!previous || String(order.createdAt||'')>String(previous.createdAt||''))latest.set(k,order);}
  const attempts=new Map();
  for(const order of records){const k=key(order);if(!attempts.has(k))attempts.set(k,[]);attempts.get(k).push({id:order.id,status:order.workbenchOriginalStatus||order.status,createdAt:order.createdAt,hasOriginalJson:Boolean(order.hasOriginalJson)});}
  return records.map(order=>latest.get(key(order)).id===order.id?{...order,submissionAttempts:attempts.get(key(order))}:{...order,supersededBy:latest.get(key(order)).id});
}
