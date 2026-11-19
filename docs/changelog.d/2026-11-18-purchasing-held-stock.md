## 2026-11-18 — Purchasing plan: held stock never reads as free

- New migration `20270127150000_purchasing_plan_held_stock_never_free.sql` (not applied live; record in `docs/reference/migrations.d/`). Needs `20270127110000` first; re-emits `get_purchasing_plan` only.
- Fixes Sol round 2 HIGH on #1980: stock held for a Maybe booking read as free, so a Firm need elsewhere looked covered. Held stock now always counts as spoken for (Mason, 2026-11-18), but a hold never makes the plan buy on its own: it counts today only up to the stock left on the shelf, Firm lines first; the rest stays as the booking line.
- Job holds count today the same way; a hold larger than its lines keeps the rest held.
- #1977 database MEDs: a timing window crossing New Year now ends next year, and a window whose start or end is not a real month-day falls back to its default as a whole (as the screen does).
- Proof: `node scripts/smoke/prove-purchasing-plan-held-stock-real-schema.mjs` plus the `smoke-purchasing-plan.sql` chain (new P26, P27). Not yet verified on staging.
