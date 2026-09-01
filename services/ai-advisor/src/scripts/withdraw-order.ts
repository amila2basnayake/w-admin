// Utility: withdraw a client's own order listing through the confirm pipeline.
// Usage: npx tsx src/scripts/withdraw-order.ts <uid> <orderListingId>
import { resolveCallerContext } from '../data-db';
import { prepareWithdrawal, confirmPendingOrder } from '../brokerage';

const uid = Number(process.argv[2]);
const orderId = Number(process.argv[3]);
if (!uid || !orderId) { console.error('usage: withdraw-order.ts <uid> <orderListingId>'); process.exit(2); }

const ctx = await resolveCallerContext(uid);
const wd = await prepareWithdrawal(ctx, orderId);
const done = await confirmPendingOrder(ctx, wd.id, false);
console.log(JSON.stringify({ status: done.status, target: done.target_order_id, error: done.error }));
process.exit(done.status === 'placed' ? 0 : 1);
