// Shared by the browser formatter and encrypted card import. No I/O or persistence.
export function parsePaymentCardLine(raw, line, now = new Date()) {
  if (!raw.trim()) return {line, status:"empty"};
  const input = raw.trim();
  const dashParts = input.split("----").map(value => value.trim());
  const dashFormat = input.includes("----");
  const validDash = dashParts.length === 3 || dashParts.length === 4 && dashParts[3] === "";
  const commaParts = input.split(",").map(value => value.trim());
  const spaceParts = input.split(/\s+/);
  const spaceFormat = !input.includes(",") && spaceParts.length === 3;
  const labeledParts = input.split(/[;；]/).map(value => value.trim());
  // Sky's copy format omits the colon after CVV. Labels can appear in any order.
  const fields = {};
  let labeledFormat = labeledParts.length === 3;
  for (const part of labeledParts) {
    const match = part.match(/^(卡号|有效期|CVV)\s*[:：]?\s*(\S+)$/i);
    const key = match?.[1].toUpperCase();
    if (!match || fields[key] !== undefined) { labeledFormat = false; break; }
    fields[key] = match[2];
  }
  labeledFormat = labeledFormat && Object.keys(fields).length === 3;
  const pan = (dashFormat ? dashParts[0] : labeledFormat ? fields["卡号"] : spaceFormat ? spaceParts[0] : commaParts[0]) || "";
  const lastFour = /^\d{4}$/.test(pan.slice(-4)) ? pan.slice(-4) : "";
  const masked = lastFour ? `****${lastFour}` : "****";
  const expiry = dashFormat ? dashParts[1] : labeledFormat ? fields["有效期"] : spaceFormat ? spaceParts[2] : commaParts[1];
  const cvv = dashFormat ? dashParts[2] : labeledFormat ? fields.CVV : spaceFormat ? spaceParts[1] : commaParts[2];
  const expiryYearFirst = spaceFormat && /^20\d{2}-(0[1-9]|1[0-2])$/.test(expiry || "");
  const validExpiry = expiryYearFirst || /^(0[1-9]|1[0-2])\/\d{2}$/.test(expiry || "");
  if ((dashFormat ? !validDash : !labeledFormat && (spaceFormat ? spaceParts.length : commaParts.length) !== 3) || !/^\d{12,19}$/.test(pan) || !validExpiry || !/^\d{3,4}$/.test(cvv || "")) {
    return { line, status: "error", masked, error: "格式应为 卡号,MM/YY,CVV、卡号 CVV MM/YY（也支持 YYYY-MM），天空 卡号:…;CVV…;有效期:MM/YY，或 卡号----MM/YY----CVV----" };
  }
  const month = expiryYearFirst ? Number(expiry.slice(5)) : Number(expiry.slice(0, 2));
  const year = expiryYearFirst ? Number(expiry.slice(0, 4)) : 2000 + Number(expiry.slice(3));
  if (year < now.getUTCFullYear() || year === now.getUTCFullYear() && month < now.getUTCMonth() + 1) {
    return { line, status: "error", masked, error: "卡片已过期" };
  }
  return {line, status:"ready", masked, payment:{cardNumber:pan, expMonth:month, expYear:year, cvv}};
}

export function parseCardInputs(text, now = new Date()) {
  const seen = new Set();
  return String(text || "").split(/\r?\n/).map((raw,index) => {
    const row = parsePaymentCardLine(raw,index+1,now);
    if (row.status !== "ready") return row;
    if (seen.has(row.payment.cardNumber)) return {line:row.line,status:"duplicate",masked:row.masked,error:"重复卡，默认跳过"};
    seen.add(row.payment.cardNumber);
    return row;
  });
}

export function formatPaymentCard(payment) {
  const month=String(payment.expMonth).padStart(2,"0"),year=String(payment.expYear).slice(-2);
  return payment.cardNumber+"----"+month+"/"+year+"----"+payment.cvv+"----";
}
