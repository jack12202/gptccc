import {paymentCardOrigin} from './payment-card-source.js';
export function paymentCardTrace(card, at = '', historical = false) {
  if(!card)return null;
  const ref=String(card.credential_ref||''),hId=ref.startsWith('hifupay:')?ref.slice(8):card.hifupayId||'';
  const kind=hId||card.kind==='h'?'h':'manual',id=String(hId||card.cardId||card.id||'');
  const lastFour=String(card.lastFour||card.last_four||'');
  if(!id||!/^\d{4}$/.test(lastFour))return null;
  return {cardId:id,usageId:String(card.usageId||card.id||''),kind,lastFour,
    source:kind==='h'?'嗨付':paymentCardOrigin(card.source,card.note).sourceLabel,at,historical,
    url:'/admin/hifupay/cards?cardId='+encodeURIComponent(id)};
}
export function readPaymentCardTrace(raw) {
  try { const t=typeof raw==='string'?JSON.parse(raw):raw;return t?paymentCardTrace({id:t.cardId,usageId:t.usageId,kind:t.kind,hifupayId:t.kind==='h'?t.cardId:'',lastFour:t.lastFour,source:t.source},t.at||'',Boolean(t.historical)):null; } catch {return null;}
}
