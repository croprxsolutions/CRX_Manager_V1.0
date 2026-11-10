## 2026-11-06 — Deliveries read rules check the reader's role once per query

- New migration `20261129100000_deliveries_read_rules_check_role_once.sql` (applied live 2026-11-06, ledger 20261106182955; record in
  `docs/reference/migrations.d/`). The rules that decide who can read deliveries and delivery items
  now look up the reader's role once per query instead of once per row. Who can read what does not
  change. At 60,000 deliveries a sales rep's Deliveries list was several times slower than an admin's
  because of the per-row lookup.
- Proof: `prove-deliveries-read-rules-real-schema.mjs` shows identical visible rows for every role
  before and after, and the speed-up. Applied with Mason's approval (it rewords an access rule).
