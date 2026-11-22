## 2026-11-18 — Purchasing plan: held stock never reads as free

- New migration `20270206130000_purchasing_plan_held_stock_never_free.sql` (not applied live; record in `docs/reference/migrations.d/`). Built on release #1990's body (`20270129160000`, keeps its soft-deleted-order rule); re-emits `get_purchasing_plan` only.
- Fixes Sol round 2 HIGH on #1980: stock held for a Maybe booking read as free, so a Firm need elsewhere looked covered. Held stock now always counts as spoken for (Mason, 2026-11-18), but a hold never makes the plan buy on its own: it counts today only up to the stock left on the shelf, Firm lines first; the rest stays as the booking line.
- Job holds count today the same way; a hold larger than its lines keeps the rest held.
- Holds that still count today (manual, or a draft booking's) count only up to the stock on the shelf; the rest of a booking's hold counts at its need date (Mason, 2026-11-18, "I agree cap it"), so a draft booking's hold alone no longer makes the plan say "order now" for stock needed later.
- Draws keep the least-sure, latest-first rule, so a draw never erases Firm demand (Mason, 2026-11-19, after Sol round 5 on #1989: the safe guess). It may suggest buying for a Firm line an order already drew.
- The part of a hold not yet on the shelf takes incoming purchase-order stock first, so that stock no longer reads as free for other orders (Mason, 2026-11-19, after Sol round 5).
- A draft booking's hold with an "infinity" date counts today.
- Rebuild after the Nov 20 Sol review (Mason kept "holds take incoming stock first", 2026-11-21): a hold claims only PO stock arriving by its own expiry, earliest-expiring first; a Maybe, Likely or undated line's claimed part keeps its own confidence and date and only reserves the PO stock; a hold whose booking or job is gone, closed or converted (or beside a line set aside for its unit), and a job hold on an unconvertible line, reserve shelf stock only and never make the plan buy.
- A draw against a line set aside for its unit no longer reads as over-drawn; a job's draw beyond its own section is listed under drawn, section unknown.
- #1977 database MEDs: a timing window crossing New Year now ends next year, and a window whose start or end is not a real month-day falls back to its default as a whole (as the screen does).
- Proof: `node scripts/smoke/prove-purchasing-plan-held-stock-real-schema.mjs` plus the `smoke-purchasing-plan.sql` chain (new P26-P35). Not yet verified on staging.
