import test from 'node:test';
import assert from 'node:assert/strict';
import {markHistoricalOrdersHandled,annotateHandledOrders,historicalHandlingCutoff} from '../src/workbench-history.js';
import {buildWorkbench} from '../src/admin-workbench.js';
test('owner-confirmed history housekeeping uses Beijing midnight, persists once and never changes payment state',()=>{
 let state={orders:[{id:'old',status:'needs_review'}],cardUses:{frozen:1,used:2}},writes=0;
 const store={read:()=>structuredClone(state),write:value=>{state=value;writes++;}};
 const records=[{id:'old',createdAt:'2026-10-13T15:59:59.999Z',status:'needs_review',useResolution:'frozen',customerCardId:'bound'},
  {id:'today',createdAt:historicalHandlingCutoff,status:'needs_review'},
  {id:'unknown',createdAt:'invalid',status:'needs_review'}];
 const before=structuredClone(state);
 const handling=markHistoricalOrdersHandled(store,records,'2026-10-14T10:00:00Z');
 assert.deepEqual(handling.orderIds,['old']);assert.deepEqual(state.orders,before.orders);assert.deepEqual(state.cardUses,before.cardUses);
 markHistoricalOrdersHandled(store,[...records,{id:'late-import',createdAt:'2026-10-01'}]);assert.equal(writes,1);
 const annotated=annotateHandledOrders(records,handling);assert.equal(annotated[0].status,'needs_review');assert.equal(annotated[0].ownerConfirmedSuccess,true);
 const workbench=buildWorkbench({records:annotated,customerCards:[{id:'bound',code:'bound',status:'unused',plan:'plus'}],usageCards:[],hifupay:[],plusProvider:'zzshu'});
 assert.deepEqual(workbench.orders.items.map(o=>o.id),['today','unknown']);assert.equal(workbench.orders.total,2);
 assert.equal(workbench.attention.total,2);assert.equal(workbench.attention.items.some(o=>o.id==='old'),false);
 assert.equal(workbench.summary.inventoryReady,0);assert.equal(workbench.vouchers.items[0].hasSubmission,true);
});
