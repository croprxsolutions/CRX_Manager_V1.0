## 2026-11-16 — Stock checks: negative-only reconcile, retire vs open POs, Chicago receiving dates

- New migration `20270113100000_stock_checks_negative_onorder_chicago.sql` (not applied live; record in `docs/reference/migrations.d/`). KI-139, KI-141, KI-162.
- "Reconcile negative inventory" now only works on stock that is below zero.
- Deleting (retiring) a stock row is refused while units are still on order on an open purchase order, or while someone else is changing that row (try again in a moment).
- The Receiving Log's From/To dates now follow the Central time day, so evening receipts file under the right date.
