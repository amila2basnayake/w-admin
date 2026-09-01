/**
 * What the summariser is told about the client besides the transcript: who they are, what they
 * hold (correct zone/product names — the STT will mangle "Vic 7 Temp"), their open orders, and
 * their last few file notes (context such as trade numbers and the broker's own phrasing).
 * Holdings/orders go through the same RLS-scoped read-only path the assist chat uses; the CRM
 * notes are read on the primary pool because RLS does not cover public.contact — this surface is
 * staff-only and token-bound to one client, and the query is pinned to that client's account.
 */
import { query } from '../db';
import { resolveCallerContext, runScoped, type CallerCtx } from '../data-db';
import { listOwnOpenOrders } from '../brokerage';

export interface ClientGrounding {
  clientUid: number;
  registryUserId: number | null;
  name: string;
  company: string | null;
  brokerName: string | null;
  holdings: Array<{ zone: string; state: string | null; ml: number }>;
  openOrders: Array<{ side: string; permanent: boolean; ml: number; price: number; zone: string | null; placed: string | null }>;
  recentNotes: Array<{ at: string; by: string; note: string }>;
}

/** node-pg hands a `date` column back as a JS Date at local midnight; render it as its calendar day. */
function ymd(v: unknown): string | null {
  if (!v) return null;
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

async function safe<T>(label: string, p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch (e: any) { console.warn(`[call-notes] grounding ${label} failed:`, e?.message ?? e); return fallback; }
}

export async function clientGrounding(clientUid: number, clientNameHint: string): Promise<ClientGrounding> {
  let ctx: CallerCtx | null = null;
  try { ctx = await resolveCallerContext(clientUid); } catch (e: any) { console.warn('[call-notes] caller ctx failed:', e?.message ?? e); }

  const profile = ctx ? await safe('profile', runScoped(ctx,
    `SELECT wu.first_name, wu.last_name, wu.company_name, ru.id AS account_id,
            br.first_name || ' ' || br.last_name AS broker_name
       FROM waterfind_user wu
       JOIN registry_user ru ON ru.id = wu.registry_user
       LEFT JOIN waterfind_user br ON br.id = ru.primary_contact_sales
      WHERE wu.id = $1`, [ctx.uid]), []) : [];
  const p = profile[0] ?? {};

  const holdings = ctx?.account ? await safe('holdings', runScoped(ctx,
    `SELECT r.name AS zone,
            substring(upper(t.name) from '^(NSW|VIC|SA|QLD|WA|TAS|NT|ACT)([^A-Z0-9]|$)') AS au_state,
            round(coalesce(sum(p.quantity),0)::numeric,1) AS total_ml
       FROM property p LEFT JOIN region r ON r.id = p.region
       LEFT JOIN state s2 ON s2.id = r.state LEFT JOIN territory t ON t.id = s2.territory
      WHERE p.registry_user = $1 AND p.deleted IS NOT TRUE AND p.sold IS NOT TRUE
        AND p.sub_type = 'REG' AND (p.quantity > 0 OR p.date_approved IS NOT NULL)
      GROUP BY r.name, t.name ORDER BY total_ml DESC LIMIT 12`, [ctx.account]), []) : [];

  const orders = ctx ? await safe('orders', listOwnOpenOrders(ctx), []) : [];

  const notes = ctx?.account ? await safe('notes', query(
    `SELECT to_char(c.date_edited, 'YYYY-MM-DD') AS at, coalesce(wu.first_name || ' ' || wu.last_name, 'staff') AS by, c.note
       FROM public.contact c LEFT JOIN public.waterfind_user wu ON wu.id = c.added_by
      WHERE c.registry_user = $1 AND c.subclass = 'C' AND coalesce(c.phone_record, false) = false
        AND c.note IS NOT NULL AND length(c.note) > 25
        AND c.note NOT ILIKE 'SMS Sent%' AND c.note NOT ILIKE 'SMS Received%'
        AND c.note NOT ILIKE 'AI Advisor:%' AND c.note NOT ILIKE '%:Your Waterfind%'
        AND c.note NOT ILIKE 'Contract (%' AND c.note NOT ILIKE 'This user has been unapproved%'
      ORDER BY c.date_edited DESC LIMIT 5`, [ctx.account]).then((r) => r.rows), []) : [];

  const first = (p.first_name ?? '').trim(), last = (p.last_name ?? '').trim();
  return {
    clientUid,
    registryUserId: p.account_id ?? ctx?.account ?? null,
    name: (first || last) ? `${first} ${last}`.trim() : clientNameHint,
    company: p.company_name ? String(p.company_name).trim() || null : null,
    brokerName: p.broker_name ? String(p.broker_name).trim() || null : null,
    holdings: holdings.map((h: any) => ({ zone: String(h.zone ?? 'unknown zone'), state: h.au_state ?? null, ml: Number(h.total_ml) || 0 })),
    openOrders: orders.map((o: any) => ({
      side: o.side === 'B' ? 'BUY' : o.side === 'S' ? 'SELL' : String(o.side ?? '?'),
      permanent: !!o.is_permanent, ml: Number(o.ml_available) || 0, price: Number(o.price_per_ml) || 0,
      zone: o.home_region ?? null, placed: ymd(o.placed),
    })),
    recentNotes: notes.map((n: any) => ({
      at: n.at ? String(n.at) : '',
      by: String(n.by ?? 'staff'),
      // The system appends "\n. Broker Action Closed: X" to typed notes — not part of the prose.
      note: String(n.note ?? '').replace(/\n?\.?\s*Broker Action Closed:.*$/gms, '').replace(/\s+/g, ' ').trim().slice(0, 400),
    })),
  };
}
