(() => {
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const link=t=>'/admin/hifupay/cards?cardId='+encodeURIComponent(t.cardId);
  function summary(order){if(order.manualPaymentUse&&!order.manualPaymentUse.cardUid)return '未选择支付卡';const t=order.paymentCardTrace;return t?'<strong>•••• '+esc(t.lastFour)+'</strong><div class="small muted">'+esc(t.source)+'</div>':esc(order.paymentCardLastFour||order.hifupayCardLastFour?'•••• '+(order.paymentCardLastFour||order.hifupayCardLastFour):'未留存用卡信息');}
  function detail(order){if(order.manualPaymentUse&&!order.manualPaymentUse.cardUid)return '<p class="small muted">人工充值：本次未选择支付卡，不消耗卡池次数。</p>';const t=order.paymentCardTrace;if(!t)return '<p class="small muted">支付卡：未留存用卡信息。</p>';
    const used=order.manualPaymentUse?order.manualPaymentUse.uses+' 次':order.useResolution==='consumed'?'1 次':order.useResolution==='frozen'?'冻结 1 次':order.useResolution==='released'?'0 次（已释放）':order.paymentConfirmed?'1 次（已确认）':'待确认';
    let html='<section style="margin:16px 0;padding:14px;border:1px solid #dbe7e2;border-radius:9px"><h3>本次支付卡</h3><p>•••• '+esc(t.lastFour)+' · '+esc(t.source)+'</p><p class="mono">卡片 ID：'+esc(t.cardId)+'</p><p>充值协议：'+esc(order.fulfillmentMode==='manual'?'人工':({zzshu:'ZZS',h:'嗨付',hifupay:'嗨付'})[order.provider]||order.provider)+' · 次数：'+esc(used)+'</p><p class="small muted">'+(t.historical?'历史订单关联信息；未保存提交时来源快照。':'已保存本次选卡信息。')+'</p><a class="link back-link" href="'+link(t)+'">查看支付卡</a>';
    if(order.paymentCardAttempts?.length>1)html+='<h3 style="margin-top:14px">用卡尝试记录</h3>'+order.paymentCardAttempts.map(a=>'<p>'+esc(a.at||'')+' · '+esc(a.trace?'•••• '+a.trace.lastFour+' · '+a.trace.source:'未留存用卡信息')+' · '+esc(({success:'成功',failed:'失败',needs_review:'待核查',processing:'处理中',reserved:'已选卡',submitting:'提交中'})[a.status]||a.status||'已选卡')+'</p><p class="mono">执行记录：'+esc(a.orderId||'')+'</p>').join('');
    return html+'</section>';
  }
  window.paymentCardTraceUI={summary,detail};
})();
