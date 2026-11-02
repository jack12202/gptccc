export function shanghaiDay(input) {
  const date=new Date(input);
  return input && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(date):'';
}
const normalized=value=>String(value||'').trim().toUpperCase();
const byPlan=rows=>Object.fromEntries(['plus','pro_x5','pro_x20'].map(plan=>[plan,rows.filter(row=>(row.plan||'plus')===plan).length]));
export function buildDailyActivity(records,customerCards,now=new Date()) {
  const today=shanghaiDay(now),logical=records.filter(order=>!order.supersededBy);
  const successes=logical.filter(order=>!order.workbenchHandledAt && order.status==='success' && shanghaiDay(order.completedAt)===today);
  const submitted=logical.filter(order=>shanghaiDay(order.createdAt)===today);
  const cardsById=new Map(customerCards.map(card=>[card.id,card])),cardsByCode=new Map(customerCards.filter(card=>card.code).map(card=>[normalized(card.code),card]));
  const redemptions=new Map();
  const key=card=>card.code?'code:'+normalized(card.code):card.id?'id:'+card.id:'';
  function add(card,at,order){
    const id=key(card);if(!id||shanghaiDay(at)!==today)return;
    redemptions.set(id,{...card,id:card.id||'redemption:'+(order?.id||normalized(card.code)),operationalStatus:'used',redeemedAt:at,hasSubmission:true,
      boundEmail:card.boundEmail||order?.userEmail||'',boundAccountId:card.boundAccountId||order?.accountId||'',
      latestOrder:order?{id:order.id,status:order.status,provider:order.provider,plan:order.plan}:null});
  }
  // A card's actual redemption time remains authoritative after it is disabled or archived.
  for(const card of customerCards)if(card.usedAt)add(card,card.usedAt,logical.find(order=>order.customerCardId===card.id&&order.status==='success'));
  for(const order of logical.filter(row=>row.status==='success'&&!row.workbenchHandledAt)){
    const card=cardsById.get(order.customerCardId)||cardsByCode.get(normalized(order.customerCardCode));
    if(card){if(!card.usedAt)add(card,order.completedAt,order);}
    else if(order.customerCardCode||order.customerCardId)add({id:order.customerCardId||'',code:order.customerCardCode||'',cardMask:order.customerCardMask||'',plan:order.plan||'plus',source:order.salesChannel||'未分类',status:'used',createdAt:order.createdAt},order.completedAt,order);
  }
  const redeemed=[...redemptions.values()].sort((a,b)=>String(b.redeemedAt).localeCompare(String(a.redeemedAt)));
  return {day:today,successes,submitted,redeemed,summary:{todaySuccess:successes.length,todayRedeemed:redeemed.length,todaySubmitted:submitted.length,successTimeUnknown:logical.filter(order=>!order.workbenchHandledAt&&order.status==='success'&&!shanghaiDay(order.completedAt)).length,
    todaySuccessByPlan:byPlan(successes),todayRedeemedByPlan:byPlan(redeemed),
    todaySuccessModes:{manual:successes.filter(order=>order.fulfillmentMode==='manual').length,auto:successes.filter(order=>order.fulfillmentMode!=='manual').length}}};
}
