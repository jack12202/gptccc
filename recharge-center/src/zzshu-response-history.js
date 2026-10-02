// Only reason/status fields are retained. Payloads can contain payment and session secrets.
const reasonField = /^(?:message|msg|error|errors|errormessage|errordescription|errorcode|reason|detail|details|description|resultmessage|failurereason|failuremessage|declinereason|declinecode|status|code|success|type)$/i;
const sensitiveField = /token|secret|password|authorization|api.?key|card.?key|card.?number|bank.?card|cvv|cvc|session|credential/i;

export function responseSummary(body, secrets = []) {
  const values = [...secrets];
  function collectSensitive(value, sensitive = false) {
    if (sensitive && (typeof value === 'string' || typeof value === 'number')) values.push(String(value));
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value))
      collectSensitive(child, sensitive || sensitiveField.test(key));
  }
  collectSensitive(body);
  const known = [...new Set(values.filter(value => typeof value === 'string' && value.length >= 3))].sort((a, b) => b.length - a.length);
  function clean(value) {
    let text = value;
    for (const secret of known) text = text.split(secret).join('[已隐藏]');
    return text
      .replace(/\b(?:Bearer\s+)?eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, '[已隐藏]')
      .replace(/\b(?:\d[ -]?){12,19}\b/g, '[卡号已隐藏]')
      .replace(/\b(?:HPLUS|ZZPLUS)[0-9A-F]{32}\b/gi, '[卡密已隐藏]')
      .replace(/((?:access[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|cvv|cvc|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[已隐藏]');
  }
  function walk(value, insideReason = false, depth = 0) {
    if (depth > 20) return '[内容层级过深]';
    if (typeof value === 'string') return insideReason ? clean(value) : undefined;
    if (typeof value === 'boolean' || typeof value === 'number' || value === null) return insideReason ? value : undefined;
    if (Array.isArray(value)) {
      const items = value.map(item => walk(item, insideReason, depth + 1)).filter(item => item !== undefined);
      return items.length ? items : undefined;
    }
    if (!value || typeof value !== 'object') return undefined;
    const entries = [];
    for (const [key, child] of Object.entries(value)) {
      if (sensitiveField.test(key)) continue;
      const reason = reasonField.test(key.replace(/[_-]/g, ''));
      const result = walk(child, reason || insideReason, depth + 1);
      if (result !== undefined) entries.push([clean(key), result]);
    }
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  return walk(body) || {};
}

export function requestSecrets(payload, apiKey) {
  const values = [apiKey];
  function collect(value) {
    if (typeof value === 'string') values.push(value);
    else if (value && typeof value === 'object') for (const child of Object.values(value)) collect(child);
  }
  collect(payload);
  return values;
}
