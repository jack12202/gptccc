import {needsWorkbenchAttention} from "./admin-workbench.js";
const text=value=>String(value||"").trim().toLowerCase();
const localDay=value=>value?new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date(value)):"";
const activeStatuses=new Set(["locked","reserved","processing","queued","submitting"]);
const orderSummary=order=>order?{id:order.id,status:order.status,provider:order.provider,userEmail:order.userEmail||"",
  accountId:order.accountId||"",createdAt:order.createdAt,hasOriginalJson:Boolean(order.hasOriginalJson),retryAllowed:Boolean(order.retryAllowed)}:null;

export function inventoryCard(card,orders=[],now=new Date()) {
  const history=[...orders].sort((a,b)=>String(b.createdAt||"").localeCompare(String(a.createdAt||"")));
  const latest=history[0],successful=history.find(order=>order.status==="success");
  const bound=Boolean(card.hasSubmission||card.boundEmail||card.boundAccountId||card.boundAt||card.orderId||history.length||activeStatuses.has(card.status));
  const expired=card.status==="expired"||Boolean(card.expiresAt&&Date.parse(card.expiresAt)<=now.getTime());
  let group,label;
  if(card.archivedAt){group="archived";label="已归档";}
  else if(card.status==="used"||successful){group="used";label=card.status==="disabled"?"已使用 / 已禁用":"已使用";}
  else if(bound){
    group="attention";
    label=card.status==="disabled"?"已禁用 / 已绑定":expired?"已过期 / 已绑定":
      latest?.status==="needs_review"||latest?.status==="failed"&&needsWorkbenchAttention(latest)?"待核查":
      activeStatuses.has(card.status)||["processing","queued","submitting","manual_queued","manual_processing","needs_info"].includes(latest?.status)?"处理中":
      card.status==="unused"?"已绑定 / 原账号可重试":"已绑定";
  }else if(card.status==="disabled"){group="other";label="已禁用";}
  else if(expired){group="other";label="已过期";}
  else if(card.expiresAt&&!Number.isFinite(Date.parse(card.expiresAt))){group="other";label="有效期需核查";}
  else if(!["plus","pro_x5","pro_x20"].includes(card.plan)){group="other";label="套餐需核查";}
  else if(card.status==="unused"&&card.code){group="unused";label="未使用 / 可发放";}
  else{group="other";label=card.status==="unused"?"卡密无法读取":"需核查";}
  return {...card,hasSubmission:bound,group,statusLabel:label,
    boundEmail:card.boundEmail||latest?.userEmail||"",boundAccountId:card.boundAccountId||latest?.accountId||"",
    latestOrder:orderSummary(latest),preferredOrder:orderSummary(successful||latest),orderCount:history.length};
}

export function buildCardInventory(cards,records,query={},now=new Date()) {
  const byCard=new Map();
  for(const order of records){if(!order.customerCardId)continue;const rows=byCard.get(order.customerCardId)||[];rows.push(order);byCard.set(order.customerCardId,rows);}
  const all=cards.map(card=>inventoryCard(card,byCard.get(card.id)||[],now)).sort((a,b)=>
    String(b.createdAt||"").localeCompare(String(a.createdAt||""))||
    (a.batchId===b.batchId?(Number(a.sequence)||0)-(Number(b.sequence)||0):0));
  let keyword=text(query.search);
  try{const url=new URL(keyword);keyword=text(url.searchParams.get("card")||url.searchParams.get("code")||keyword);}catch{}
  const filtered=all.filter(card=>(!query.plan||card.plan===query.plan)&&(!query.source||card.source===query.source)&&
    (!query.batch||card.batchId===query.batch)&&(!query.date||localDay(card.createdAt)===query.date)&&
    (!keyword||[card.code,card.cardMask,card.boundEmail,card.boundAccountId,card.latestOrder?.id].some(value=>text(value).includes(keyword))));
  const view=["unused","attention","used","all","archived"].includes(query.view)?query.view:"unused";
  const selectedIds=query.ids?new Set(String(query.ids).split(",").slice(0,100)):null;
  const visible=filtered.filter(card=>(view==="all"?card.group!=="archived"||query.archived==="1":card.group===view)&&(!selectedIds||selectedIds.has(card.id)));
  const size=Math.min(100,Math.max(1,Number.parseInt(query.size,10)||20)),pages=Math.max(1,Math.ceil(visible.length/size));
  const page=Math.min(pages,Math.max(1,Number.parseInt(query.page,10)||1));
  const batches=new Map();
  for(const card of all)if(card.batchId&&!batches.has(card.batchId))batches.set(card.batchId,{id:card.batchId,source:card.source,createdAt:card.createdAt,size:card.batchSize});
  const unused=all.filter(card=>card.group==="unused");
  return {view,items:visible.slice((page-1)*size,page*size),matched:visible.length,page,pages,pageSize:size,
    counts:Object.fromEntries(["unused","attention","used","other","archived","all"].map(group=>[group,filtered.filter(card=>group==="all"?card.group!=="archived":card.group===group).length])),
    stock:Object.fromEntries(["plus","pro_x5","pro_x20"].map(plan=>[plan,unused.filter(card=>card.plan===plan).length])),
    sources:[...new Set(all.map(card=>card.source).filter(Boolean))].sort(),batches:[...batches.values()]};
}
