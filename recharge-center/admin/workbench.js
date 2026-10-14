(() => {
  'use strict';
  const $ = id => document.getElementById(id),api = window.adminApi;
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const date = value => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '—';
  const plan = value => ({plus:'Plus',pro_x5:'Pro 5x',pro_x20:'Pro 20x'})[value] || value || 'Plus';
  const channel = value => ({h:'嗨付',hifupay:'嗨付',zzshu:'ZZS'})[value] || value || '—';
  const labels = {unused:'未使用',used:'已使用',locked:'已锁定',reserved:'处理中',processing:'处理中',queued:'排队中',submitting:'提交中',needs_review:'待确认',failed:'失败',success:'成功',disabled:'已停用',paused:'已暂停',uses_exhausted:'次数用完',ready:'可用',high_balance:'嗨付高余额保护',pro_protected:'Pro 保护',low_balance:'余额不足',upstream_missing:'同步缺失',upstream_unavailable:'上游不可用',manual_queued:'待人工',manual_processing:'人工处理中',needs_info:'需补资料',expired:'已过期',not_found:'未找到',invalid:'无效输入'};
  const badge = (value,label) => '<span class="badge'+(['needs_review','failed','paused','uses_exhausted','manual_queued','needs_info','locked'].includes(value)?' warn':['disabled','expired'].includes(value)?' off':'')+'">'+esc(label || labels[value] || value)+'</span>';
  const button = (action,text,id='',kind='',extra='') => '<button type="button" data-action="'+action+'" data-id="'+esc(id)+'" data-kind="'+kind+'" '+extra+'>'+text+'</button>';
  const post = (url,body={}) => api(url,{method:'POST',body:JSON.stringify(body)});
  const state = {data:null,params:{orderPage:1,voucherPage:1,voucherStatus:"stock"},poolView:'all',poolSelected:new Set(),voucherSelected:new Set(),knownVouchers:new Map(),orders:new Map(),generated:[],requests:new Map(),busy:new Set(),sequence:0,importPreview:false,proLoaded:false,notifications:false,seenOrders:null};
  let noticeTimer,searchTimer;
  function notify(text,error=false) { if($('detailDialog').open){$('detailMessage').textContent=text;$('detailMessage').classList.toggle('error',error);} clearTimeout(noticeTimer);$('notice').textContent=text;$('notice').classList.toggle('error',error);$('notice').hidden=false;noticeTimer=setTimeout(()=>$('notice').hidden=true,error?18000:9000); }
  function options(id,rows,first) { const el=$(id),selected=el.value;el.innerHTML='<option value="">'+first+'</option>'+rows.map(row=>'<option value="'+esc(row.value ?? row)+'">'+esc(row.label ?? row)+'</option>').join('');el.value=selected; }
  function tab(action,key,text,current) { return button(action,text,key,'',current===key?'class="active"':''); }
  function paymentCard(uid) { return state.data?.cards.find(card=>card.uid===uid); }
  function poolRows() {
    const query=$('poolSearch').value.trim().toLowerCase();
    return (state.data?.cards||[]).filter(card=>(state.poolView==='all'||state.poolView==='current'&&card.selectable||state.poolView==='ready'&&card.channels.length||state.poolView==='attention'&&!card.channels.length||state.poolView==='frozen'&&card.frozen>0)&&
      (!query||[card.id,card.lastFour,card.sourceLabel,card.note,...(card.successfulAccounts||card.plusUsers||[]).flatMap(x=>[x.email,x.accountId])].join(' ').toLowerCase().includes(query)));
  }
  function renderPool() {
    if(!state.data)return;const cards=state.data.cards;
    $('poolTabs').innerHTML=tab('pool-filter','all','全部 '+cards.length,state.poolView)+tab('pool-filter','ready','可用 '+cards.filter(c=>c.channels.length).length,state.poolView)+tab('pool-filter','attention','需处理 '+cards.filter(c=>!c.channels.length).length,state.poolView)+tab('pool-filter','frozen','有冻结 '+cards.filter(c=>c.frozen>0).length,state.poolView)+(state.poolView==='current'?tab('pool-filter','current','当前通道',state.poolView):'');
    $('poolRows').innerHTML=poolRows().map(card=>'<tr><td><input type="checkbox" data-pool-select="'+esc(card.uid)+'" aria-label="选择支付卡 '+esc(card.lastFour)+'" '+(state.poolSelected.has(card.uid)?'checked':'')+'> <strong>•••• '+esc(card.lastFour)+'</strong><div class="small">'+(card.kind==='h'?'嗨付同步':'手动导入')+(card.note?' · '+esc(card.note):'')+'</div></td><td>'+window.paymentCardSourceUI.row(card)+'</td><td>'+card.channels.map(c=>badge('ready',c)).join(' ')+' '+(!card.channels.length?'<span class="small">当前不可轮选</span>':'')+'</td><td class="count"><strong>'+card.remaining+'</strong> / 总 '+card.max+'<div class="small">已用 '+card.used+(card.frozen?' · <span class="frozen">冻结 '+card.frozen+'</span>':'')+'</div></td><td>'+(card.balance==null?'—':'$'+Number(card.balance).toFixed(2))+'</td><td>'+badge(card.state)+(card.paused?'<div class="small">'+esc(card.lastFailure||'请核查后恢复')+'</div>':'')+'</td><td><div class="row-actions">'+button('card-add-one','＋1 次',card.uid,'',!card.usageId||card.max>=100?'disabled':'')+button('card-add','增加…',card.uid,'',!card.usageId||card.max>=100?'disabled':'')+(card.frozen?button('card-release','解锁冻结',card.uid):'')+(card.paused?button('card-resume','恢复暂停',card.uid):'')+button('card-copy-standard','复制标准格式',card.uid)+button('card-detail','管理',card.uid)+'</div></td></tr>').join('')||'<tr><td colspan="7" class="empty">暂无匹配的未停用支付卡，可直接录入新卡。</td></tr>';
    $('poolSelected').textContent='已选 '+state.poolSelected.size+' 张';
  }
  function orderActions(order,detail=false) {
    const id=order.id,isPro=['pro_x5','pro_x20'].includes(order.plan),pending=['processing','needs_review'].includes(order.status);
    let html=order.hasOriginalJson?button('order-json','复制 JSON',id):'';
    if(order.provider==='zzshu'&&!isPro){
      if(['failed','needs_review'].includes(order.status)&&order.useResolution==='frozen')html+=button('order-release','解锁冻结',id);
      if((pending||order.status==='failed')&&!order.retryAllowed&&order.useResolution!=='consumed')html+=button('order-unlock','解锁卡密',id);
      if(pending&&order.autoQuery&&order.hasUpstreamQueryKey)html+=button('order-check','安全补查',id);
      if(detail){
        if(pending)html+=button('order-freeze',order.adminFrozen?'继续冻结待查':'冻结待查',id);
        if(pending||order.status==='failed')html+=button('order-success','确认充值成功',id);
        if(order.status==='failed'&&order.useResolution==='frozen')html+=button('order-consume','记为已消耗',id);
        if(order.status==='success'&&order.subscriptionCancellationStatus!=='cancelled')html+=button('order-cancellation','确认续费已关闭',id);
      }
    }else if(isPro&&detail){
      if(order.fulfillmentMode==='manual'&&['manual_queued','manual_processing','needs_info'].includes(order.status))html+=button('pro-manual-processing','人工处理中',id)+button('pro-needs-info','需补资料',id)+button('pro-mark-success','确认人工成功',id);
      if(order.fulfillmentMode==='auto'&&order.status==='needs_review')html+=button('pro-confirm-no-charge','核实未扣款并转人工',id);
    }else if(detail){
      if(['failed','needs_review'].includes(order.status))html+=button('legacy-success','确认充值成功',id);
      if(order.needsAttention)html+=button('legacy-subscription','标记续费已处理',id);
    }
    return (detail?'':button('order-detail','详情 / 处理',id))+html;
  }
  function pager(id,page,section) { $(id).innerHTML=button(section+'-prev','上一页','','',page.page<=1?'disabled':'')+'<span>'+page.matched+' / '+page.total+' 条 · 第 '+page.page+' / '+page.pages+' 页</span>'+button(section+'-next','下一页','','',page.page>=page.pages?'disabled':''); }
  function renderOrders() {
    const d=state.data;for(const order of d.orders.items)state.orders.set(order.id,order);
    $('orderTabs').innerHTML=tab('order-filter','','最近订单',state.params.orderView||'')+tab('order-filter','attention','待处理 '+d.summary.attentionOrders,state.params.orderView||'');
    $('orderRows').innerHTML=d.orders.items.map(order=>'<tr><td><strong>'+esc(order.userEmail||'未知账号')+'</strong><div class="small">'+date(order.createdAt)+'</div></td><td><span class="mono">'+esc(order.customerCardCode?order.customerCardCode.slice(0,9)+'…'+order.customerCardCode.slice(-6):order.customerCardMask||'—')+'</span><div class="small">'+plan(order.plan)+' · '+(order.fulfillmentMode==='manual'?'人工':channel(order.provider))+' · '+esc(order.salesChannel||'未分类')+'</div></td><td>'+esc(order.paymentCardLastFour||order.hifupayCardLastFour?'•••• '+(order.paymentCardLastFour||order.hifupayCardLastFour):'—')+'</td><td>'+badge(order.status)+'<div class="small">'+esc(order.useResolution==='frozen'?'本次支付次数已冻结':order.retryAllowed?'原卡密可重新提交':order.processingNote||order.message||'')+'</div></td><td><div class="row-actions">'+orderActions(order)+'</div></td></tr>').join('')||'<tr><td colspan="5" class="empty">暂无匹配订单。</td></tr>';
    options('orderProvider',d.orders.providers.map(p=>({value:p,label:channel(p)})),'全部协议');options('orderSource',d.orders.sources,'全部渠道');pager('orderPager',d.orders,'order');
  }
  function renderVouchers() {
    const d=state.data;for(const card of d.vouchers.items)state.knownVouchers.set(card.id,card);
    const current=state.params.voucherStatus||'';
    $('voucherTabs').innerHTML=tab('voucher-filter','stock','未使用库存 '+d.vouchers.counts.stock,current)+tab('voucher-filter','','全部卡密',current)+['unused','used','processing','needs_review','disabled'].map(status=>tab('voucher-filter',status,(status==='disabled'?'已禁用':labels[status]||status)+' '+d.vouchers.counts[status],current)).join('');
    $('voucherRows').innerHTML=d.vouchers.items.map(card=>'<tr><td><input type="checkbox" data-voucher-select="'+esc(card.id)+'" aria-label="选择卡密 '+esc(card.code?.slice(-6)||card.id)+'" '+(state.voucherSelected.has(card.id)?'checked':'')+'> <span class="mono">'+esc(card.code||card.cardMask)+'</span></td><td>'+plan(card.plan)+'<div class="small">'+esc(card.source)+'</div></td><td>'+badge(card.operationalStatus,card.operationalStatus==='unused'&&card.hasSubmission?'可重试 / 已绑定':card.operationalStatus==='disabled'?'已禁用':null)+'</td><td>'+esc(card.boundEmail||'未绑定')+'<div class="small">'+date(card.createdAt)+'</div></td><td><div class="row-actions">'+(card.code?button('voucher-code','复制卡密',card.id)+button('voucher-link','复制链接',card.id):'')+button('voucher-detail','更多',card.id)+(card.latestOrder?button('order-detail','订单',card.latestOrder.id):'')+'</div></td></tr>').join('')||'<tr><td colspan="5" class="empty">暂无匹配卡密，可在这里生成。</td></tr>';
    options('voucherSource',d.vouchers.sources,'全部渠道');options('batchFilter',d.vouchers.batches.map(b=>({value:b.id,label:date(b.createdAt)+' · '+b.source+' · '+b.size+' 张'})),'全部批次');$('voucherSelected').textContent='已选 '+state.voucherSelected.size+' 张';pager('voucherPager',d.vouchers,'voucher');
  }
  function capacityThreshold() {
    try { const raw=localStorage.getItem('gptc.home.capacityThreshold');const n=raw===null?8:Number(raw);return Number.isInteger(n)&&n>=0&&n<=10000?n:8; } catch { return 8; }
  }
  function renderAttention() {
    const d=state.data,a=d.attention;
    for(const order of a.items)state.orders.set(order.id,order);
    $('attentionSummary').textContent='共 '+a.total+' 笔待处理 · 有冻结 '+a.counts.frozen+' 笔 · 待人工 / 补资料 '+a.counts.manual+' 笔 · 失败待核查 '+a.counts.failed+' 笔';
    $('attentionRows').innerHTML=a.items.map(order=>{
      const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(order.createdAt))/60000));
      const waiting=Number.isFinite(minutes)?minutes<60?minutes+' 分钟':Math.floor(minutes/60)+' 小时 '+minutes%60+' 分钟':'—';
      return '<tr><td><strong>'+esc(order.userEmail||'未知账号')+'</strong><div class="small">'+plan(order.plan)+' · '+(order.fulfillmentMode==='manual'?'人工':channel(order.provider))+'</div></td><td>'+badge(order.status)+'<div class="small">'+esc(order.useResolution==='frozen'?'本次支付次数已冻结':order.processingNote||order.message||'需要人工核查')+'</div></td><td class="waiting">'+waiting+'</td><td><div class="row-actions">'+button('order-detail','核查 / 处理',order.id)+'</div></td></tr>';
    }).join('')||'<tr><td colspan="4" class="empty">暂无待处理订单。</td></tr>';
    const threshold=capacityThreshold(),remaining=d.summary.selectableUses;
    $('capacityNotice').hidden=threshold===0||remaining>=threshold;
    $('capacityNotice').textContent='卡池容量提醒：当前 '+channel(d.plusProvider)+' 协议可轮选 '+remaining+' 次，低于阈值 '+threshold+' 次。请录入新卡或核查冻结次数。';
    $('capacityThreshold').value=threshold;
  }
  async function refresh(silent=false) {
    const sequence=++state.sequence;
    try{const params=new URLSearchParams(Object.entries(state.params).filter(([,v])=>v!==''&&v!=null));const d=await api('/api/admin/workbench?'+params);
      if(sequence!==state.sequence)return false;state.data=d;
      for(const uid of state.poolSelected)if(!d.cards.some(card=>card.uid===uid))state.poolSelected.delete(uid);
      const s=d.summary;$('homeStats').innerHTML=[['today','今日提交且成功',s.todaySuccess],['active','在用支付卡',s.activeCards],['uses','当前可轮选次数',s.selectableUses],['frozen','冻结次数',s.frozenUses],['unused','未使用库存',s.inventoryReady],['attention','待处理订单',s.attentionOrders]].map(([key,text,n])=>'<'+(key==='today'?'div':'button')+' class="stat"'+(key==='today'?'':' data-shortcut="'+key+'"')+'><strong>'+n+'</strong><small>'+text+'</small></'+(key==='today'?'div':'button')+'>').join('');
      $('homeState').textContent='当前 Plus 通道：'+channel(d.plusProvider)+' · 更新于 '+date(d.updatedAt)+(d.historyHandling?' · 已将北京时间 10 月 14 日之前 '+d.historyHandling.count+' 笔订单标记已处理，历史记录保留。':'');renderPool();renderAttention();renderOrders();renderVouchers();
      if(state.notifications&&state.seenOrders){const fresh=d.orders.items.filter(order=>!state.seenOrders.has(order.id));if(fresh.length&&document.hidden)new Notification('GPTC 新充值订单',{body: fresh.length+' 笔新订单，请查看工作台。'});}
      state.seenOrders=new Set(d.orders.items.map(order=>order.id));return true;
    }catch(error){if(sequence===state.sequence){$('homeState').textContent='读取失败，保留上次结果。请刷新工作台。';if(!silent)notify(error.message,true);}return false;}
  }
  window.refreshWorkbench=refresh;
  async function saved(message='操作已保存。') { const ok=await refresh();notify(ok?message:'操作已保存，但列表暂时无法刷新，请稍后刷新工作台。',!ok); }
  async function modal(title,description,fields='') {
    if($('actionDialog').open)return null;
    $('actionTitle').textContent=title;$('actionDescription').textContent=description;$('actionFields').innerHTML=fields;$('actionDialog').showModal();
    return new Promise(resolve=>{const form=$('actionForm'),dialog=$('actionDialog');
      const finish=result=>{form.removeEventListener('submit',submit);dialog.removeEventListener('cancel',cancel);form.removeEventListener('click',click);dialog.close();$('actionFields').replaceChildren();resolve(result);};
      const submit=e=>{e.preventDefault();if(form.reportValidity())finish(Object.fromEntries(new FormData(form)));};const cancel=e=>{e.preventDefault();finish(null);};const click=e=>{if(e.target.closest('[data-action="cancel-modal"]'))cancel(e);};
      form.addEventListener('submit',submit);dialog.addEventListener('cancel',cancel);form.addEventListener('click',click);
    });
  }
  const field = (label,name,value='',type='text',attrs='') => '<label>'+label+'<input name="'+name+'" type="'+type+'" value="'+esc(value)+'" '+attrs+'></label>';
  const noteField = (name='note',text='补充备注（选填）',initial='') => '<label>'+text+'<textarea name="'+name+'" maxlength="1000">'+esc(initial)+'</textarea></label>';
  function openDetail(title,body) { $('detailMessage').textContent='';$('detailTitle').textContent=title;$('detailBody').innerHTML=body;if(!$('detailDialog').open)$('detailDialog').showModal(); }
  async function addUses(card,amount) {
    if(!Number.isInteger(amount)||amount<1)throw Error('请输入要增加的整数次数。');
    let request=state.requests.get(card.uid);if(!request||request.amount!==amount){request={amount,requestId:crypto.randomUUID()};state.requests.set(card.uid,request);}
    const result=await post('/api/admin/zzshu/cards/'+encodeURIComponent(card.usageId)+'/add-uses',request);state.requests.delete(card.uid);return result;
  }
  async function cardAdd(card,one=false) { const input=one?{amount:1}:await modal('增加剩余次数','尾号 '+card.lastFour+'：剩余 '+card.remaining+' 次，填写额外增加的次数。',field('增加次数','amount',1,'number','min="1" max="'+Math.max(1,100-card.max)+'" required'));if(!input)return;await addUses(card,Number(input.amount));await saved('尾号 '+card.lastFour+'：剩余次数已增加 '+input.amount+' 次。'); }
  async function releaseCard(card) {
    if(!card.frozenOrders?.length)throw Error('未找到关联冻结订单，请刷新后到充值订单核查。');
    const input=await modal('解锁冻结','选择已核实未扣款的订单，本次恢复 1 次。总次数保持不变。',
      '<label>冻结订单<select name="order">'+card.frozenOrders.map((o,i)=>'<option value="'+i+'">'+esc(o.email||o.orderId)+' · '+channel(o.provider)+' · '+esc(o.orderId)+'</option>').join('')+'</select></label><label class="field-check"><input type="checkbox" name="checked" required>已核实本次未扣款、未开通</label>'+noteField());
    if(!input)return;const order=card.frozenOrders[Number(input.order)];
    if(order.provider==='h')await post('/api/admin/hifupay/cards/'+encodeURIComponent(card.id)+'/release',{orderId:order.orderId,reason:'已核实未扣款、未开通'+(input.note?'；'+input.note:'')});
    else await post('/api/admin/recoveries/'+encodeURIComponent(order.orderId)+'/disposition',{outcome:'release',reasonCode:'no_charge',note:input.note});
    $('detailDialog').close();await saved('已解锁冻结，剩余次数恢复 1 次。');
  }
  function cardDetail(card) {
    const accounts=card.successfulAccounts||card.plusUsers||[];
    openDetail('支付卡 •••• '+card.lastFour,'<p>'+esc(card.sourceLabel)+' · ID '+esc(card.id)+'</p><p>剩余 '+card.remaining+' / 总 '+card.max+' · 已用 '+card.used+' · 冻结 '+card.frozen+'</p><div class="actions">'+button('card-cap','调整总次数',card.uid)+button('card-note','编辑备注',card.uid)+(card.kind==='manual'?button('card-source','修改来源渠道',card.uid):'')+(card.kind==='h'?button('card-priority','轮选顺序',card.uid)+button('card-protect','设置 / 修改 Pro 保护',card.uid)+(card.proProtected?button('card-release-pro','解除 Pro 保护',card.uid):''):'')+button('card-disable','停用此卡',card.uid)+'</div><h3 style="margin-top:20px">历史充值账号</h3>'+accounts.map(account=>'<div class="history-item"><strong>'+esc(account.email||'未知邮箱')+'</strong><p>'+esc(account.accountId||'')+' · '+date(account.submittedAt||account.plusAt)+'</p>'+(account.orderId?button('order-detail','查看订单',account.orderId):'')+'</div>').join('')+(accounts.length?'':'<p>暂无成功记录。</p>')+(card.frozenOrders?.length?'<h3 style="margin-top:20px">冻结订单</h3>'+card.frozenOrders.map(order=>'<p>'+esc(order.email||order.orderId)+' · '+channel(order.provider)+'</p>').join('')+button('card-release','解锁冻结',card.uid):''));
  }
  async function cardSetting(card,action) {
    if(action==='card-disable'){const input=await modal('停用支付卡','尾号 '+card.lastFour+' 将从首页移除，之后可在完整卡池恢复。');if(!input)return;await post(card.kind==='h'?'/api/admin/hifupay/cards/'+encodeURIComponent(card.id)+'/disable':'/api/admin/zzshu/cards/'+encodeURIComponent(card.id),card.kind==='h'?{}:{enabled:false});}
    if(action==='card-resume'){const input=await modal('恢复暂停','确认已核查失败原因，恢复尾号 '+card.lastFour+' 的轮选资格。');if(!input)return;await post('/api/admin/zzshu/cards/'+encodeURIComponent(card.usageId),{resume:true});}
    if(action==='card-cap'){const input=await modal('调整总次数','总次数包含已用和冻结次数；当前剩余 '+card.remaining+' 次。',field('总次数','cap',card.max,'number','min="1" max="100" required'));if(!input)return;await post('/api/admin/zzshu/cards/'+encodeURIComponent(card.usageId),{maxSuccess:Number(input.cap)});}
    if(action==='card-source'){const input=await modal('修改来源渠道','尾号 '+card.lastFour+' · 可填写天空、ZZS / 吱吱鼠或自定义名称。',field('来源渠道','source',card.sourceMissing?'':card.sourceLabel,'text','maxlength="40" required'));if(!input)return;await post('/api/admin/zzshu/cards/'+encodeURIComponent(card.usageId),{source:input.source.trim()});}
    if(action==='card-note'){const input=await modal('编辑支付卡备注','尾号 '+card.lastFour,noteField('note','备注',card.note||''));if(!input)return;await post('/api/admin/zzshu/cards/'+encodeURIComponent(card.usageId),{note:input.note});}
    if(action==='card-priority'){const input=await modal('轮选顺序','数字越小越优先，原有轮选规则保持不变。',field('轮选顺序','priority',card.priority||0,'number','min="0" required'));if(!input)return;await post('/api/admin/hifupay/cards/'+encodeURIComponent(card.id)+'/settings',{field:'priority',value:Number(input.priority)});}
    if(action==='card-protect'){const prior=card.proReservation||{},input=await modal('Pro 续费保护','受保护卡片将不参与 Plus 自动轮选。',field('Pro 账号','account',prior.account||'')+field('升级类型','type',prior.type||'20X Pro')+field('预计续费日期','renewalAt',prior.renewalAt||'','date'));if(!input)return;await post('/api/admin/hifupay/cards/'+encodeURIComponent(card.id)+'/protect-pro',input);}
    if(action==='card-release-pro'){const input=await modal('解除 Pro 保护','确认这张卡不再需要保留用于 Pro 续费。');if(!input)return;await post('/api/admin/hifupay/cards/'+encodeURIComponent(card.id)+'/release-pro');}
    $('detailDialog').close();await saved();
  }
  async function findOrder(id) {
    // Read the current record before resolving it, including orders outside the recent window.
    const data=await api('/api/admin/workbench?orderSearch='+encodeURIComponent(id));
    const order=data.orders.items.find(item=>item.id===id);if(!order)throw Error('订单不存在或状态已变化，请刷新。');state.orders.set(id,order);return order;
  }
  async function openOrder(id) {
    const order=await findOrder(id),isPro=['pro_x5','pro_x20'].includes(order.plan);
    let body='<p>'+esc(order.userEmail||'未知账号')+' · '+plan(order.plan)+' · '+(order.fulfillmentMode==='manual'?'人工':channel(order.provider))+' · '+badge(order.status)+'</p><div class="detail-grid"><div><p>订单编号</p><span class="mono">'+esc(id)+'</span></div><div><p>提交时间</p>'+date(order.createdAt)+'</div><div><p>账号 UUID</p><span class="mono">'+esc(order.accountId||'—')+'</span> '+(order.accountId?button('order-uuid','复制 UUID',id):'')+'</div><div><p>客户卡密</p><span class="mono">'+esc(order.customerCardCode||order.customerCardMask||'—')+'</span> '+(order.customerCardCode?button('order-code','复制卡密',id):'')+'</div></div><p>'+esc(order.processingNote||order.message||'暂无说明')+'</p><div class="actions">'+orderActions(order,true)+'</div>';
    if(order.hasSubmittedJson)body+='<div class="actions">'+button('order-submitted-json','复制发送 JSON',id)+'</div>';
    if(isPro){
      const detail=await api('/api/admin/pro/orders/'+encodeURIComponent(id));state.orders.set(id,{...order,processingNote:detail.processingNote||''});
      body+='<div class="actions">'+button('pro-note','编辑处理备注',id)+(order.fulfillmentMode==='manual'&&order.status!=='success'?button('pro-card','选择人工支付卡',id):'')+'</div><details><summary>操作记录</summary><pre>'+esc((detail.logs||[]).map(x=>date(x.createdAt)+' '+x.step).join('\n'))+'</pre></details>';
    }else if(order.provider==='zzshu'){
      body+='<details id="responseDetails" data-order-id="'+esc(id)+'"><summary>上游返回历史（按需读取）</summary><div id="responseBody"></div><div class="actions">'+button('responses-refresh','刷新返回历史',id)+button('responses-older','加载更早记录',id,'','id="olderResponses" disabled')+'</div></details><div class="actions">'+button('order-upstream-usage','查询 ZZS 开通记录',id)+'</div>';
    }else if(['failed','needs_review'].includes(order.status)&&order.hifupayCardId){
      const card=state.data.cards.find(c=>c.kind==='h'&&c.id===order.hifupayCardId);
      if(card?.frozenOrders?.some(o=>o.orderId===id))body+='<div class="actions">'+button('card-release','解锁支付卡冻结',card.uid)+'</div>';
    }
    openDetail('订单详情',body);const details=$('responseDetails');if(details)details.ontoggle=()=>{if(details.open&&!details.dataset.loaded)loadResponses(id).catch(error=>notify(error.message,true));};
  }
  const histories=new Map();
  async function loadResponses(id,older=false) {
    const previous=histories.get(id),before=older?previous?.nextBefore:null;if(older&&!before)return;
    const history=await api('/api/admin/recoveries/'+encodeURIComponent(id)+'/responses'+(before?'?before='+before:''));
    if(older)history.entries=[...previous.entries,...history.entries];histories.set(id,history);
    if(!$('responseDetails')||$('responseDetails').dataset.orderId!==id)return;
    $('responseDetails').dataset.loaded='1';$('responseBody').innerHTML='<p class="small">显示 '+history.entries.length+' / '+history.total+' 条</p>'+history.entries.map(entry=>'<details><summary>'+date(entry.at)+' · '+esc(entry.stage)+' · '+esc(entry.result)+'</summary><pre>'+esc(JSON.stringify(entry.reasons,null,2))+'</pre></details>').join('');$('olderResponses').disabled=!history.nextBefore;
  }
  async function orderAction(id,action) {
    const order=await findOrder(id),outcome=action.slice('order-'.length);
    if(outcome==='check'){await post('/api/admin/recoveries/'+encodeURIComponent(id)+'/check');await saved('已补查原订单。');if($('detailDialog').open)await openOrder(id);return;}
    const texts={release:'解锁冻结',unlock:'解锁客户卡密',freeze:'冻结待查',success:'确认充值成功',consume:'记为已消耗',cancellation:'确认续费已关闭'};
    const effect={release:'仅在已核实本次未扣款时恢复 1 次。待确认订单同时结为失败并允许原卡密为原账号重试；失败订单只恢复支付卡次数。',unlock:'已核实未开通、未扣款后，原卡密可为原账号重新提交，并释放该订单冻结次数。',freeze:'保留支付占用并暂停卡密重试，等待继续核查。',success:'确认账号已经开通，只更新本站记录，不再次提交充值。',consume:'核实本次确实消耗后，把冻结次数转为已用，不增加剩余次数。',cancellation:'核实账号或上游已关闭自动续费后记录处理结果。'};
    const reasons=state.data.recoveryReasons[outcome]||{};
    const input=await modal(texts[outcome],(order.userEmail||id)+'：'+effect[outcome],'<label>核查依据<select name="reasonCode" required><option value="">请选择核查依据</option>'+Object.entries(reasons).map(([code,text])=>'<option value="'+code+'">'+esc(text)+'</option>').join('')+'</select></label>'+noteField());
    if(!input)return;await post('/api/admin/recoveries/'+encodeURIComponent(id)+'/disposition',{outcome,...input});await saved(texts[outcome]+'已完成。');if($('detailDialog').open)await openOrder(id);
  }
  async function proAction(id,action) {
    const order=await findOrder(id);if(action==='pro-card'){
      const settings=await api('/api/admin/pro/settings');const available=(settings.cards||[]).filter(card=>card.enabled&&card.status==='active'&&!card.missingFromUpstream&&card.remainingUses>0);
      if(!available.length)throw Error('暂无符合条件的人工支付卡。');
      const input=await modal('选择人工支付卡','仅记录本次使用的支付卡，不发起充值。','<label>支付卡<select name="cardId" required>'+available.map(card=>'<option value="'+esc(card.id)+'">•••• '+esc(card.lastFour)+' · $'+esc(card.availableBalance??'未知')+' · 剩余 '+card.remainingUses+'</option>').join('')+'</select></label>');if(!input)return;await post('/api/admin/pro/orders/'+encodeURIComponent(id)+'/select-card',input);
    }else{
      const operation=action.slice(4),title=({note:'保存处理备注','manual-processing':'人工处理中','needs-info':'需补资料','mark-success':'确认人工充值成功','confirm-no-charge':'核实未扣款并转人工'})[operation];
      const input=await modal(title,(order.userEmail||id)+' · '+plan(order.plan)+(operation==='mark-success'?'：确认外部充值已完成，本次只更新本站状态。':operation==='confirm-no-charge'?'：核实原任务未扣款且未成功，记录依据后转人工。':''),noteField('note',operation==='confirm-no-charge'?'核查依据（必填）':'处理备注',order.processingNote||''));if(!input)return;
      if(operation==='confirm-no-charge'&&!input.note.trim())throw Error('请填写核查依据。');await post('/api/admin/pro/orders/'+encodeURIComponent(id)+'/'+operation,{...input,confirmedNoCharge:operation==='confirm-no-charge'});
    }
    await saved('Pro 订单操作已保存。');if($('detailDialog').open)await openOrder(id);
  }
  function voucherDetail(card) {
    let actions=card.code?button('voucher-code','复制卡密',card.id)+button('voucher-link','复制充值链接',card.id):'';
    actions+=card.status==='disabled'?button('voucher-enable','启用卡密',card.id):button('voucher-disable','禁用卡密',card.id);
    if(card.hasSubmission)actions+=button('voucher-archive','归档卡密',card.id);
    if(['locked','reserved','needs_review','processing'].includes(card.operationalStatus))actions+=button('voucher-unlock','解锁卡密',card.id);
    if(card.latestOrder)actions+=button('order-detail','查看关联订单',card.latestOrder.id);
    openDetail('客户卡密', '<p class="mono">'+esc(card.code||card.cardMask)+'</p><div class="detail-grid"><div><p>套餐 / 销售渠道</p>'+plan(card.plan)+' · '+esc(card.source)+'</div><div><p>状态</p>'+badge(card.operationalStatus,card.operationalStatus==='disabled'?'已禁用':null)+'</div><div><p>绑定账号</p>'+esc(card.boundEmail||'未绑定')+'<div class="mono">'+esc(card.boundAccountId||'')+'</div></div><div><p>生成时间</p>'+date(card.createdAt)+'</div><div><p>批次</p><span class="mono">'+esc(card.batchId)+'</span></div></div><div class="actions">'+actions+'</div>');
  }
  const cardLink = card => new URL('/activate/?provider=h&card='+encodeURIComponent(card.code),location.origin).href;
  async function copy(text) { if(!text)throw Error('没有可复制的内容。');await navigator.clipboard.writeText(text);notify('已复制。'); }
  function downloadZip(rows,type,name='充值链接') {
    if(!rows.length)throw Error('请先选择卡密。');
    const encoder=new TextEncoder(),u16=n=>new Uint8Array([n&255,(n>>>8)&255]),u32=n=>new Uint8Array([n&255,(n>>>8)&255,(n>>>16)&255,(n>>>24)&255]);
    const concat=parts=>{const output=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){output.set(part,offset);offset+=part.length;}return output;};
    const crc=bytes=>{let n=0xffffffff;for(const byte of bytes){n^=byte;for(let i=0;i<8;i++)n=(n>>>1)^(n&1?0xedb88320:0);}return(n^0xffffffff)>>>0;};
    const local=[],central=[];let offset=0;
    const fileNames=window.cardDownloadNames.files(rows);
    rows.forEach((card,i)=>{const filename=encoder.encode(fileNames[i]),data=encoder.encode((type==='codes'?card.code:cardLink(card))+'\n'),checksum=crc(data);
      const a=concat([new Uint8Array([80,75,3,4,20,0,0,8,0,0,0,0,0,0]),u32(checksum),u32(data.length),u32(data.length),u16(filename.length),u16(0),filename,data]);
      local.push(a);central.push(concat([new Uint8Array([80,75,1,2,20,0,20,0,0,8,0,0,0,0,0,0]),u32(checksum),u32(data.length),u32(data.length),u16(filename.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),filename]));offset+=a.length;});
    const directory=concat(central),end=concat([new Uint8Array([80,75,5,6,0,0,0,0]),u16(rows.length),u16(rows.length),u32(directory.length),u32(offset),u16(0)]);
    const url=URL.createObjectURL(new Blob([concat([...local,directory,end])],{type:'application/zip'})),a=document.createElement('a');a.href=url;a.download=name+'.zip';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);notify('已下载 '+rows.length+' 个 TXT，每张卡一个文件。文件名示例：'+fileNames[0]);
  }
  async function batchExport() {
    const batch=$('batchFilter').value;if(!batch)throw Error('请先选择要导出的生成批次。');
    const result=await api('/api/admin/h-cards?all=1&reveal=1');const rows=result.cards.filter(c=>c.batchId===batch&&c.code).sort((a,b)=>a.sequence-b.sequence);
    if(!rows.length)throw Error('未找到该批次卡密。');state.exportBatch=rows;
    openDetail('本批复制 / 导出','<p>本批 '+rows.length+' 张，按原生成顺序导出。包含已使用卡密，请按状态核对发放。</p><div class="actions">'+button('batch-codes','复制本批纯卡密')+button('batch-links','复制本批充值链接')+button('batch-zip','下载本批 TXT ZIP')+'</div>');
  }
  async function bulkPool(action) {
    const cards=state.data.cards.filter(card=>state.poolSelected.has(card.uid));if(!cards.length)throw Error('请先选择支付卡。');
    const add=action==='pool-bulk-add',cap=action==='pool-bulk-cap',input=await modal(add?'批量增加次数':cap?'批量设置总次数':'批量停用','本次处理 '+cards.length+' 张支付卡。',add||cap?field(add?'每张增加次数':'每张总次数','amount',add?1:4,'number','min="1" max="100" required'):'');if(!input)return;
    const errors=[];let completed=0;for(const card of cards){try{if(add)await addUses(card,Number(input.amount));else if(cap)await post('/api/admin/zzshu/cards/'+encodeURIComponent(card.usageId),{maxSuccess:Number(input.amount)});else await post(card.kind==='h'?'/api/admin/hifupay/cards/'+encodeURIComponent(card.id)+'/disable':'/api/admin/zzshu/cards/'+encodeURIComponent(card.id),card.kind==='h'?{}:{enabled:false});state.poolSelected.delete(card.uid);completed++;}catch(error){errors.push(card.lastFour+'：'+error.message);}}
    await refresh();notify('成功 '+completed+' 张，失败 '+errors.length+' 张。'+(errors.length?'\n'+errors.join('\n'):''),Boolean(errors.length));
  }
  async function loadProSettings() {
    const x=await api('/api/admin/pro/settings');$('proEnabled').value=String(Boolean(x.enabled));$('proRegion').value=x.region;$('proCharge').value=x.estimatedChargeUsd;$('proBuffer').value=x.safetyBufferUsd;
    $('proCardId').innerHTML='<option value="">未选择</option>'+(x.cards||[]).map(card=>'<option value="'+esc(card.id)+'">•••• '+esc(card.lastFour)+' · $'+esc(card.availableBalance??'未知')+' · '+esc(labels[card.poolStatus]||card.poolStatus)+'</option>').join('');$('proCardId').value=x.cardId;state.proLoaded=true;$('proSettingsMessage').textContent=x.enabled?'当前自动充值已开启。':'当前为人工模式，自动充值关闭。';
  }
  async function batchQuery() {
    const input=await modal('批量查询客户卡密','每行一张卡密或充值链接，最多 100 条。','<label>卡密或充值链接<textarea name="inputs" required></textarea></label>');if(!input)return;
    const data=await post('/api/admin/h-cards/query',{inputs:input.inputs.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)});
    const rows=data.results||data.cards||[];state.queryRows=rows;
    openDetail('批量查询结果','<div class="actions">'+button('query-copy','复制查询结果')+'</div>'+rows.map(row=>'<div class="history-item"><span class="mono">'+esc(row.code||'无效输入')+'</span> '+badge(row.status,row.statusLabel)+'<p>'+esc(row.boundAccount||'未绑定')+' · '+esc(row.source||'')+' · '+esc(row.failureReason||'')+'</p></div>').join(''));
  }
  async function dispatch(action,id) {
    const card=id?paymentCard(id):null,voucher=id?state.knownVouchers.get(id):null;
    if(action==='open-import'||action==='open-generate'){const panel=$(action==='open-import'?'importPanel':'generatePanel');panel.open=true;panel.scrollIntoView({behavior:'smooth',block:'center'});return;}
    if(action==='open-settings'){$('settingsPanel').open=true;$('settingsPanel').scrollIntoView({behavior:'smooth',block:'start'});return;}
    if(action==='save-home-preferences'){const n=Number($('capacityThreshold').value);if(!Number.isInteger(n)||n<0||n>10000)throw Error('阈值必须是 0～10000 的整数，0 表示关闭提醒。');try{localStorage.setItem('gptc.home.capacityThreshold',String(n));}catch{throw Error('当前浏览器无法保存设置。');}renderAttention();notify('当前浏览器的容量提醒阈值已保存。');return;}
    if(action==='attention-all'){state.params.orderView='attention';state.params.orderPage=1;await refresh();$('recent-orders').scrollIntoView({behavior:'smooth'});return;}
    if(action==='refresh'){await refresh();return;}
    if(action==='close-detail'){$('detailDialog').close();return;}
    if(action==='cancel-modal')return;
    if(action==='pool-filter'){state.poolView=id;renderPool();return;}
    if(action==='pool-select'){for(const card of poolRows())state.poolSelected.add(card.uid);renderPool();return;}
    if(action==='pool-clear'){state.poolSelected.clear();renderPool();return;}
    if(action.startsWith('pool-bulk-')){await bulkPool(action);return;}
    if(action==='sync-h'){await api('/api/admin/hifupay/cards?refresh=1');await saved('嗨付卡片已同步。');return;}
    if(action==='card-add-one'||action==='card-add'){if(!card)throw Error('支付卡状态已变化，请刷新。');await cardAdd(card,action==='card-add-one');return;}
    if(action==='card-release'){if(!card)throw Error('支付卡状态已变化，请刷新。');await releaseCard(card);return;}
    if(action==='card-copy-standard'){if(!card)throw Error('支付卡状态已变化，请刷新。');const result=await post('/api/admin/payment-cards/'+card.kind+'/'+encodeURIComponent(card.id)+'/copy-standard');await copy(result.text);return;}
    if(action==='card-detail'){if(card)cardDetail(card);return;}
    if(action.startsWith('card-')){if(!card)throw Error('支付卡状态已变化，请刷新。');await cardSetting(card,action);return;}
    if(action==='preview-import'){
      const text=$('importText').value,data=await post('/api/admin/zzshu/preview',{text});if($('importText').value!==text){state.importPreview=false;$('confirmImport').disabled=true;notify('支付卡资料已变化，请重新预览。',true);return;}state.importPreview=data.some(row=>['ready','restore'].includes(row.status));$('confirmImport').disabled=!state.importPreview;
      $('importMessage').textContent=data.map(row=>'第 '+row.line+' 行 · '+(row.masked||'')+' · '+({ready:'可导入',duplicate:'重复跳过',restore:'可恢复',pending:'待核查',error:'格式错误'})[row.status]+(row.error?' · '+row.error:'')).join('\n');return;
    }
    if(action==='order-filter'){state.params.orderView=id;state.params.orderPage=1;await refresh();return;}
    if(action==='voucher-filter'){state.params.voucherStatus=id;state.params.voucherPage=1;await refresh();return;}
    if(['order-prev','order-next','voucher-prev','voucher-next'].includes(action)){const section=action.startsWith('order')?'orders':'vouchers',key=section==='orders'?'orderPage':'voucherPage';state.params[key]=state.data[section].page+(action.endsWith('next')?1:-1);await refresh();return;}
    if(action==='order-detail'){await openOrder(id);return;}
    if(['order-json','order-submitted-json'].includes(action)){const detail=await api('/api/admin/recoveries/'+encodeURIComponent(id)+'?reveal=1');await copy(action==='order-json'?detail.secretJsonText:detail.submittedJsonText);return;}
    if(['order-code','order-uuid'].includes(action)){const order=await findOrder(id);await copy(action==='order-code'?order.customerCardCode:order.accountId);return;}
    if(action==='order-upstream-usage'){$('detailDialog').close();$('settingsPanel').open=true;$('zzshu-query').scrollIntoView({behavior:'smooth'});await window.loadZzshuUsage(1);return;}
    if(action.startsWith('order-')&&['release','unlock','freeze','success','consume','cancellation','check'].includes(action.slice(6))){await orderAction(id,action);return;}
    if(action==='responses-refresh'||action==='responses-older'){await loadResponses(id,action.endsWith('older'));return;}
    if(action.startsWith('pro-')){await proAction(id,action);return;}
    if(action==='legacy-success'||action==='legacy-subscription'){const order=await findOrder(id),input=await modal(action==='legacy-success'?'确认充值成功':'标记续费已处理',order.userEmail+'：请核实外部处理结果，本次只更新本站记录。');if(!input)return;await post('/api/admin/recoveries/'+encodeURIComponent(id)+'/'+(action==='legacy-success'?'mark-success':'mark-subscription-handled'));await saved();if($('detailDialog').open)await openOrder(id);return;}
    if(action==='voucher-detail'){if(voucher)voucherDetail(voucher);return;}
    if(action==='voucher-code'||action==='voucher-link'){if(!voucher?.code)throw Error('卡密暂不可读取，请刷新。');await copy(action==='voucher-code'?voucher.code:cardLink(voucher));return;}
    if(action==='voucher-select'){for(const card of state.data.vouchers.items)state.voucherSelected.add(card.id);renderVouchers();return;}
    if(action==='voucher-clear'){state.voucherSelected.clear();renderVouchers();return;}
    if(action==='voucher-unlock'){
      if(voucher.latestOrder?.provider==='zzshu'){await orderAction(voucher.latestOrder.id,'order-unlock');return;}
      const input=await modal('解锁客户卡密','确认已核查此卡密关联的原订单，没有扣款或开通。');if(!input)return;await post('/api/admin/h-cards/'+encodeURIComponent(id)+'/unlock');$('detailDialog').close();await saved('客户卡密已解锁。');return;
    }
    if(['voucher-disable','voucher-enable','voucher-archive'].includes(action)){const operation=action.slice(8),input=await modal(({disable:'禁用客户卡密',enable:'启用客户卡密',archive:'归档客户卡密'})[operation],voucher?.code||id);if(!input)return;await post('/api/admin/h-cards/'+encodeURIComponent(id)+'/'+operation);state.voucherSelected.delete(id);$('detailDialog').close();await saved();return;}
    if(action.startsWith('voucher-bulk-')){
      if(!state.voucherSelected.size)throw Error('请先选择客户卡密。');const operation=action.slice(13),input=await modal('批量'+({disable:'禁用',enable:'启用',archive:'归档'})[operation]+'卡密','本次处理 '+state.voucherSelected.size+' 张客户卡密。');if(!input)return;
      const result=await post('/api/admin/h-cards/bulk',{cardIds:[...state.voucherSelected],action:operation});for(const item of result.results||[])if(item.ok)state.voucherSelected.delete(item.cardId);await refresh();notify('成功 '+result.successCount+' 张，失败 '+result.failedCount+' 张。'+(result.failedCount?'\n'+result.results.filter(x=>!x.ok).map(x=>x.message).join('\n'):''),Boolean(result.failedCount));return;
    }
    if(action.startsWith('generated-')){const rows=state.generated;if(!rows.length)throw Error('请先生成卡密。');if(action==='generated-zip')downloadZip(rows,'links');else await copy(rows.map(card=>action==='generated-codes'?card.code:cardLink(card)).join('\n'));return;}
    if(action.startsWith('selected-')){const rows=[...state.voucherSelected].map(id=>state.knownVouchers.get(id)).filter(card=>card?.code);if(!rows.length)throw Error('请先选择可读取的卡密。');if(action==='selected-codezip'||action==='selected-linkzip')downloadZip(rows,action==='selected-codezip'?'codes':'links',action==='selected-codezip'?'客户卡密':'充值链接');else await copy(rows.map(card=>action==='selected-codes'?card.code:cardLink(card)).join('\n'));return;}
    if(action==='batch-export'){await batchExport();return;}
    if(['batch-codes','batch-links','batch-zip'].includes(action)){const rows=state.exportBatch||[];if(action==='batch-zip')downloadZip(rows,'links');else await copy(rows.map(card=>action==='batch-codes'?card.code:cardLink(card)).join('\n'));return;}
    if(action==='batch-query'){await batchQuery();return;}
    if(action==='query-copy'){await copy((state.queryRows||[]).map(row=>[row.code,row.statusLabel,row.boundAccount,row.source,row.failureReason].join('\t')).join('\n'));return;}
    if(action==='sync-uuid'){await post('/api/admin/recoveries/sync-account-ids');await saved('账号 UUID 已同步。');return;}
    if(action==='order-alerts'){if(!('Notification' in window))throw Error('当前浏览器不支持桌面提醒。');const permission=await Notification.requestPermission();state.notifications=permission==='granted';$('alertsButton').textContent=state.notifications?'桌面提醒已开启':'开启桌面提醒';notify(state.notifications?'本页桌面提醒已开启。':'未获准发送桌面提醒。',!state.notifications);return;}
    if(action==='load-pro-settings'){await loadProSettings();return;}
  }
  async function perform(key,fn,buttonEl) {
    if(state.busy.has(key))return;state.busy.add(key);if(buttonEl)buttonEl.disabled=true;
    try{await fn();}catch(error){notify(error.message||'操作未完成，请刷新核查。',true);}finally{state.busy.delete(key);if(buttonEl&&buttonEl.isConnected)buttonEl.disabled=buttonEl.id==='confirmImport'?!state.importPreview:false;}
  }
  document.addEventListener('click',event=>{
    const shortcut=event.target.closest('[data-shortcut]');if(shortcut){const type=shortcut.dataset.shortcut;if(['active','ready','uses','frozen'].includes(type)){state.poolView=type==='active'?'all':type==='frozen'?'frozen':type==='uses'?'current':'ready';$('poolSearch').value='';renderPool();$('payment-pool').scrollIntoView({behavior:'smooth'});}else{const vouchers=type==='unused';state.params[vouchers?'voucherStatus':'orderView']=vouchers?'stock':'attention';state.params[vouchers?'voucherPage':'orderPage']=1;refresh().then(() => $(vouchers?'recent-vouchers':'recent-orders').scrollIntoView({behavior:'smooth'}));}return;}
    const el=event.target.closest('[data-action]');if(!el||el.disabled||el.dataset.action==='cancel-modal')return;
    perform(el.dataset.action+':'+(el.dataset.id||''),()=>dispatch(el.dataset.action,el.dataset.id||''),el);
  });
  document.addEventListener('change',event=>{
    const el=event.target;if(el.dataset.poolSelect){el.checked?state.poolSelected.add(el.dataset.poolSelect):state.poolSelected.delete(el.dataset.poolSelect);$('poolSelected').textContent='已选 '+state.poolSelected.size+' 张';return;}
    if(el.dataset.voucherSelect){el.checked?state.voucherSelected.add(el.dataset.voucherSelect):state.voucherSelected.delete(el.dataset.voucherSelect);$('voucherSelected').textContent='已选 '+state.voucherSelected.size+' 张';return;}
  });
  $('poolRows').onchange=event=>{const uid=event.target.dataset.cardSource;if(!uid)return;const card=state.data.cards.find(c=>c.uid===uid);if(!card||card.kind!=='manual')return;const value=event.target.value;perform('source:'+uid,async()=>{try{if(value==='__custom__')await cardSetting(card,'card-source');else{await post('/api/admin/zzshu/cards/'+encodeURIComponent(card.usageId),{source:value});await saved('尾号 '+card.lastFour+' 的来源渠道已保存。');}}finally{renderPool();}},event.target);};
  window.paymentCardSourceUI.bindImport($('importSource'),$('importCustomSource'));
  const importFormatter=window.paymentCardFormatter.mount($('importText'),$('importFormatter'));
  $('poolSearch').oninput=renderPool;
  for(const id of ['orderSearch','orderStatus','orderPlan','orderProvider','orderSource','voucherSearch','voucherPlan','voucherSource','batchFilter','voucherDate']){
    const el=$(id),key=id==='batchFilter'?'batch':id;const change=()=>{state.params[key]=el.value;state.params[id.startsWith('order')?'orderPage':'voucherPage']=1;refresh();};if(el.type==='search')el.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(change,300);};else el.onchange=change;
  }
  $('generateSource').onchange=()=>{const custom=$('generateSource').value==='custom';$('generateCustom').hidden=!custom;$('generateCustom').required=custom;};
  $('importText').oninput=()=>{state.importPreview=false;$('confirmImport').disabled=true;};
  $('importForm').onsubmit=event=>{event.preventDefault();perform('import',async()=>{if(!state.importPreview)throw Error('请先检查脱敏预览。');const result=await post('/api/admin/zzshu/import',{text:$('importText').value,source:window.paymentCardSourceUI.importSource($('importSource'),$('importCustomSource')),note:$('importNote').value,maxSuccess:Number($('importCap').value),enabled:$('importEnabled').checked});
    const successful=result.filter(row=>['imported','restored'].includes(row.status));$('importMessage').textContent=result.map(row=>'第 '+row.line+' 行 · '+(row.masked||'')+' · '+({imported:'已导入',restored:'已恢复',duplicate:'重复跳过',error:'导入失败',pending:'待核查'})[row.status]+(row.error?' · '+row.error:'')).join('\n');
    if(successful.length){$('importText').value='';importFormatter.refresh();state.importPreview=false;$('confirmImport').disabled=true;state.poolView='all';$('poolSearch').value='';await saved('已导入 / 恢复 '+successful.length+' 张支付卡。');}else notify('未新增支付卡，请查看逐行结果。',true);
  },$('confirmImport'));};
  $('generateForm').onsubmit=event=>{event.preventDefault();perform('generate',async()=>{const source=$('generateSource').value==='custom'?$('generateCustom').value.trim():$('generateSource').value;if(!source)throw Error('请填写销售渠道。');const result=await post('/api/admin/h-cards',{count:Number($('generateCount').value),source,plan:$('generatePlan').value,productId:3});state.generated=result.cards;
    state.params.batch=result.cards[0]?.batchId||'';state.params.voucherStatus='';state.params.voucherPage=1;state.params.voucherSearch='';for(const key of ['voucherPlan','voucherSource','voucherDate']){state.params[key]='';$(key).value='';}$('voucherSearch').value='';$('generatedExports').hidden=false;$('generatedInfo').textContent='已生成 '+result.cards.length+' 张';await saved('卡密已生成，当前列表显示本次批次。');$('batchFilter').value=state.params.batch;
  },$('generateForm').querySelector('[type=submit]'));};
  $('proSettingsForm').onsubmit=event=>{event.preventDefault();perform('pro-settings',async()=>{if(!state.proLoaded)throw Error('请先读取当前 Pro 设置。');await post('/api/admin/pro/settings',{enabled:$('proEnabled').value==='true',cardId:$('proCardId').value,region:$('proRegion').value,estimatedChargeUsd:Number($('proCharge').value),safetyBufferUsd:Number($('proBuffer').value)});await loadProSettings();await saved('Pro 设置已保存。');},$('proSettingsForm').querySelector('[type=submit]'));};
  $('settingsPanel').addEventListener('toggle',()=>{if($('settingsPanel').open&&!state.proLoaded)loadProSettings().catch(error=>notify(error.message,true));});
  function revealHash() { if(['#protocol-settings','#zzshu-query'].includes(location.hash)){$('settingsPanel').open=true;$(location.hash.slice(1)).scrollIntoView({behavior:'smooth'});} }
  window.addEventListener('hashchange',revealHash);revealHash();
  $('detailDialog').addEventListener('close',()=>{$('detailBody').replaceChildren();});
  refresh();
  setInterval(()=>{if((!document.hidden||state.notifications)&&!state.busy.size&&!$('actionDialog').open&&!$('detailDialog').open&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))refresh(true);},20000);
})();
