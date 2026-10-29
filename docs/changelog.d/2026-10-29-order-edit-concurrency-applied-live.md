## 2026-10-29 — Version-checked order edits: migration applied live

- `docs/reference/migration-history.md`: a fresh read-only live preflight (ledger high-water and the one live `update_order_items` overload) for the migration reviewers, and row 1001 (`20261028185500_order_edit_and_number_concurrency`, To-Do 1.12, PR #1185) recording the live apply on 2026-10-29 at 9:36 AM Central (ledger version `20261029143642`) and the post-apply catalog check.
- `docs/reference/rpc-functions.md`: `update_order_items` now takes the order's expected version and refuses stale saves; `generate_ticket_number` is serialized and internal-only.
- `docs/manual/CURRENT_STATE.md`: last-verified line updated for the apply and the return of the #1185 frontend to production.
