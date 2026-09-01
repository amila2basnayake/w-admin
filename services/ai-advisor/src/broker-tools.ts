import { z } from 'zod';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import type { CallerCtx } from './data-db';
import {
  preparePendingOrder, prepareWithdrawal, listOrders, listOwnOpenOrders,
  prepareEscalation, listEscalations, declineEscalation, cancelEscalation, ScopeViolation,
  type OnBehalf,
} from './brokerage';

// Brokerage tools for the advisor. These are the AI's ONLY write-capable surface, and none
// of them executes a trade: prepare_* stores a proposal that the human must confirm on the
// in-chat card (their own authenticated click). Identity is bound server-side from the
// verified token (ctx) — no tool takes a user/account id. On the broker-assist surface the
// human is verified staff acting for the client (`onBehalf`, recorded for attribution); ctx is
// still the client, so scope is unchanged.

function J(obj: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(obj) }] };
}

function scopeError(e: unknown) {
  if (e instanceof ScopeViolation) {
    return J({ status: 'REFUSED_OUT_OF_SCOPE', reason: e.message });
  }
  throw e;
}

const cardNote =
  'AWAITING_USER_CONFIRMATION: a confirmation card is now shown in the chat, and the order is ' +
  'placed only if the user reviews and clicks Confirm there — nothing has been placed yet. ' +
  'pending_order_id is an internal proposal id, not an exchange order number; the real order ' +
  'number exists only after the user confirms.';

export const BROKER_TOOL_NAMES = [
  'prepare_sell_order', 'prepare_buy_order', 'prepare_order_withdrawal',
  'get_my_open_orders', 'get_my_ai_orders', 'escalate_to_broker', 'cancel_escalation',
] as const;

const product = z.enum(['allocation', 'entitlement'])
  .describe("'allocation' = temporary/seasonal water; 'entitlement' = permanent water right");

export function buildBrokerToolDefs(
  ctx: CallerCtx, conversationId: number | null, opts: { onBehalf?: OnBehalf | null } = {},
) {
  const onBehalf = opts.onBehalf ?? null;
  const pub = (po: any) => ({
    pending_order_id: po.id, side: po.side,
    product: po.is_permanent ? 'entitlement' : 'allocation',
    region_id: po.region_id, region: po.region_name, licence_property_id: po.property_id,
    volume_ml: po.volume_ml, price_per_ml: po.price_per_ml,
    gross_value: po.preview?.gross_value,
    recent_12m_price_band: po.preview?.recent_12m_price_band ?? null,
    target_order_id: po.target_order_id ?? undefined,
    forward: !!po.delivery_date || undefined,
    delivery_date: po.delivery_date ?? undefined,
    forward_note: po.preview?.forward_note ?? undefined,
    split: po.split || undefined,
    min_split_quantity: po.min_split_quantity ?? undefined,
    max_split_parcel_size: po.max_split_parcel_size ?? undefined,
    split_note: po.preview?.split_note ?? undefined,
    expires_at: po.expires_at, status: po.status,
  });

  const splitParams = {
    allow_split: z.boolean().optional()
      .describe('allow partial fills (split parcel). The order may settle as several trades; if a ' +
        'partial fill leaves less than min_split_quantity remaining, the engine cancels the ' +
        'remainder automatically. Non-split counterparties match ahead of split ones.'),
    min_split_quantity: z.number().positive().optional()
      .describe('ML — smallest fill acceptable; REQUIRED when allow_split'),
    max_split_parcel_size: z.number().nonnegative().optional()
      .describe('ML — optional cap per fill; 0 or omitted = no cap'),
  };

  const deliveryDate = z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional()
    .describe('optional FORWARD delivery date dd/MM/yyyy (omit for a spot order). Forward orders ' +
      'rest on the market until a counterparty accepts (they never clear automatically at placement), ' +
      'settle on a deposit/payment schedule, and a forward SELL of allocation is listed across all ' +
      'tradable regions for that date.');

  return [
    tool('prepare_sell_order',
      "Prepare a SELL order on the caller's own water in a region they hold rights in. Validates scope " +
      '(licence ownership, approval, spot permission, volume within holding) and creates a pending order ' +
      'that the user must explicitly confirm in the chat UI before anything is placed on the market.',
      { region_id: z.number().int().describe("region.id of the caller's holding (from get_my_holdings)"),
        product,
        volume_ml: z.number().positive().describe('megalitres to sell'),
        price_per_ml: z.number().positive().describe('asking price $/ML'),
        expiry: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional()
          .describe('optional order expiry dd/MM/yyyy (default: end of the water season)'),
        delivery_date: deliveryDate, ...splitParams },
      async (a) => {
        try {
          const po = await preparePendingOrder(ctx, {
            side: 'SELL', regionId: a.region_id, isPermanent: a.product === 'entitlement',
            volumeMl: a.volume_ml, pricePerMl: a.price_per_ml, expiry: a.expiry ?? null,
            deliveryDate: a.delivery_date ?? null,
            split: a.allow_split ?? false, minSplitQuantity: a.min_split_quantity ?? null,
            maxSplitParcelSize: a.max_split_parcel_size ?? null,
            conversationId, onBehalf,
          });
          return J({ status: 'PENDING_CONFIRMATION', note: cardNote, order: pub(po) });
        } catch (e) { return scopeError(e); }
      }),

    tool('prepare_buy_order',
      'Prepare a BUY order for water delivered into a region where the caller holds an approved licence ' +
      '(the CRM anchors every buy to a destination licence). Validates scope and creates a pending order ' +
      'that the user must explicitly confirm in the chat UI before anything is placed on the market.',
      { region_id: z.number().int().describe("destination region.id — must be one of the caller's holding regions"),
        product,
        volume_ml: z.number().positive().describe('megalitres to buy'),
        price_per_ml: z.number().positive().describe('bid price $/ML'),
        expiry: z.string().regex(/^\d{2}\/\d{2}\/\d{4}$/).optional()
          .describe('optional order expiry dd/MM/yyyy (default: end of the water season)'),
        delivery_date: deliveryDate, ...splitParams },
      async (a) => {
        try {
          const po = await preparePendingOrder(ctx, {
            side: 'BUY', regionId: a.region_id, isPermanent: a.product === 'entitlement',
            volumeMl: a.volume_ml, pricePerMl: a.price_per_ml, expiry: a.expiry ?? null,
            deliveryDate: a.delivery_date ?? null,
            split: a.allow_split ?? false, minSplitQuantity: a.min_split_quantity ?? null,
            maxSplitParcelSize: a.max_split_parcel_size ?? null,
            conversationId, onBehalf,
          });
          return J({ status: 'PENDING_CONFIRMATION', note: cardNote, order: pub(po) });
        } catch (e) { return scopeError(e); }
      }),

    tool('prepare_order_withdrawal',
      "Prepare the withdrawal of ONE of the caller's own open orders (see get_my_open_orders). " +
      'Ownership is verified server-side; the user must confirm in the chat UI before it is withdrawn.',
      { order_listing_id: z.number().int().describe("the caller's own order_listing id to withdraw") },
      async (a) => {
        try {
          const po = await prepareWithdrawal(ctx, a.order_listing_id, conversationId, onBehalf);
          return J({ status: 'PENDING_CONFIRMATION', note: cardNote, order: pub(po) });
        } catch (e) { return scopeError(e); }
      }),

    tool('get_my_open_orders',
      "The caller's own OPEN order listings currently on the Waterfind market (auto-scoped).",
      {},
      async () => J({ orders: await listOwnOpenOrders(ctx) })),

    tool('get_my_ai_orders',
      'Orders proposed through this AI advisor and their lifecycle status ' +
      '(pending / placed / failed / cancelled / expired). Auto-scoped to the caller.',
      {},
      async () => {
        const rows = await listOrders(ctx.uid);
        return J({
          orders: rows.map((po) => ({
            ...pub(po), crm_order_id: po.crm_order_id, cleared_trades: po.cleared_trades,
            error: po.error, created_at: po.created_at, decided_at: po.decided_at,
          })),
        });
      }),

    tool('escalate_to_broker',
      'Stage a handoff of the client to a human Waterfind broker. Creates a PENDING escalation and ' +
      'shows a confirmation card in the chat with exactly what will be sent to the team; the ' +
      "follow-up task on the client's CRM account is raised only if the client clicks Confirm on " +
      "that card — nothing is sent to the team by this call. Use when the request is outside the AI " +
      "advisor's scope (complex or bespoke advice, disputes, account/licence or contract changes, " +
      'contract negotiation) or when the client asks to speak to a person / real broker. Does not ' +
      'place or withdraw orders — use prepare_* for trades.',
      { reason: z.string().min(1)
          .describe('Short reason/category, e.g. "client requested a human", "advice beyond scope", "dispute", "contract negotiation".'),
        summary: z.string().min(1)
          .describe('A concise summary for the broker of what the client needs and the relevant context from this chat. ' +
            'The client sees this verbatim on the confirmation card before it is sent.') },
      async (a) => {
        try {
          const r = await prepareEscalation(ctx, { reason: a.reason, summary: a.summary, conversationId });
          return J({
            status: 'PENDING_CONFIRMATION',
            escalation_id: r.escalation.id,
            summary_shown_to_client: r.escalation.summary,
            note:
              'AWAITING_USER_CONFIRMATION: a confirmation card showing the summary is now in the chat. ' +
              'The team is notified only if the client confirms there — do NOT say the team has been ' +
              'contacted or that anyone will follow up yet; invite the client to review the card.',
          });
        } catch (e) { return scopeError(e); }
      }),

    tool('cancel_escalation',
      'Cancel (de-escalate) an escalation from this conversation when the client changes their mind: ' +
      'a not-yet-confirmed escalation is discarded; a confirmed one is cancelled and its follow-up ' +
      "task on the client's CRM account is closed with a cancellation note so the team does not " +
      'chase it. Omit escalation_id to cancel the most recent active escalation in this conversation.',
      { escalation_id: z.number().int().optional()
          .describe('id from escalate_to_broker; omit for the most recent pending/confirmed escalation in this conversation') },
      async (a) => {
        try {
          let esc = null as Awaited<ReturnType<typeof listEscalations>>[number] | null;
          if (a.escalation_id != null) {
            esc = (await listEscalations(ctx.uid)).find((e) => e.id === a.escalation_id) ?? null;
          } else if (conversationId != null) {
            esc = (await listEscalations(ctx.uid, conversationId, ['pending', 'confirmed']))[0] ?? null;
          }
          if (!esc) return J({ status: 'NOT_FOUND', note: 'No matching active escalation.' });
          if (esc.status === 'pending') {
            await declineEscalation(ctx.uid, esc.id);
            return J({ status: 'CANCELLED', escalation_id: esc.id,
              note: 'The pending escalation was discarded before anything was sent — the team was never notified.' });
          }
          if (esc.status !== 'confirmed') {
            return J({ status: 'ALREADY_' + esc.status.toUpperCase(), escalation_id: esc.id });
          }
          const r = await cancelEscalation(ctx.uid, esc.id);
          return J({
            status: 'CANCELLED', escalation_id: esc.id,
            crm_task_closed: r.taskClosed,
            note: !r.hadTask
              ? 'Cancelled. No CRM task had been raised, so there was nothing to close.'
              : r.taskClosed
                ? 'Cancelled. The follow-up task on the client\'s account was closed with a cancellation note.'
                : 'Cancelled, but the follow-up task was already actioned or could not be closed — ' +
                  'the team may still reach out; tell the client to simply let them know it is no longer needed.',
          });
        } catch (e) { return scopeError(e); }
      }),
  ];
}
