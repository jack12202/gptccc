// One-time owner-authorized housekeeping. This does not resolve payments or alter card counters.
export const historicalHandlingId = 'owner-confirmed-before-2026-10-14';
export const historicalHandlingCutoff = '2026-10-13T16:00:00.000Z';
export function markHistoricalOrdersHandled(store, records, now = new Date().toISOString()) {
  const state = store.read();
  if (state.workbenchHistoryHandling?.id === historicalHandlingId) return state.workbenchHistoryHandling;
  const ids = [...new Set(records.filter(order => Number.isFinite(Date.parse(order.createdAt)) &&
    Date.parse(order.createdAt) < Date.parse(historicalHandlingCutoff)).map(order => order.id))];
  const handling = {id:historicalHandlingId,cutoff:historicalHandlingCutoff,handledAt:now,orderIds:ids,
    operator:'owner-request',reason:'用户确认：2026-10-14 之前订单均已充值成功，标记已处理并从工作台移除'};
  state.workbenchHistoryHandling=handling;
  store.write(state);
  return handling;
}
export function annotateHandledOrders(records, handling) {
  if (!handling?.orderIds) return records;
  const ids = new Set(handling.orderIds);
  return records.map(order=>ids.has(order.id)?{...order,workbenchHandledAt:handling.handledAt,
    workbenchHandledReason:handling.reason,ownerConfirmedSuccess:true}:order);
}
