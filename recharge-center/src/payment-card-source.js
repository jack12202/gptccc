// Card origin is metadata; it never selects the recharge provider.
export function paymentCardSource(input) {
  const source = String(input || "").trim().slice(0, 40);
  if (/^(?:zzs|zzshu|吱吱鼠|zzs\s*[/／]\s*吱吱鼠)$/i.test(source)) return "ZZS / 吱吱鼠";
  if (/^天空(?:卡台)?$/.test(source)) return "天空";
  return source;
}
