## 2026-11-23 - RT-4a: a button to switch a product group to its approved rate, and back

- Product page, Parent panel: a "Rate in use" row (Old rate / Approved rate) and an admin-only button, "Switch to approved rate" or "Switch back to old rate" (Mason, 2026-11-23). Contract: `docs/plans/2026-11-23-product-RT4a-cutover-button-CONTRACT.md`.
- The button previews first (`preview_parent_rate_cutover`): per size, the old and new rate and unit, suggested rate, and tier 1–3 per-acre prices, plus the open quotes, orders and jobs that use the sizes. A refused group shows the database's reason and cannot be switched.
- Switching needs a reason and sends the preview back unchanged with an idempotency key (`commit_parent_rate_cutover`); the database refuses if anything changed since the preview. A lost reply retried sends the same key and gets the first result.
- Screen only: no database change. Both RT-4 migrations are live since 2026-11-21.
