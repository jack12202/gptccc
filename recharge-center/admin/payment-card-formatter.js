(() => {
  'use strict';
  const parser = import('/admin/cards/payment-card-input.js');
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  window.paymentCardFormatter = {
    mount(input,host) {
      let helpers,rows=[],version=0;
      host.innerHTML='<div class="format-top"><div><h3>ZZS 一次粘贴格式</h3><p>粘贴资料后自动整理为 卡号----MM/YY----CVV----，复制到 ZZS 的卡号框即可一次填齐。</p></div><div class="format-actions"><button type="button" data-format-copy="all" disabled>复制全部</button><button type="button" data-format-clear>清空输入与输出</button></div></div><div class="format-summary" aria-live="polite"></div><div class="format-rows"></div><p class="format-message" role="status"></p>';
      const result=host.querySelector('.format-rows'),summary=host.querySelector('.format-summary'),message=host.querySelector('.format-message'),all=host.querySelector('[data-format-copy="all"]');
      const refresh=()=>{
        version++;rows=helpers?helpers.parseCardInputs(input.value).filter(row=>row.status!=='empty'):[];
        const valid=rows.filter(row=>row.status==='ready');all.disabled=!valid.length;all.textContent='复制全部';message.textContent='';
        summary.textContent=rows.length?rows.length+' 条结果 · '+valid.length+' 条可复制':helpers?'在上方粘贴卡片资料，结果会自动显示。':'正在加载格式识别…';
        result.innerHTML=rows.map(row=>'<div class="format-row '+(row.status==='ready'?'':'format-error')+'"><div class="format-row-head"><span>第 '+row.line+' 行 · '+(row.status==='ready'?'识别通过':row.status==='duplicate'?'重复已跳过':'格式错误')+'</span>'+(row.status==='ready'?'<button type="button" data-format-copy="'+row.line+'">复制</button>':'')+'</div>'+(row.status==='ready'?'<code class="formatted-code">'+esc(helpers.formatPaymentCard(row.payment))+'</code>':'<p>'+esc(row.masked||'')+' · '+esc(row.error||'请检查此行')+'</p>')+'</div>').join('');
      };
      input.addEventListener('input',refresh);
      host.addEventListener('click',async event=>{
        if(event.target.closest('[data-format-clear]')){input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return;}
        const button=event.target.closest('[data-format-copy]');if(!button||button.disabled||!helpers)return;
        const selected=button.dataset.formatCopy==='all'?rows.filter(row=>row.status==='ready'):rows.filter(row=>row.status==='ready'&&row.line===Number(button.dataset.formatCopy));
        if(!selected.length)return;
        const text=selected.map(row=>helpers.formatPaymentCard(row.payment)).join('\n'),currentVersion=version;
        button.disabled=true;
        try{
          await navigator.clipboard.writeText(text);
          if(currentVersion===version){message.textContent='已复制 '+selected.length+' 条，可粘贴到 ZZS 的卡号框。';button.textContent='已复制';}
        }catch{
          if(currentVersion===version)message.textContent='复制未成功，可选中下方输出手动复制。';
        }finally{if(button.isConnected)button.disabled=false;}
      });
      refresh();
      parser.then(module=>{helpers=module;refresh();}).catch(()=>{summary.textContent='格式识别暂时无法加载，请刷新页面。';});
      return {refresh};
    }
  };
})();
