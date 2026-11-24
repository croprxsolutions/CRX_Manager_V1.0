## 2026-11-24 - Customer receipts: Mark handled is admin-only

- Migration `20270301120000_mark_handled_admin_only` (not applied): only an admin can mark a customer receipt handled. A sales rep can still hand-send a receipt with Email Confirmation; it then stays on the list until an admin marks it handled (Mason, 2026-11-24). Mason decided this 2026-11-23 (Slack, Taha's review item 6). "Customer receipts to check" stays the safety net: reps still see it, without the Mark handled button.
- Proof: `scripts/smoke/prove-ki25-receipt-screens-real-schema.mjs`. Record: `docs/reference/migrations.d/20270301120000_mark_handled_admin_only.md`.
