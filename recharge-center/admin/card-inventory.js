(() => {
  'use strict';
  const $=id=>document.getElementById(id),api=window.adminApi;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const names={plus:'Plus',pro_x5:'Pro 5x',pro_x20:'Pro 20x'};
  const day=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
  const state={data:null,query:{view:'unused',page:1,size:20},selected:new Set(),generated:[],fresh:new Set(),busy:false,loading:false,filterPending:false,sequence:0};
  const post=(url,body)=>api(url,{method:'POST',body:JSON.stringify(body)});
  let noticeTimer;
  function notice(message,error=false){clearTimeout(noticeTimer);$('statusBox').textContent=message;$('statusBox').classList.toggle('error',error);$('statusBox').hidden=!message;noticeTimer=setTimeout(()=>$('statusBox').hidden=true,error?15000:6000);}
  function options(id,rows,first){const el=$(id),previous=el.value;el.innerHTML='<option value="">'+first+'</option>'+rows.map(row=>'<option value="'+esc(row.value??row)+'">'+esc(row.label??row)+'</option>').join('');el.value=previous;}
  function url(extra={}){return '/api/admin/card-inventory?'+new URLSearchParams(Object.entries({...state.query,...extra}).filter(([,value])=>value!==''&&value!=null));}
  function cardLink(card){return new URL('/activate/?provider=h&card='+encodeURIComponent(card.code),location.origin).href;}
  function action(name,label,id,extra=''){return '<button type="button" data-action="'+name+'" data-id="'+esc(id)+'" '+extra+(state.busy||state.loading||state.filterPending?' disabled':'')+'>'+label+'</button>';}
  function drawSelection(){
    for(const id of ['planFilter','sourceFilter','batchFilter','dateFilter','pageSize','search','clearFilters','openGenerate','refresh'])$(id).disabled=state.busy;
    for(const node of document.querySelectorAll('[data-select]'))node.disabled=state.busy||state.loading||state.filterPending;
    $('selectedCount').textContent='已选 '+state.selected.size+' 张';
    $('pageCheckbox').checked=Boolean(state.data?.items.length)&&state.data.items.every(card=>state.selected.has(card.id));
    for(const button of document.querySelectorAll('[data-selection]'))button.disabled=state.busy||state.loading||state.filterPending||!state.selected.size;
    $('selectPage').disabled=state.busy||state.loading||state.filterPending||!state.data?.items.length;
    $('pageCheckbox').disabled=state.busy||state.loading||state.filterPending;
  }
  function render(){
    const d=state.data;if(!d)return;
    $('stockStats').innerHTML=Object.entries(d.stock).map(([plan,count])=>'<button class="stat" data-stock="'+plan+'"><strong>'+count+'</strong><small>'+names[plan]+' · 可发放</small></button>').join('');
    $('inventoryTabs').innerHTML=[['unused','未使用'],['attention','已绑定 / 待处理'],['used','已使用'],['all','全部']].concat(d.view==='archived'?[['archived','已归档']]:[]).map(([view,label])=>'<button data-view="'+view+'" class="'+(d.view===view?'active':'')+'">'+label+' '+d.counts[view]+'</button>').join('');
    $('scopeHint').textContent=d.view==='unused'?'当前仅展示可发放库存，已绑定或提交过资料的卡密单独管理。':d.view==='attention'?'这些卡密已绑定或提交过资料，请核查原账号与订单后处理。':'按当前状态查看历史卡密。';
    $('inventoryRows').innerHTML=d.items.map(card=>{
      const more=[card.orderCount?'<a href="/admin/recoveries?cardId='+encodeURIComponent(card.id)+'">查看订单（'+card.orderCount+'）</a>':'',
        card.preferredOrder?.hasOriginalJson?action('copy-json','复制订单 JSON',card.preferredOrder.id):'',
        card.archivedAt?action('restore','恢复归档',card.id):'',
        !card.archivedAt&&card.hasSubmission?action('archive','归档',card.id):'',
        !card.archivedAt&&['locked','reserved'].includes(card.status)?action('unlock','解锁卡密',card.id):'',
        !card.archivedAt?card.status==='disabled'?action('enable','启用',card.id):action('disable','禁用',card.id):'',
        !card.archivedAt&&!card.hasSubmission&&['unused','expired','disabled'].includes(card.status)?action('delete','删除',card.id,'class="danger"'):''].filter(Boolean).join('');
      return '<tr class="'+(state.fresh.has(card.id)?'fresh':'')+'"><td><input type="checkbox" class="check" data-select="'+esc(card.id)+'" aria-label="选择卡密 '+esc((card.code||card.cardMask||card.id).slice(-6))+'" '+(state.selected.has(card.id)?'checked':'')+'></td><td><div class="small">批次序号 '+esc(window.cardDownloadNames.sequence(card))+'</div><span class="code">'+esc(card.code||card.cardMask||'无法读取')+'</span>'+(state.fresh.has(card.id)?' <span class="badge">新生成</span>':'')+(card.boundEmail||card.boundAccountId?'<div class="small bound-info">绑定：'+esc(card.boundEmail||card.boundAccountId)+'</div>':'')+'</td><td>'+esc(names[card.plan]||'未知套餐')+'</td><td>'+esc(card.source||'未分类')+'</td><td><span class="badge '+card.group+'">'+esc(card.statusLabel)+'</span></td><td class="small">'+day(card.createdAt)+'</td><td><div class="row-actions">'+(card.code?action('copy-code','复制卡密',card.id)+action('copy-link','复制链接',card.id):'')+(more?'<details class="more"><summary>更多</summary><div class="more-menu">'+more+'</div></details>':'')+'</div></td></tr>';
    }).join('')||'<tr><td colspan="7" class="empty">'+(d.view==='unused'?'当前没有可发放的未使用卡密。可点击右上角“＋生成卡密”补充库存。':'暂无匹配卡密。')+'</td></tr>';
    $('resultCount').textContent='共 '+d.matched+' 张';$('pageInfo').textContent='第 '+d.page+' / '+d.pages+' 页';$('prev').disabled=state.busy||state.loading||state.filterPending||d.page===1;$('next').disabled=state.busy||state.loading||state.filterPending||d.page===d.pages;
    options('sourceFilter',d.sources,'全部销售渠道');options('batchFilter',d.batches.map(batch=>({value:batch.id,label:day(batch.createdAt)+' · '+batch.source+' · '+batch.size+' 张'})),'全部批次');
    drawSelection();
  }
  async function refresh(silent=false){
    const sequence=++state.sequence;state.loading=true;drawSelection();
    try{const data=await api(url());if(sequence!==state.sequence)return false;state.data=data;state.query.page=data.page;
      const ids=new Set(data.items.map(card=>card.id));for(const id of state.selected)if(!ids.has(id))state.selected.delete(id);
      state.loading=false;render();if(!silent)notice('库存已更新。');return true;
    }catch(error){if(sequence===state.sequence){state.loading=false;render();notice('库存读取失败，请刷新后再操作。',true);}return false;}
  }
  function resetFilters(){clearTimeout(searchTimer);state.filterPending=false;for(const id of ['search','planFilter','sourceFilter','batchFilter','dateFilter'])$(id).value='';state.query={view:'unused',page:1,size:Number($('pageSize').value)||20};state.selected.clear();}
  async function changeView(view){state.query.view=view;state.query.page=1;state.selected.clear();await refresh();}
  async function perform(fn){
    if(state.busy||state.loading||state.filterPending)return;state.busy=true;render();
    try{await fn();}catch(error){notice(error.message||'操作未完成，请刷新核查。',true);}
    finally{state.busy=false;render();}
  }
  async function currentRows(ids){
    if(!ids.length)throw Error('请先选择卡密。');
    const snapshot=await api(url({ids:ids.join(','),page:1,size:100})),rows=snapshot.items;
    if(rows.length!==ids.length||rows.some(card=>!card.code)){state.selected.clear();await refresh(true);throw Error('所选卡密状态已变化或资料无法读取，请重新核查后选择。');}
    return rows;
  }
  async function copyRows(rows,type){if(!rows.length)throw Error('请先选择卡密。');await navigator.clipboard.writeText(rows.map(card=>type==='links'?cardLink(card):card.code).join('\n'));notice('已复制 '+rows.length+' 张'+(type==='links'?'充值链接。':'卡密。'));}
    function downloadBlob(blob, name) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = name;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }
    function concatBytes(parts) {
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const output = new Uint8Array(total);
      let offset = 0;
      parts.forEach(part => { output.set(part, offset); offset += part.length; });
      return output;
    }
    function crc32(bytes) {
      let crc = 0xffffffff;
      for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      return (crc ^ 0xffffffff) >>> 0;
    }
    function zipFiles(files) {
      const encoder = new TextEncoder();
      const localParts = [];
      const centralParts = [];
      let offset = 0;
      const u16 = value => new Uint8Array([value & 255, (value >>> 8) & 255]);
      const u32 = value => new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]);
      files.forEach(file => {
        const name = encoder.encode(file.name);
        const data = encoder.encode(file.text);
        const checksum = crc32(data);
        const local = concatBytes([new Uint8Array([80, 75, 3, 4, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0]), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data]);
        const central = concatBytes([new Uint8Array([80, 75, 1, 2, 20, 0, 20, 0, 0, 8, 0, 0, 0, 0, 0, 0]), u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]);
        localParts.push(local);
        centralParts.push(central);
        offset += local.length;
      });
      const central = concatBytes(centralParts);
      const end = concatBytes([new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0]), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0)]);
      return new Blob([concatBytes([...localParts, central, end])], { type: "application/zip" });
    }
  function downloadRows(rows){
    if(!rows.length)throw Error('请先选择卡密。');
    const fileNames=window.cardDownloadNames.files(rows);
    const files=rows.map((card,index)=>({name:fileNames[index],text:cardLink(card)+'\n'}));
    downloadBlob(zipFiles(files),'充值链接-'+rows.length+'张.zip');notice('已下载 '+rows.length+' 张链接的 TXT ZIP。文件名示例：'+files[0].name);
  }
  document.addEventListener('change',event=>{
    if(event.target.dataset.select){event.target.checked?state.selected.add(event.target.dataset.select):state.selected.delete(event.target.dataset.select);drawSelection();}
  });
  document.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button||button.disabled)return;
    if(button.dataset.view){if(!state.busy&&!state.loading)changeView(button.dataset.view);return;}
    if(button.dataset.stock){if(state.busy||state.loading||state.filterPending)return;resetFilters();state.query.plan=button.dataset.stock;$('planFilter').value=button.dataset.stock;refresh();return;}
    if(button.dataset.bulk){
      perform(async()=>{const ids=[...state.selected],action=button.dataset.bulk;if(!ids.length)throw Error('请先勾选卡密。');
        if(!confirm('确认对已选 '+ids.length+' 张执行“'+button.textContent+'”？'+(action==='delete'?'删除无法恢复。':'')))return;
        const result=await post('/api/admin/h-cards/bulk',{cardIds:ids,action});state.selected.clear();await refresh(true);notice('成功 '+result.successCount+' 张，未处理 '+result.failedCount+' 张。');});return;
    }
    if(button.dataset.action){
      perform(async()=>{const action=button.dataset.action,id=button.dataset.id;
        if(action==='copy-code'||action==='copy-link'){const rows=await currentRows([id]);await copyRows(rows,action==='copy-link'?'links':'codes');return;}
        if(action==='copy-json'){const detail=await api('/api/admin/recoveries/'+encodeURIComponent(id)+'?reveal=1');if(!detail.secretJsonText)throw Error('该订单没有留存 JSON。');await navigator.clipboard.writeText(detail.secretJsonText);notice('订单 JSON 已复制。');return;}
        if(['delete','archive','disable'].includes(action)&&!confirm(action==='delete'?'确认永久删除这张未提交资料的卡密？删除无法恢复。':action==='archive'?'确认归档？充值记录继续保留。':'确认禁用这张卡密？'))return;
        await post('/api/admin/h-cards/'+encodeURIComponent(id)+'/'+action,{});await refresh(true);notice('操作已保存。');});return;
    }
  });
  $('refresh').onclick=()=>{if(!state.busy)refresh();};
  $('clearFilters').onclick=()=>{if(state.busy||state.loading||state.filterPending)return;resetFilters();refresh();};
  let searchTimer;
  for(const [id,key]of [['search','search'],['planFilter','plan'],['sourceFilter','source'],['batchFilter','batch'],['dateFilter','date'],['pageSize','size']]){
    const change=()=>{if(state.busy)return;state.query[key]=$(id).value;state.query.page=1;state.selected.clear();refresh();};
    if(id==='search')$(id).oninput=()=>{if(state.busy)return;clearTimeout(searchTimer);state.query.search=$(id).value;state.query.page=1;state.selected.clear();state.filterPending=true;drawSelection();searchTimer=setTimeout(()=>{state.filterPending=false;refresh();},250);};else $(id).onchange=change;
  }
  for(const [id,delta]of [['prev',-1],['next',1]])$(id).onclick=()=>{if(state.busy||state.loading||state.filterPending)return;state.query.page=state.data.page+delta;state.selected.clear();refresh();};
  $('selectPage').onclick=()=>{state.data?.items.forEach(card=>state.selected.add(card.id));render();};
  $('pageCheckbox').onchange=event=>{state.selected.clear();if(event.target.checked)state.data?.items.forEach(card=>state.selected.add(card.id));render();};
  $('clearSelection').onclick=()=>{state.selected.clear();render();};
  $('copySelectedCodes').onclick=()=>perform(async()=>copyRows(await currentRows([...state.selected]),'codes'));
  $('copySelectedLinks').onclick=()=>perform(async()=>copyRows(await currentRows([...state.selected]),'links'));
  $('downloadSelectedZip').onclick=()=>perform(async()=>downloadRows(await currentRows([...state.selected])));
  $('openGenerate').onclick=()=>{if(state.busy||state.loading||state.filterPending)return;$('generateDialog').showModal();};
  for(const id of ['closeGenerate','cancelGenerate'])$(id).onclick=()=>{if(!state.busy)$('generateDialog').close();};
  $('generateDialog').addEventListener('cancel',event=>{if(state.busy)event.preventDefault();});
  $('generateSource').onchange=()=>{const custom=$('generateSource').value==='custom';$('generateCustomSource').hidden=!custom;$('generateCustomSource').required=custom;};
  $('generateForm').onsubmit=async event=>{
    event.preventDefault();if(state.busy||state.loading||state.filterPending)return;
    state.busy=true;for(const id of ['generatePlan','generateCount','generateSource','generateCustomSource','closeGenerate','cancelGenerate'])$(id).disabled=true;$('generateSubmit').disabled=true;$('generateSubmit').textContent='正在生成…';$('generateMessage').hidden=true;
    try{
      const source=$('generateSource').value==='custom'?$('generateCustomSource').value.trim():$('generateSource').value;
      if(!source)throw Error('请填写销售渠道。');
      const plan=$('generatePlan').value;const result=await post('/api/admin/h-cards',{plan,count:Number($('generateCount').value),source,productId:3});
      state.generated=result.cards;state.fresh=new Set(result.cards.map(card=>card.id));
      $('generatedResult').hidden=false;$('generatedInfo').textContent='本次生成 '+result.cards.length+' 张 '+names[plan]+' · '+source;
      $('openGeneratedBatch').href='/admin/cards/library?batch='+encodeURIComponent(result.cards[0].batchId);
      resetFilters();$('generateDialog').close();const loaded=await refresh(true);
      notice(loaded?'新卡已加入未使用库存，已高亮显示。':'卡密已生成，但库存暂时无法刷新；本次复制和下载仍可使用。请勿重复生成。',!loaded);
    }catch(error){$('generateMessage').hidden=false;$('generateMessage').textContent=error.message||'生成未确认，请先刷新库存核查后重试。';$('generateMessage').classList.add('error');}
    finally{state.busy=false;for(const id of ['generatePlan','generateCount','generateSource','generateCustomSource','closeGenerate','cancelGenerate'])$(id).disabled=false;$('generateSubmit').disabled=false;$('generateSubmit').textContent='生成卡密';render();}
  };
  async function generatedRows(){
    if(!state.generated.length)throw Error('当前没有本次生成结果。');
    const data=await api('/api/admin/card-inventory?view=unused&size=100&batch='+encodeURIComponent(state.generated[0].batchId));
    const current=new Map(data.items.map(card=>[card.id,card]));
    const rows=state.generated.map(card=>current.get(card.id));
    if(rows.some(card=>!card?.code))throw Error('本次生成的部分卡密已经使用或绑定，请在库存中核查后选择导出。');
    return rows;
  }
  $('copyGeneratedCodes').onclick=()=>perform(async()=>copyRows(await generatedRows(),'codes'));
  $('copyGeneratedLinks').onclick=()=>perform(async()=>copyRows(await generatedRows(),'links'));
  $('downloadGeneratedZip').onclick=()=>perform(async()=>downloadRows(await generatedRows()));
  $('dismissGenerated').onclick=()=>{$('generatedResult').hidden=true;};
  refresh();
})();
