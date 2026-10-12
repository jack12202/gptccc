// Card origin is metadata; it never selects the recharge provider.
export function paymentCardSource(input) {
  const source = String(input || "").trim().slice(0, 40);
  if (/^(?:zzs|zzshu|吱吱鼠|zzs\s*[/／]\s*吱吱鼠)$/i.test(source)) return "ZZS / 吱吱鼠";
  if (/^天空(?:卡台)?$/.test(source)) return "天空";
  return source;
}

export function paymentCardOrigin(source, note = "") {
  const normalized = paymentCardSource(source);
  // Old imports sometimes put the channel in the note. Only exact known names count.
  if (["", "手动导入", "未分类", "未标注"].includes(normalized)) {
    const knownNote = paymentCardSource(note);
    if (["天空", "ZZS / 吱吱鼠"].includes(knownNote)) {
      return {sourceLabel:knownNote, sourceMissing:false, sourceInferred:true};
    }
    return {sourceLabel:"未标注", sourceMissing:true, sourceInferred:false};
  }
  return {sourceLabel:normalized, sourceMissing:false, sourceInferred:false};
}
