// Test helper: withdraw the orders a voice test placed on the (local) CRM, so repeated runs do not
// exhaust the test client's licence volume with resting test orders.
import { resolveCallerContext } from '../src/data-db';
import { prepareWithdrawal, confirmPendingOrder } from '../src/brokerage';
import * as store from '../src/voice/store';

export async function withdrawOrdersPlacedOnCall(uid: number, callId: number): Promise<number> {
  const events = await store.listCallEvents(callId);
  const orderIds = events.filter((e) => e.type === 'order_confirmed' && e.detail?.crm_order_id).map((e) => Number(e.detail.crm_order_id));
  let n = 0;
  const ctx = await resolveCallerContext(uid);
  for (const id of orderIds) {
    try {
      const wd = await prepareWithdrawal(ctx, id);
      const done = await confirmPendingOrder(ctx, wd.id, false);
      if (done.status === 'placed') n++;
      else console.warn(`  cleanup: withdrawal of ${id} → ${done.status} ${done.error ?? ''}`);
    } catch (e: any) { console.warn(`  cleanup: could not withdraw ${id}: ${e?.message ?? e}`); }
  }
  return n;
}
