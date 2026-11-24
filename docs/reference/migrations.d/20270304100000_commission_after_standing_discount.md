**LOCAL CANDIDATE — NOT APPLIED.** M4: commission after the standing discount, never on sales tax (Mason, 2026-11-09: "commission on the profit after discounts"). `20270304100000_commission_after_standing_discount.sql` (SQL sha256: `8e2993b83c14a5620d1d9ef62aa6ed230c84056269ad8eaa44783a42f00c05c6`).

**What it does.**
- `_order_commission_base_20270304(sale)` = `orders.total_profit` + `_order_standing_discount_20270109(sale)`: the sale's profit after the standing-discount lines on its chemical-sale invoices that aren't voided or deleted (drafts included; every Bill Split payer). Sales tax is never in it.
- `_recompute_order_commissions_20270304(sale)`: puts the sale's pending rows that are in no live payout batch on that base (whole live set: exact to the cent, largest remainder; otherwise each pending row its own share). Paid or batched rows never move. Writes nothing when the rows already sit on the base, so an undiscounted sale and its commission history are exactly as before.
- Four deferred (commit-time) triggers run it: `invoice_items` (a standing-discount line added, changed or removed), `invoices` (one carrying a discount line voided, deleted, moved or retyped; and invoice deletes), `commissions` (a sale's pending row minted or recomputed: the 7 sale creators, edits, Cancel Remaining, Fix Delivery).
- Sales that already carry a discount line are recomputed once at apply (staging test data; live has none while the M4 switch is off).

**Not changed:** the commission writers, field-job commission (field-application invoices can't carry a discount line), payouts, reports (they read stored amounts; Reports › Commissions "Order Profit" now shows the profit after discount), the M4 switches (`billing_m4_switch`, `billingM4Enabled()`).

**Known limit:** a commission already paid or batched keeps its amount when a later invoice of the same sale brings more discount (taking it back goes with returns, KI-13).

**Proof:** `scripts/smoke/smoke-commission-after-discount.sql` (A–G) and `scripts/smoke/prove-commission-after-discount-real-schema.mjs` (before fails, apply, after passes, re-apply refused, rollback restores). $1,000 sale, $600 cost, 10% off, 7% tax, 60/40 → $180.00 / $120.00 on $300.00 (was $240 / $160 on $400).

**Ordering:** after `20270117130000_standing_discount_in_order_profit`. Rollback: its own reviewed migration (drop the four triggers and three functions).
