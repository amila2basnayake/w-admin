# Water Rights Adviser — Test Conversations

> **What this is.** A test of the `water-rights-adviser` subagent
> (`.claude/agents/water-rights-adviser.md`) against **5 real clients** from the live `waterfind-db`,
> each given a fake persona, in **3-turn back-and-forth** conversations. Produced 2026-06-22.
>
> **How it was run.** Each persona ran as a separate agent instance that loaded the adviser's actual
> definition file and answered live, querying the production-derived DB itself (snapshot ~2026-06-19;
> liveness `asof = 2026-06-15`). Conversations are genuine multi-turn (the agent kept context between
> turns). Client **names are real; emails are sanitized** to `demo@waterfind.com.au`.
>
> Adviser replies are reproduced verbatim (minor internal planning preambles trimmed — see Finding 2).
> Each persona ends with a **spot-check** of the agent's answers against the database.

## The 5 personas

| # | Persona | Real client | `wu.id` / `acct` | Profile |
|---|---|---|---|---|
| 1 | Kyle Egan, Water Officer | Njernda Aboriginal Corporation | 2026296 / 2026297 | ~974 ML VIC Murray + Goulburn; active seller; **no broker** |
| 2 | Margaret Field, Finance Director | T.A. Field Estates Pty Ltd | 689001 / 665306 | 24,642 ML NSW entitlement, 78% Murrumbidgee |
| 3 | Tom Zadow, owner/winegrower | Paisley Hill Vineyards Trust | 3650763 / 3650764 | ~860 ML VIC/SA; vineyard; broker Sean Warren |
| 4 | Dave Trinca, Station Manager | Upper Wantagong Station Pty Ltd | 85016 / 665313 | 10,626 ML NSW Coleambally/Murrumbidgee |
| 5 | Sarah Godden, Operations Manager | Angoves Pty Ltd | 802010 / 802011 | 4,054 ML SA River Murray; winemaker; dormant since 2021 |

---

## Persona 1 — Kyle Egan · Njernda Aboriginal Corporation

**Verified ground truth:** top holding 372 ML in region 515 (VIC Murray Hi‑R); last sale $300/ML temp,
2025‑10‑23; no `primary_contact_sales`; loyalty 13,348, last service 2026‑02‑05.

**🗣 Kyle:** *"Gday — Kyle from Njernda. We've got water spread across the Murray and the Goulburn.
Money's a bit tight this season. Should we be selling any of it right now, or sitting tight?"*

**🤖 Adviser:**
> Sell now — and lead with the Murray.
>
> **Sell ~372 ML allocation in region 515 (VIC Murray):** median's $300/ML but live demand is deep —
> 34 bids, 263,000 ML wanted, best bid **$420/ML**. Your last 515 sale was $300 (Oct), $260 before
> that — this is the top of the range.
>
> | Holding (allocation/temp) | ML | Recent median | Live best bid | Call |
> |---|---|---|---|---|
> | 515 VIC Murray | 372 | $300 | **$420** | **Sell now** |
> | 1165601 Greater Goulburn HI‑R | 193 | $278 | $410 | Sell — Murray first (thin: 6 bids) |
> | 509 Lower Goulburn | 188 | $263 | — | Hold/list; thin market |
> | smaller parcels (311341/311339/1165602) | ~218 | — | — | Hold; almost no trades |
>
> Net on 372 ML @ ~$415 ≈ **$154k gross, ~$150k net** after ~2.5% brokerage+GST (estimate). If you
> want a single move this season: clear the **515 parcel** at $400+. Want me to model the exact net at
> a chosen price, or check the Goulburn standing-rule demand before you list there?

**🗣 Kyle:** *"Good to know. Say I sell 200 ML of the Murray (region 515) at $400/ML — what do I
actually walk away with after your fees and GST?"*

**🤖 Adviser:**
> On 200 ML @ $400 = **$80,000 gross**, you walk away with **~$79,670**: $300 brokerage + $30 GST.
> That's the rate-card estimate and excludes any government/authority transfer fee — exact figure
> lands on your settlement statement. Net is ~99.6%.

**🗣 Kyle:** *"One more — has anyone from Waterfind actually been looking after our account? I don't
think we've even got a broker. Who's our contact?"*

**🤖 Adviser:**
> You're right — **no broker is assigned.** No primary/secondary sales contact, no live tag — your
> account has nobody looking after it on paper. Worth flagging to Waterfind to get one assigned,
> especially with ~$150k of sellable water in play. That said, the account isn't dormant: last
> serviced 2026‑02‑05, 318 lifetime contacts, 1 open task, 13,348 loyalty points.

**Spot-check:** ✅ 515 = 372 ML, last sale $300, best bid $420, no broker, loyalty/service all match the
DB. ⚠️ The net estimate used a flat ~$300 brokerage; Njernda's *actual* past 515 trade was charged
$800 on $30k (~2.7%), so the flat estimate understates — correctly flagged as "estimate", but see
Finding 4.

---

## Persona 2 — Margaret Field · T.A. Field Estates

**Verified ground truth:** 24,642 ML registered entitlement, top parcel 13,067 ML in region 686
(Murrumbidgee General Security).

**🗣 Margaret:** *"Margaret Field here. Before our board meeting I need a clean summary — what water
does T.A. Field Estates actually hold right now, and where is it?"*

**🤖 Adviser:**
> T.A. Field Estates — holdings as at 2026‑06‑19, all registered entitlement (permanent), **24,642 ML
> across 16 holdings in 9 markets**:
>
> | ML | Market |
> |---|---|
> | 13,067 | Murrumbidgee General Security |
> | 6,170 | Lower Lachlan GS (Cargelligo–Booligal) |
> | 1,917 | Murrumbidgee Supplementary — Zone 4 |
> | 1,548 | Murrumbidgee High Security |
> | 1,004 | Lower Lachlan Groundwater |
> | 486 | Upper Lachlan GS |
> | 200 | SA River Murray — Class 3 Irrigation |
> | 150 | Murrumbidgee Irrigation Cat‑1 GS |
> | 100 | VIC Murray (Barmah–SA) GMW High |
>
> ~78% sits in the Murrumbidgee; the rest spans Lachlan, SA Murray and VIC Murray. This is entitlement
> (the asset), not seasonal allocation.

**🗣 Margaret:** *"Our ~13,000 ML of Murrumbidgee General Security — if the board decided to sell that
entitlement permanently, what's it worth today?"*

**🤖 Adviser:**
> **~$42M, indicatively** (range ~$34–42M). 13,067 ML × median **$3,190/ML** from 33 external
> Murrumbidgee GS sales over the last 12 months ($2,625–$3,200 interquartile; latest Jan 2026). No
> internal Waterfind permanent settlements in 686 recently, so this leans on registered external sales.
> Net of fees: ~1–2% commission → ~$41M net (ballpark; exact needs the rate card + any override). Two
> board-relevant caveats: (1) 13,067 ML is ~1.5% of annual Murrumbidgee GS trade — selling it all at
> once would move the market below that median, so phase it. (2) GST and government transfer fees are
> on top.

**🗣 Margaret:** *"Where could a buyer of that Murrumbidgee entitlement even come from — which regions
can permanent General Security entitlement actually trade into?"*

**🤖 Adviser:**
> Permanent GS entitlement out of Murrumbidgee River (686) can trade into **5 markets, all within NSW
> Murrumbidgee, conversion 1:1**:
>
> | To region | Market |
> |---|---|
> | 686 | Murrumbidgee River GS (within-valley) |
> | 685 | Murrumbidgee Irrigation Cat‑1 GS |
> | 98438 | MI Wah Wah Cat‑1 GS |
> | 670 | Coleambally Irrigation GS |
> | 2513 | Yanco/Billabong Creek GS |
>
> Buyers can only be Murrumbidgee GS holders — no interstate or inter-valley permanent buyers exist for
> this entitlement (the Lachlan, SA Murray and VIC Murray holdings are separate, closed pools). All
> windows are full-year. That confined buyer base is exactly why a 13,067 ML block must be phased.

**Spot-check:** ✅ Holdings total and 13,067 ML in 686 match. Permanent valuation correctly drawn from
`external_sales` (no internal permanent comps) and per‑ML derived from `price/quantity`. Market-impact
and fee caveats are sound and exactly the right thing to tell a board.

---

## Persona 3 — Tom Zadow · Paisley Hill Vineyards

**Verified ground truth:** ~860 ML entitlement (VIC Murray zones 6/7 + SA Class 3); broker Sean Warren;
last sale 200 ML @ $310 zone 7, 2025‑11‑04; entitlement-only (no `ALL`/`CAR` rows tracked).

**🗣 Tom:** *"Tom from Paisley Hill. I'm nervous about water for the vines this season. Can you give me
a quick read on where our water position sits?"*

**🤖 Adviser:**
> Your underlying position is solid — but the watch item is **this season's allocation, not your
> entitlements.**
>
> | What you hold (entitlement) | ML | Status |
> |---|---|---|
> | VIC Murray zones 6/7 (Low + High R) | ~588 | Held, tradable |
> | SA River Murray Class 3 | 206 | Held, tradable |
> | Greater Goulburn + S&D | ~49 | Held |
>
> You hold ~860 ML of entitlement — no permanent water is at risk. What waters the vines is the
> **seasonal allocation** against it, and you've been a net seller every season (last: 200 ML out of
> zone 7 at $310/ML, Nov 2025). Market read: temp in your zones is firm and rising — zone 7 ~$395/ML,
> SA Class 3 ~$413/ML (28 May), up sharply from $22–$160/ML in 2024. Position **secure on entitlement;
> exposed on allocation** if you've over-sold. One decision-changer I can't see — your current-season
> allocation balance. Want me to pull that and your standing sell rules so we don't accidentally sell
> water you need for the vines? Your broker is **Sean Warren**.

**🗣 Tom:** *"Yes please — pull our standing sell rules and what we've actually netted on past sales,
so I know our track record before I decide anything."*

**🤖 Adviser:**
> **Standing sell rules: none live.** Your only standing orders/alerts are long-expired (last a 2021
> buy alert; a 2013 sell alert). Nothing is auto-selling your water — any sale this season is a
> deliberate decision.
>
> | Date | Zone | ML | $/ML | Gross | Net paid |
> |---|---|---|---|---|---|
> | Nov 2025 | 7 (311341) | 200 | $310 | $62,000 | see note |
> | Jul 2025 | 7 | 185 | $290 | $53,650 | $52,360 |
> | Jul 2025 | 7 | 200 | $297 | $59,400 | $57,983 |
> | Apr 2025 | 6 (311340) | 350 | $118 | $41,300 | split |
> | Dec 2024 | 7 | 100 | $160 | $16,000 | $15,486 |
>
> Your clean single-parcel sells net **~96–98% of gross**. But several rows return partial/odd net —
> the Nov‑2025 $62k trade shows only ~$11.7k settled to you, and the Apr‑2025 sale is split across
> three payments. That isn't a fee problem — it signals **proceeds shared/assigned** (multiple owners
> on the parcel, or a financier). Worth confirming with Sean before you lean on those as your "per‑ML
> take." Bottom line: no rule is selling for you, prices have climbed (~$22→$310/ML since 2024), clean
> sells net ~97% — but split settlements mean your effective take on some parcels is lower than
> headline $/ML.

**🗣 Tom:** *"Yes, pull it. If zone 7 allocation pushes to $420, how much can I safely sell without
short-changing the vines this season?"*

**🤖 Adviser:**
> Straight answer: **I can't size a safe sell, because your current-season allocation balance isn't in
> our trading system** — and I won't guess at water your vines depend on. Your record holds entitlements
> only (REG) — announced-allocation %, carryover caps and reliability are kept by your resource manager
> (GMW/state register), not Waterfind. The price side is real: zone‑7 temp settles ~$395/ML and $420
> would be a genuinely strong level (your best was $310). Once we have the numbers:
>
> > **Sellable = (allocation ML credited + carryover) − (vine requirement + dry-year buffer).** Sell
> > only the surplus; never sell into your irrigation requirement on a falling-allocation year.
>
> Give me two figures from your GMW water account — (1) ML currently allocated in zone 7, (2) season's
> vine requirement — and I'll tell you the surplus to list at $420 and what you'd net. At $420/ML,
> every 50 ML of true surplus is ~$20k net. I'd loop in **Sean Warren** to pull your GMW balance first.

**Spot-check:** ✅ Broker Sean Warren, last sale $310/zone 7, entitlement-only, no live standing rules —
all confirmed. **Best moment of the test:** it refused to fabricate a sell volume because the seasonal
allocation balance genuinely isn't in the DB (the `data-map.md` §10 gap), and it independently spotted
the split/assigned settlements — a real, non-obvious risk for a vineyard with shared ownership.

---

## Persona 4 — Dave Trinca · Upper Wantagong Station

**Verified ground truth:** 5,004 ML in region 670 (Coleambally GS), 654 ML in region 686 (Murrumbidgee
GS); last temp sale $450/ML region 670, 2026‑01‑09.

**🗣 Dave:** *"Dave Trinca, Wantagong Station. What's the temporary water market doing around our way
at the moment — is it a good time to sell?"*

**🤖 Adviser:**
> Yes — good time to sell temp allocation. Murrumbidgee GS (region 686) is ~$420/ML, up from ~$280 in
> spring and near a 12‑month high; 15 live buyers want 3,825 ML (best bid $420) vs your 654 ML there,
> so it clears fast. Your last temp sales were $200–450/ML, so current pricing is at the top of your
> range. One flag: your big 5,004 ML holding sits in Coleambally (region 670), which **has no live temp
> market right now** (one stale trade in Jan) — sell that via the Murrumbidgee zone, not in-region.

**🗣 Dave:** *"Righto. If I push 500 ML out through the Murrumbidgee this week, how fast does it clear
and at what price?"*

**🤖 Adviser:**
> 500 ML through Murrumbidgee GS (686) this week: price ~$415/ML — there's a **1,000 ML buy order
> sitting at $415**, so all 500 ML fills against it in one hit (only 7 ML is bid higher at $420).
> Clears effectively immediately. Net ~$209,670 on $207,500 gross (commission ~$300 + GST; before any
> government/authority charges). Note: this only covers your 654 ML in region 686 — your 5,004 ML in
> Coleambally (670) is a separate market.

**🗣 Dave:** *"Why can't I just sell the Coleambally water in Coleambally itself? Seems odd I'd have to
route it through the Murrumbidgee."*

**🤖 Adviser:**
> Two reasons. First, Coleambally GS (670) is an irrigation-corporation zone — only one temp trade
> settled there in the last 6 months (Jan, $450), so in-region you'd be selling into a near-empty book.
> **But to correct myself: 670 actually does have live in-region buy demand right now — 17 buyers,
> 3,895 ML, best bid $420 — and it trades to Murrumbidgee GS (686) at 1:1.** So you don't have to route
> it out; you can sell in Coleambally itself at effectively the same ~$415–420/ML, or list across both
> to hit the deepest pool. Either works at parity. The only real constraint is approvals (IIO/state
> transfer rules), which resolve in the trade application — not a market-price issue.

**Spot-check:** ✅ All volumes/prices match; region 670 *does* have 17 live buys / 3,895 ML @ $420 at the
snapshot, and only 1 settled temp trade in 6 months — so both statements are factually grounded. ⚠️ But
turn 1's "no live temp market" was **mis-framed** (it read settled history, not the live order book)
and only got corrected in turn 3. See Finding 1 — this is the one place a client could have been
briefly misled.

---

## Persona 5 — Sarah Godden · Angoves

**Verified ground truth:** region 338 (SA Class 3) holds one row each of REG/ALL/CAR/ENT/MAX/TOP at
**4,054 ML** — i.e. 4,054 ML of entitlement expressed six ways (a naive sum = 24,324 is a 6× double-
count); dormant since 2021.

**🗣 Sarah:** *"Sarah from Angoves. Quick one — roughly what would our SA River Murray entitlement be
worth if we decided to sell the lot?"*

**🤖 Adviser:**
> **~$32M (gross).** Your SA River Murray entitlement is **4,053 ML in region 338** (Class 3
> Irrigation), and permanent water there has settled at a median **$7,900/ML** (range $7,200–8,000, 15
> trades to Jan 2026). At $7,900 → ≈$32.0M gross; net of brokerage/GST roughly **$31M**. Caveats:
> that's a 6‑month‑old print (thin — 3 trades in last 6mo), so confirm a live indicative before
> committing, and 4,053 ML hitting the book at once would need to be staged to hold price.

**🗣 Sarah:** *"And what would fees and GST strip out of a sale that size?"*

**🤖 Adviser:**
> Roughly **$1.1M–$1.3M off the top — call it ~$31M net** on a $32M sale. The flat rate-card row reads
> 0% + a $400 floor, but that's the stale/incomplete card — SA permanent fees run on a tiered ML
> schedule that resolves in app code, so I can't quote it deterministically. Anchoring instead on what
> Waterfind has actually charged on region‑338 permanent sales: median effective brokerage **~3.6% of
> gross** (575 settled sides). On $32.0M that's ~$1.14M brokerage + ~$114k GST ≈ $1.25M, leaving
> **~$30.8M net**, before SA government/authority transfer fees. Ballpark — exact figure is only nailed
> down on the post-settlement statement.

**🗣 Sarah:** *"Would we actually net more selling that entitlement into NSW or Victoria instead of SA?"*

**🤖 Adviser:**
> **No — you can't sell this entitlement into NSW or Victoria; there's no open permanent-trade pathway
> out of SA from this zone.** All 13 tradable destinations for region 338 permanent are within SA (the
> Citrus Trust zones, Renmark, and SA River Murray itself), every one at 1:1. Any cross-border SA→NSW/VIC
> permanent relationships are suspended at the state-gate level, so the question doesn't arise — SA at
> ~$7,900/ML is the market. If you're thinking of the much higher southern-connected entitlement prices
> quoted elsewhere, those are different products in different zones and aren't reachable from this
> licence — I'd confirm before anchoring on them.

**Spot-check:** ✅ **Best correctness win:** the agent valued **4,054 ML (REG)**, *not* the 24,324 ML
naive sum — correctly avoiding the REG/child double-count that the data-map explicitly warns about. ✅
It rejected the stale rate card and anchored fees on actual charged commission. ✅ Cross-border ruling is
right — the STR gate closes SA→NSW/VIC permanent trade. A textbook example of the guardrails working.

---

## Overall assessment

**Verdict: the agent performs well.** Across 15 exchanges it stayed grounded in live queries, its
numbers reconcile to the database, and — most importantly — its **judgment and guardrails held**: it
admitted when an account had no broker, refused to size a trade when the deciding data wasn't in the
system, ruled out impossible interstate trades, avoided the REG/child double-count, and rejected stale
reference data in favour of real settled prices. It also surfaced genuinely non-obvious insight (split/
assigned settlements; market-impact of dumping a large parcel).

**Strengths**
- **Honest about limits.** P3 (allocation balance) and P1 (no broker) are exactly the failure modes a
  naive tool would fudge. It didn't.
- **Correct data modelling.** P5's 4,054 ML (not 24,324) and P2's use of `external_sales` for a
  permanent valuation show it understood the schema's traps.
- **Right reference data.** Priced off recent `order_completed`/`external_sales`; explicitly distrusted
  the stale rate card and indicative price.
- **Mostly tight and decision-led**, leading with the number.

**Findings to address**
1. **Liquidity framing (the one real wobble).** P4 turn 1 said Coleambally had "no live temp market"
   based on *settled* history, then found 17 live buyers in turn 3. Fix: the liquidity check should
   always read the **live order book**, not just settled trades, before declaring a market thin/absent.
   — ✅ **Fixed 2026-06-22:** added a "Liquidity = the live order book, not settled history" rule to the
   agent definition.
2. **Preamble leak.** A few replies emitted an internal planning sentence before the answer (trimmed
   here), violating the "no preamble / lead with the answer" rule. Worth tightening in the prompt.
3. **Length drift.** A couple of answers (P1 T1, P3 T2/T3) exceeded the "≤3 sentences or a compact
   table" target. Justified by question complexity, but the agent over-delivers when it could ask a
   narrowing question instead.
4. **Fee basis inconsistency.** P1/P4 net used the flat rate-card floor (~$300 brokerage, ~99.6% net),
   which understates vs actual charged rates; P5 did it right by anchoring on the **median actually-
   charged commission**. Recommend standardising net-proceeds on the actual-charged basis (and always
   flagging gov/authority fees as excluded).
   — ✅ **Fixed 2026-06-22:** agent rule updated and toolkit **Q7 rewritten** to estimate brokerage from
   the median actually-charged rate (`waterfind_commission_index`), rate card as fallback only. Re-tested:
   515 temp now reads 3.79% / net $76,661 (was the understated ~99.6% / $79,670).

**Net:** ship-worthy as a draft adviser. The highest-value fix is #1 (live-orders liquidity check);
#2–#4 are polish.

---

# Round 2 — testing the seasonal / per-region integration (2026-06-22)

After integrating per-region **seasonal allocation** (`water_allocation_reading`), **climate drivers**
(`dam_reading`/`soi_monthly_reading`) and **settlement/risk** (`approval_procedure`/`dispute`), three
more tests — each targeting the new capabilities. 2 turns each.

## Test 6 — Margaret Field · T.A. Field Estates · *seasonal allocation*

**Ground truth:** 24,642 ML entitlement; current allocation %: Murrumbidgee GS 32%, Lower Lachlan GS
22%, HS 95%, groundwater + SA Class 3 + VIC HR 100%, Murrumbidgee Supplementary = no announcement.

**🗣 Margaret:** *"With the season turning, how much of our 24,000-odd ML of entitlement is actually
water in hand right now — what can we realistically count on this season?"*

**🤖 Adviser:**
> About **8,500 ML in hand right now, ~35% of your 24,642 ML.** Estimate only; exact credited balances
> sit with WaterNSW/GMW, not us.
>
> | Entitlement | ML | Alloc % | In hand (est.) |
> |---|---:|---:|---:|
> | Murrumbidgee General Security | 13,067 | 32% | ~4,180 |
> | Lower Lachlan GS (LV2) | 6,170 | 22% | ~1,360 |
> | Murrumbidgee High Security | 1,548 | 95% | ~1,470 |
> | Lower Lachlan Groundwater | 1,004 | 100% | ~1,000 |
> | SA Murray Class 3 / VIC Murray HR / others | ~450 | 100% | ~450 |
> | Murrumbidgee Supplementary | 1,917 | — | **count on nothing** |
>
> Firm: HS + groundwater (~2,770 ML at 95–100%). The big GS parcels (22–32%) are a **floor** that climbs
> as the season is announced; the Supplementary is opportunistic — plan on zero. Percentages are dated
> Oct–Nov 2025 — refresh today's WaterNSW announcement before committing volume.

**🗣 Margaret:** *"That's sobering — our GS is barely a third. Should we sell any water this season, or
hold it all given how tight GS is?"*

**🤖 Adviser:**
> **Sell a slice of your firm High-Security water; hold all the General Security.** You're a
> water-investment account (no crop), so this is purely where the value is.
> - **Hold GS:** Murrumbidgee allocation has run ~$250→**$420/ML** as the season tightened, and your GS %
>   (22–32%) keeps climbing — selling now locks the bottom of *both* the price ramp and the allocation
>   curve. Wrong end.
> - **Sell some HS:** your 1,548 ML HS is 95% allocated (~1,470 ML firm) and the live book is deep at
>   **$420/ML** (15 buy orders, ~3,800 ML demand in the zone). Same price as GS but certain volume — sell
>   **300–500 ML** and keep the rest as carryover insurance.
> Refresh today's WaterNSW allocation + live bids before placing anything.

**Spot-check:** ✅ Methodology correct; GS 32% / HS 95% / GW 100% / Supplementary-null all match, the
hold-GS/sell-HS logic is right for a no-crop investment holder, and the totals are **correct** —
groundwater 1,004 ML, ~8,468 ML in hand vs 24,642 entitlement.

> **⚠️ Correction (2026-06-22).** I originally flagged this as the agent under-counting groundwater
> (claiming the truth was 2,008 ML). That was wrong — the **2,008 came from a bug in my own toolkit
> query Q11**, not the agent. Region 630143 maps to **two** allocation records (`Lower Lachlan
> Groundwater` + `NSW Groundwater`), so `JOIN property → water_allocation_region` then `SUM(quantity)`
> double-counts the single 1,004 ML holding. The agent computed holdings *first* and was correct
> (1,004 / ~8,468). The real defect is in **toolkit Q11** (a region→multiple-allocation fan-out;
> 40 regions are affected) — fix pending: aggregate one % per region before multiplying.

## Test 7 — Dave Trinca · Upper Wantagong Station · *climate & seasonal outlook*

**Ground truth:** Coleambally GS (region 670) latest reading 32% (1 Oct 2025), opened 4% in July; SOI
−14.5 (Jun 2026, dry); NSW dams ~68% full; client's HS at 95%.

**🗣 Dave:** *"The season's looking dry. Is my Coleambally allocation likely to climb any further, or is
32% about it — and what's the broader outlook telling you?"*

**🤖 Adviser:**
> 32% (Coleambally/Murrumbidgee GS) is the **1 Oct 2025 reading — an early-season figure, not the
> ceiling.** GS opened at just 4% in July and has climbed every fortnight since; the last two seasons
> kept rising into autumn (2024 hit 100% by Feb, 2025 reached 41%). Further upgrades are likely — how
> far depends on winter–spring inflows. Backdrop, lean cautiously dry: **SOI firmly negative (−14.5 Jun,
> −11.2 May = El Niño/drier)**, but **NSW storages ~68% full** (Feb 2026), so supply isn't bare. Your
> **High-Security is already 95%** — effectively full. Don't treat 32% as final; don't bank on a big
> upgrade. Confirm the exact credited balance with WaterNSW — we hold the announced %, not your account.

**🗣 Dave:** *"So for my temp water — sell the allocation now while prices are up, or wait for the
percentage to climb?"*

**🤖 Adviser:**
> **Sell a portion now, keep a portion** — not all-or-nothing.
> - **Sell now:** Coleambally trades thin but firm — live book has **17 buy orders, ~3,900 ML demand,
>   best bid $420/ML**; last settle (Jan) printed **$450/ML** (up from ~$243 in spring). Dry-season
>   scarcity is what's holding price up — that premium fades if allocations get upgraded.
> - **Wait:** the 32% will likely climb, giving more *volume* — but more announced = more sellers =
>   **softer price.** They pull against each other.
> The % climbing helps your **quantity, not your price** — waiting for both to peak is rarely possible.
> Lock current $420 demand on a tranche now; hold some for crop need and any later upgrade. Net ~2–4%
> brokerage + GST, government transfer fees excluded.

**Spot-check:** ✅ Trajectory (32% latest, 4% July open), SOI −14.5, NSW dams ~68%, HS 95% all match the
DB. The "% helps quantity, not price" framing is the correct economic read, and it used the new
actual-charged fee basis. A clean, high-quality answer.

## Test 8 — Jenny Kendrick · MJ & JK Kendrick · *settlement & counterparty risk*

**Ground truth:** trade 34481 matched **2026-06-23** (today), 1 ML in region 515 (VIC Murray) temp,
$100/ML, `approval_procedure.progress = 0`; **0 disputes** on the account.

**🗣 Jenny:** *"The buyer on our latest water sale is chasing me — has it gone through? Where's it up
to?"*

**🤖 Adviser:**
> **Not settled yet.** Your latest sale (1 ML temp in *7 VIC Murray (Barmah–SA) GMW*, $100/ML) **matched
> the buyer today (23 Jun)** but is at the very start of approval — **progress 0/100**, no settlement
> payment issued. Tell the buyer it's accepted and working through transfer approval, not yet complete.
> No disputes or hold-ups on your account. I'll flag the moment it clears and your proceeds are paid.

**🗣 Jenny:** *"What'll actually land in our account when it settles, and any idea how long that takes?"*

**🤖 Adviser:**
> On $100/ML × 1 ML = $100 gross, Waterfind brokerage runs **~3.8%** here (the rate actually charged on
> recent allocation sales in this market), so roughly **$96 lands in your account** after commission +
> GST — government/authority transfer fees are extra, exact figure firms up on the settlement statement.
> On timing: **I can't quote a reliable figure — the system doesn't time-stamp approval completion.** As
> a general guide a VIC GMW allocation transfer usually clears within a few business days of approval,
> but that last leg sits with GMW, not Waterfind. I'll let you know the day it settles.

**Spot-check:** ✅ Pulled the live in-progress trade correctly (matched today, region 515, 0/100), gave
the net on the actual-charged basis (~$96), reported the clean dispute record honestly, and — best of
all — **refused to invent a settlement duration** because the data has no completion timestamp. Exactly
the right behaviour.

## Round-2 assessment

The seasonal/risk integration **works end-to-end and is genuinely decision-useful** — Test 6 finally
answers the "how much can I actually sell?" question that the agent had to *refuse* in Round 1, and the
climate/trajectory reasoning (Test 7) and live-settlement honesty (Test 8) are strong. The new fee basis
(Fix 4) and live-order-book liquidity (Fix 1) both carried through. **One finding (later corrected):**
the apparent Test-6 groundwater under-count turned out to be a bug in *toolkit Q11* (a
region→multiple-allocation join fan-out that double-counts holdings), **not** an agent error — the
agent's figures were correct (see the correction above). Q11 fix pending. Otherwise: ship-worthy.

---

# Round 3 — buy-side, latent demand & arbitrage (2026-06-22)

Three more, targeting angles not yet conversation-tested: a **buyer** (every prior persona was a
seller), **carryover/EOI latent demand + crop mix** (Q16), and **cross-region arbitrage / single-best-
move synthesis**. 2 turns each.

## Test 9 — Ian Bolitho · Riversby/Bolitho Holdings · *buyer*

**Ground truth:** Central Goulburn 1A (region 2816), 361 ML entitlement, Goulburn HR allocation 73%.
Live sell book in 2816 (asof 15 Jun): $400×19 ML, $410×45, $420×12, $425×333, $430×414, $435×1,165.
Buyer-side commission median in 2816 = **4.00%** (39 sides).

**🗣 Ian:** *"We're short this season and need to buy in temporary water for the Goulburn. What can we
get, and what'll it cost us per ML?"*

**🤖 Adviser:**
> Here's the Goulburn temporary-water picture for Riversby (Central Goulburn 1A, where your 360.8 ML
> entitlement sits). **What you can get — plenty:** ~53 standing offers, **~3,750 ML on offer**.
> **What it'll cost — budget ~$425–$435/ML:** lowest asks start at $400 but are thin (5–8 ML parcels);
> real clearing depth is **$425–$435** (~2,000 ML offered at $435 or below). Recent settled (last 6 mo,
> latest 31 Jan) ran $375–$430, **median ~$415** — so the book is asking a touch above last print.
> **My call:** post a bid at **$420–$425** for your shortfall; $435 lifts ~2,000 ML immediately. Above
> ~$450 you're overpaying (ignore the lone $2,000/ML offer — noise). Context: Goulburn HR allocation is
> **73%** (Jan 2026), so on 360.8 ML entitlement you'd expect ~263 ML credited. $/ML is trade price;
> brokerage + GST + government transfer fees are additional.

**🗣 Ian:** *"Say we go for 200 ML — can we get that filled now, and the all-in landed cost per ML once
your fees are in?"*

**🤖 Adviser:**
> **Yes — 200 ML fills inside the bottom of the ladder** ($400×19, $410×45, $420×12, then the $425
> cluster). The 200th ML lifts at **$425/ML**; **volume-weighted ≈ $421/ML** ($84,225). Post a single
> bid at $425 and you sweep the lot. **All-in landed:** water ~$421/ML + Waterfind **buyer-side
> brokerage 4.0%** (the rate actually charged here, 39 settled buy-sides) ~$16.85/ML + GST ~$1.68/ML =
> **~$440/ML (~$87,930 for 200 ML)**. Government/authority (GMW) transfer fees are extra and confirmed
> only on the settlement statement. I can't place the order — to bid the 200 ML I need Riversby's
> go-ahead through the broker.

**Spot-check:** ✅ Buyer-side rate 4.0%/39-sides matches exactly; the ask ladder and the **$425 marginal
fill / ~$421 VWAP** are right; all-in ~$440/ML is sound, and it correctly used the **buyer** side of the
commission and flagged GMW fees + its read-only limit. Tiny imprecision: it stated the $425 level held
~100 ML (actual 333), which only makes the fill *easier* — conclusion unaffected. Excellent buy-side.

## Test 10 — Priya Nair · Almond Management Australia · *carryover, crop mix & latent demand*

**Ground truth:** crop = Almonds; an existing carryover-**sell** EOI (1,000 ML, Murray 7, $500/ML).
Zone 7 carryover EOIs price at **median ~$100/ML** ($10–150) — vs allocation settling ~$405–415/ML.

**🗣 Priya:** *"We've got ~1,000 ML of carryover in the Murray (zone 7) we're thinking of offloading,
and we're an almond operation. What demand is out there, and what's it worth?"*

**🤖 Adviser:**
> **Demand is real and deep.** Zone 7 live book: **28 buy orders, ~5,600 ML of bid demand, best bid
> $420/ML** (median ~$240). Your 1,000 ML clears comfortably (~5× cover). Settled allocation in Zone 7
> last 6 mo: median **~$400/ML** (p25–p75 ~$370–$420), latest 23 Jun. Defensible ask **$400–$420**.
> **Net on 1,000 ML @ $405:** gross ~$405,000 − brokerage at the rate actually charged on Zone 7
> allocation (**~4.4%**, 166-side sample, not the rate-card floor) ~$17,650 − GST ~$1,765 ≈ **net
> $385,600** (government transfer fees excluded). Two flags: **you already have a carryover-SELL EOI
> lodged for 1,000 ML in Murray 7** — this lines up; and VIC Murray HR is at 100% this season, so
> carryover demand is users topping up, not scarcity — bid depth is good now, move while $420 holds.

**🗣 Priya:** *"Does carryover specifically fetch a premium, or are we better off just selling it as
normal allocation? Is anyone actually chasing carryover?"*

**🤖 Adviser:**
> **No — don't chase a "carryover premium"; sell it as allocation.** Two different things trade here:
> - **Selling the water (allocation):** the deep market I quoted — ~5,600 ML bid demand, best bid $420,
>   settled ~$405. *This is your play.*
> - **Carryover EOIs:** there *is* interest (~15 buy EOIs vs ~20 sell across Vic/Murray 7), but they're
>   quoting **median ~$90/ML ($10–150)** — that's a **parking/storage-rights fee** (paying someone to
>   carry water over the year boundary), **not the value of the water**. It trades at a fraction of the
>   allocation price.
> So the premium, if anything, is on the *water*, not on its carryover status. Sell the ~1,000 ML as
> allocation at **$400–$420** (~$385,600 net). Caveat: the EOIs carry no date stamp in our data, so I'm
> reading them as standing interest — the live book + the 23-Jun settlement are the firmer signals.

**Spot-check:** ✅ The headline insight is **correct and genuinely subtle** — carryover EOIs settle
~$100/ML (verified) because they price the *storage right*, not the water, so "carryover premium" is
backwards. Crop (Almonds) and the existing carryover-sell EOI both surfaced and were tied into the
advice. The exact EOI tallies (~15 buy / ~11,900 ML) run a little above a narrow region filter
(free-text region matching is fuzzy), but the price conclusion is solid. Best reasoning of the round.

## Test 11 — Kyle Egan · Njernda (returning) · *cross-region arbitrage & best move*

**Ground truth:** 515 (372 ML, 100% allocated) reaches 72 temp markets at conversion 1.0. Local 515
seller commission **3.79%**; SA Class 3 (338) temp median **$415**, seller commission **5.21%** (248
sides); 515 settled temp median ~$383.

**🗣 Kyle:** *"Across all the markets my water can reach, where would I actually get the best price —
am I leaving money on the table by just selling locally?"*

**🤖 Adviser:**
> **Yes, a little — but less than the headline gap, and only on the settled band, not the live book.**
> Your 515 holding (372 ML, 100% allocated) reaches **72 temp markets at conversion 1.0** — so price,
> not access, is the question. **Live book:** best bid is a flat **$420/ML everywhere** (basin-wide
> standing buyers), deepest in your own zone (~5,636 ML) — for an immediate sale, local ties anywhere.
> **Settled band is where the spread lives:** local 515 ~$383, **SA Class 3 (338) ~$413** (28 trades,
> active to late May), 11 Murray Below Choke (2591) ~$442 (thin, 3 stale trades). **Net on 372 ML:**
> local ~$136,500 (3.79% comm) vs **SA-338 ~$144,800 (5.21% comm) → +$8,300**. SA's higher brokerage
> eats ~a third of the raw premium, but you're still ahead. Don't chase the $442 print at 2591 — stale,
> no live depth.

**🗣 Kyle:** *"So what's the single best trade you'd put in front of me right now? Give me one move."*

**🤖 Adviser:**
> **One move: lift your 372 ML of 515 allocation into SA Class 3 (region 338), not the local zone.**
> Conversion 1.0 (no volume lost); settled ~$413 vs ~$383 local; after SA's ~5.2% brokerage vs 3.8%
> local, **~$144,800 net vs ~$136,500 — about +$8,300** on this parcel (gov/authority fees excluded).
> 515 is 100% allocated, so the full 372 ML is yours to sell. **Execution:** list in 338 with a floor
> around $413 rather than hitting a bid blind. If you need cash now, take the **$420/ML live bid** in
> your home zone — ties the best live price basin-wide with the deepest book — but the patient SA route
> is the better-money play.

**Spot-check:** ✅ Fully verified — 338 temp $415/5.21% (248 sides), 515 3.79%, conversion 1.0, +$8.3k
all match. Genuinely sophisticated: it separated the **flat $420 live book** from the **settled spread**,
computed **net-of-actual-fees per venue** with side- and region-specific rates, and dismissed a stale
thin print. (The per-venue fee attribution is a reasonable simplification of cross-region trade
mechanics.) Decisive single-move close.

## Round-3 assessment

The agent extended cleanly into territory it hadn't been tested on. **Buy-side** (Test 9): it walked
the ask ladder to a marginal-fill price + VWAP and applied the **buyer-side** actual-charged rate — not
just mirroring the sell-side logic. **Latent demand** (Test 10): the carryover-vs-allocation distinction
(storage-rights fee ≠ water value) is a subtle, correct call that a naive tool would get wrong, and it
wove in the client's crop and existing EOI. **Arbitrage** (Test 11): per-venue net with side/region-
specific rates, live-vs-settled separation, and a decisive recommendation. Both prior fixes generalised —
**Fix 4** now applies the right rate by *side* and *venue*, and **Fix 1**'s live order book is used
throughout. No new agent errors this round; the only nitpick is a minor ask-ladder quantity imprecision
in Test 9. Across all 11 tests the agent is consistently accurate, honest about limits, and decision-led.
