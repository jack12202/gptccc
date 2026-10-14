(() => {
  'use strict';
  const safe = value => String(value || '未分类').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'-').trim().replace(/[. ]+$/g,'').slice(0,60) || '未分类';
  function date(value) {
    const parsed = new Date(value || Date.now());
    if (!Number.isFinite(parsed.getTime())) return '日期未知';
    const parts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(parsed).map(p=>[p.type,p.value]));
    return parts.year+parts.month+parts.day;
  }
  function files(cards) {
    const seen=new Map();
    return cards.map(card=>{
      const base=date(card.createdAt)+'-'+safe(card.source)+'-'+safe(String(card.code || '').slice(-4));
      const count=(seen.get(base)||0)+1;seen.set(base,count);
      return base+(count>1?'-'+count:'')+'.txt';
    });
  }
  window.cardDownloadNames={files};
})();
