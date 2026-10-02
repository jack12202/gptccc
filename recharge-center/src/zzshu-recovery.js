export const recoveryReasons = {
  success: { upstream_success: '已核实上游订单充值成功', account_active: '已核实目标账号会员开通', manual_success: '已人工完成充值并核实账号权益' },
  unlock: { no_charge: '已核实上游未开通且支付记录未扣款', token_expired: '已人工核实授权失效且未开通未扣款', rejected: '已核实请求被拒绝且未创建充值订单' },
  freeze: { uncertain: '充值或扣款结果不明，冻结等待核查', awaiting_support: '等待上游确认充值及扣款结果', account_check: '账号权益与充值记录需要进一步核查' },
  release: { no_charge: '已核实未扣款，释放冻结支付次数' },
  consume: { charged: '已核实支付次数确实消耗，记录占用结果' },
  cancellation: { upstream_cancelled: '已核实上游订单自动续费关闭', account_cancelled: '已核实账号订阅管理已关闭自动续费' }
};
export function recoveryEvidence(outcome, body = {}, operator = 'admin') {
  const label = recoveryReasons[outcome]?.[body.reasonCode];
  if (!label) return null;
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  return { reason: label + (note ? '；备注：' + note : ''), operator, reasonCode: body.reasonCode };
}
export const tokenExpiredMessage = '账号授权已失效，请获取新的 Session JSON，使用原卡密为原账号重新提交。';
export function classifyCreation(result) {
  const code = Number(result.code);
  const data = result.data;
  // Never treat a response containing a task/payment result as a pre-create rejection.
  if (result.ok || data?.order_no || data?.card_key || data?.payment_result) return null;
  if ([40106, 40107, 40306].includes(code)) return 'channel_unavailable';
  if (code === 40027) return 'token_expired';
  const reason = JSON.stringify(result.reasons || {}).toLowerCase();
  if (code === 401 && /(?:access.?token|session.?token|token).*(?:expired|invalid|失效|过期|无效)/i.test(reason) &&
      !/(?:api.?key|api.?token|api凭据)/i.test(reason)) return 'token_expired';
  if ([40005,40006,40007,40008,40024,40025,40026,40028,40030].includes(code)) return 'session_invalid';
  if ([42902,40305].includes(code)) return 'channel_unavailable';
  return null;
}
export function issueMessage(kind) {
  if (kind === 'token_expired') return tokenExpiredMessage;
  if (kind === 'session_invalid') return '账号授权资料未通过校验，请获取完整的新 Session JSON，使用原卡密为原账号重新提交。';
  if (kind === 'channel_unavailable') return '充值服务暂时不可用，本次未受理，卡密权益保留。请稍后重试或联系客服。';
  return '本次未完成充值，原卡密已解锁，可以为原账号重新提交。';
}
