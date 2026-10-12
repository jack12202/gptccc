(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const known = ['天空','ZZS / 吱吱鼠'];
  window.paymentCardSourceUI = {
    row(card) {
      if (card.kind === 'h') return '<span class="badge">嗨付</span>';
      const label = card.sourceLabel || '未标注', missing = card.sourceMissing || label === '未标注';
      const choices = [...known];
      if (!missing && !choices.includes(label)) choices.push(label);
      const tone = missing ? 'missing' : label === '天空' ? 'sky' : label === 'ZZS / 吱吱鼠' ? 'mouse' : 'custom';
      return '<select class="origin-select origin-'+tone+'" data-card-source="'+esc(card.uid)+'" aria-label="来源渠道，尾号 '+esc(card.lastFour)+'" title="直接选择卡片来源渠道">'+
        (missing ? '<option value="" disabled selected>未标注 · 选择渠道</option>' : '')+
        choices.map(source=>'<option value="'+esc(source)+'"'+(source===label?' selected':'')+'>'+esc(source)+'</option>').join('')+
        '<option value="__custom__">其他渠道…</option></select>';
    },
    bindImport(select, custom) {
      const update = () => {custom.hidden=select.value!=='__custom__';custom.required=!custom.hidden;};
      select.onchange=update;update();
    },
    importSource(select, custom) {
      const source=(select.value==='__custom__'?custom.value:select.value).trim();
      if (!source || source==='手动导入') throw Error('请选择卡片来源渠道：天空、ZZS / 吱吱鼠或其他渠道。');
      return source;
    }
  };
})();
