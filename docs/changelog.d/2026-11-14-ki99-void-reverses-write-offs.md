## 2026-11-14 - KI-99: voiding an invoice reverses its write-offs

New migration `20270110100000_ki99_void_reverses_write_offs.sql` (not applied live): every void path (single, batch, group) now marks each of the invoice's active write-offs reversed, with one `write_off_reversed` audit row each, so a voided invoice's write-off no longer shows on the customer statement. Each write-off's Chicago month must be open, or the whole void is refused. Mason chose auto-reverse (DECISION_LOG 2026-11-14). The credit-month half of KI-99 was already fixed live by KI-18.

Contract: `docs/plans/2026-11-14-ki99-void-reverses-write-off-CONTRACT.md`. Proof: `node scripts/smoke/prove-ki99-void-reverses-write-offs-real-schema.mjs`. Rollback: a forward migration re-emitting the pre-image.
