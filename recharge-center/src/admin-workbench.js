import { paymentCardOrigin } from './payment-card-source.js';
const shanghaiDate = date => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(date));
const value = input => String(input || '').trim().toLowerCase();
const matches = (parts, query) => !query || parts.some(part => value(part).includes(query));
export const needsWorkbenchAttention = order => !order.workbenchHandledAt && (['needs_review','manual_queued','manual_processing','needs_info'].includes(order.status) ||
  Boolean(order.needsAttention) || order.status === 'failed' && (order.useResolution === 'frozen' || !order.retryAllowed && !String(order.hifupaySafetyStatus || '').startsWith('released_unpaid')));

export function workbenchPaymentCards(hifupay, usageCards, chargeThreshold = 16) {
  const shared = new Map(usageCards.filter(card => card.credentialSource === 'hifupay').map(card => [card.hifupayId,card]));
  const h = hifupay.map(card => {
    const usage = shared.get(card.id);
    const enabled = card.enabled !== false && (!usage || Boolean(usage.enabled));
    const occupied = Boolean(card.inFlightCount || usage?.occupiedOrderId);
    const paused = Boolean(usage?.paused);
    const remaining = Number(card.remainingUses) || 0;
    const baseReady = enabled && !paused && !occupied && remaining > 0 && !card.missingFromUpstream &&
      card.status === 'active' && !card.proProtected && !card.pro5xSelected;
    const channels = [];
    if (baseReady && card.poolStatus === 'ready') channels.push('嗨付');
    if (baseReady && card.balance != null && Number(card.balance) >= chargeThreshold) channels.push('ZZS');
    return { ...card,kind:'h',uid:'h:'+card.id,usageId:card.sharedUsageId || usage?.id || '',enabled,paused,occupied,
      sourceLabel:'嗨付',note:usage?.note || '',remaining,max:Number(card.maxUses)||0,used:Number(card.usedCount)||0,
      frozen:Number(card.frozenCount)||0,channels,state:!enabled?'disabled':paused?'paused':occupied?'reserved':card.poolStatus,
      frozenOrders:(usage?.frozenOrders || []).map(item => ({...item,email:item.email || (card.inFlightOrders || []).find(x=>x.orderId===item.orderId)?.email || ''})) };
  });
  const manual = usageCards.filter(card => card.credentialSource === 'manual').map(card => {
    const enabled = Boolean(card.enabled),paused = Boolean(card.paused),occupied = Boolean(card.occupiedOrderId);
    return {...card,kind:'manual',uid:'manual:'+card.id,usageId:card.id,enabled,paused,occupied,...paymentCardOrigin(card.source,card.note),
      remaining:Number(card.remainingUses)||0,max:Number(card.maxSuccess)||0,used:Number(card.successCount)||0,frozen:Number(card.frozenUses)||0,
      state:!enabled?'disabled':paused?'paused':occupied?'reserved':card.remainingUses > 0?'ready':'uses_exhausted',
      channels:enabled && !paused && !occupied && card.remainingUses > 0?['ZZS']:[]};
  });
  return [...h,...manual].filter(card => card.enabled).sort((a,b)=>(Number(a.priority)||0)-(Number(b.priority)||0)||String(a.createdAt||'').localeCompare(String(b.createdAt||''))||a.uid.localeCompare(b.uid));
}
function pageRows(rows, input, size) {
  const pages = Math.max(1,Math.ceil(rows.length/size));
  const page = Math.min(pages,Math.max(1,Number.parseInt(input,10)||1));
  return {items:rows.slice((page-1)*size,page*size),matched:rows.length,page,pages,pageSize:size};
}
export function buildWorkbench({hifupay,usageCards,customerCards,records,plusProvider,chargeThreshold}, query = {}) {
  const selectedChannel = plusProvider === 'zzshu' ? 'ZZS' : '嗨付';
  const cards = workbenchPaymentCards(hifupay,usageCards,chargeThreshold).map(card=>({...card,selectable:card.channels.includes(selectedChannel)}));
  const orderSearch = value(query.orderSearch).slice(0,200),voucherSearch = value(query.voucherSearch).slice(0,200);
  const visibleRecords = records.filter(order=>!order.workbenchHandledAt);
  const filteredOrders = visibleRecords.filter(order =>
    (query.orderView !== 'attention' || needsWorkbenchAttention(order)) &&
    (!query.orderStatus || order.status === query.orderStatus) && (!query.orderPlan || order.plan === query.orderPlan) &&
    (!query.orderProvider || order.provider === query.orderProvider) && (!query.orderSource || order.salesChannel === query.orderSource) &&
    matches([order.id,order.userEmail,order.accountId,order.customerCardCode,order.customerCardMask,order.salesChannel,order.paymentCardLastFour,order.hifupayCardLastFour],orderSearch));
  const latestOrderByCard = new Map();
  for (const order of records) if (order.customerCardId && !latestOrderByCard.has(order.customerCardId)) latestOrderByCard.set(order.customerCardId,order);
  const vouchers = customerCards.filter(card => !card.archivedAt).map(card => {
    const order = latestOrderByCard.get(card.id);
    const operationalStatus = card.status === 'disabled' ? 'disabled' : card.status === 'used' || order?.status === 'success' ? 'used' :
      order && (['needs_review','processing','queued','submitting','manual_queued','manual_processing','needs_info'].includes(order.status) || order.status === 'failed' && needsWorkbenchAttention(order))
        ? ['needs_review','failed'].includes(order.status) || order.adminFrozen ? 'needs_review' : 'processing' : card.status;
    return {...card,hasSubmission:Boolean(card.hasSubmission || order),boundEmail:card.boundEmail || order?.userEmail || '',boundAccountId:card.boundAccountId || order?.accountId || '',operationalStatus,latestOrder:order ? {id:order.id,status:order.status,provider:order.provider,plan:order.plan,
      retryAllowed:Boolean(order.retryAllowed),useResolution:order.useResolution || '',hasOriginalJson:Boolean(order.hasOriginalJson),userEmail:order.userEmail || ''}:null};
  });
  const countVouchers = vouchers.filter(card =>
    (!query.voucherPlan || card.plan === query.voucherPlan) &&
    (!query.voucherSource || card.source === query.voucherSource) && (!query.batch || card.batchId === query.batch) &&
    (!query.voucherDate || card.createdAt && shanghaiDate(card.createdAt) === query.voucherDate) &&
    matches([card.id,card.code,card.cardMask,card.source,card.batchId,card.boundEmail,card.boundAccountId],voucherSearch));
  const inventoryReady = card => card.operationalStatus === 'unused' && !card.hasSubmission && !card.boundEmail && !card.boundAccountId && !card.boundAt && !card.orderId && !card.disabledAt && Boolean(card.code) && ['plus','pro_x5','pro_x20'].includes(card.plan) && (!card.expiresAt || Date.parse(card.expiresAt)>Date.now());
  if(query.batch) countVouchers.sort((a,b)=>(Number(a.sequence)||0)-(Number(b.sequence)||0));
  const filteredVouchers = countVouchers.filter(card=>query.voucherStatus === 'stock' ? inventoryReady(card) : !query.voucherStatus || card.operationalStatus === query.voucherStatus);
  const attention = visibleRecords.filter(needsWorkbenchAttention);
  const today = shanghaiDate(new Date());
  const batches = new Map();
  for (const card of vouchers) if (card.batchId && !batches.has(card.batchId)) batches.set(card.batchId,{id:card.batchId,source:card.source,createdAt:card.createdAt,size:card.batchSize});
  return {plusProvider,updatedAt:new Date().toISOString(),cards,
    attention:{items:attention.slice(0,5),total:attention.length,
      counts:{frozen:attention.filter(order=>order.useResolution==='frozen').length,
        manual:attention.filter(order=>['manual_queued','manual_processing','needs_info'].includes(order.status)).length,
        failed:attention.filter(order=>order.status==='failed').length}},
    summary:{todaySuccess:visibleRecords.filter(order=>order.status==='success' && order.createdAt && shanghaiDate(order.createdAt)===today).length,inventoryReady:vouchers.filter(inventoryReady).length,activeCards:cards.length,readyCards:cards.filter(card=>card.channels.length).length,
      selectableUses:cards.filter(card=>card.selectable).reduce((n,card)=>n+card.remaining,0),
      remainingUses:cards.reduce((n,card)=>n+card.remaining,0),frozenUses:cards.reduce((n,card)=>n+card.frozen,0),
      unusedVouchers:vouchers.filter(card=>card.operationalStatus==='unused').length,
      attentionOrders:records.filter(needsWorkbenchAttention).length},
    orders:{...pageRows(filteredOrders,query.orderPage,10),total:visibleRecords.length,sources:[...new Set(records.map(x=>x.salesChannel).filter(Boolean))],providers:[...new Set(records.map(x=>x.provider).filter(Boolean))]},
    vouchers:{...pageRows(filteredVouchers,query.voucherPage,20),total:vouchers.length,
      counts:{stock:countVouchers.filter(inventoryReady).length,...Object.fromEntries(['unused','used','processing','needs_review','locked','disabled','expired'].map(status=>[status,countVouchers.filter(x=>x.operationalStatus===status).length]))},
      batches:[...batches.values()].slice(0,100),sources:[...new Set(vouchers.map(x=>x.source).filter(Boolean))]}};
}
