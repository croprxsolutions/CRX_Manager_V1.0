## 2026-11-17 - RT-4a: switch a product group to its approved rate, and back

- Migration `20270125100000_product_rate_cutover.sql` adds a per-group rate source (`legacy` = today's rate, `approved` = the rate Mason approved in RT-3). Every group starts on `legacy`; the migration changes no rate or price.
- Admins preview and commit one group at a time (`preview_parent_rate_cutover`, `commit_parent_rate_cutover`, with a reason and an idempotency key). Switching writes the approved rate to the group and all its sizes, recomputes per-acre prices, and keeps the old values in a `rates_promoted` event. Switching back restores those old values at today's prices (`rates_restored`).
- Refused: rate lock off, inactive groups, draft rates, undecided or "needs label data" groups, sizes that disagree with their group, a unit change under a blend recipe or blank-unit blend line, a stale preview, and the held Piksi Dust Plus group (Mason, 2026-11-17).
- While a group uses its approved rate, its rate, unit, suggested text and form, its RT-3 rows and its outcome are frozen by database triggers, and the rate lock cannot be turned off. A size added to it takes the approved rate.
- Moving a size is not refused outright: the rate lock already refuses any move that would change a size's rate (a deviation from contract P6, recorded in the contract).
- Proof: `node scripts/smoke/prove-rate-cutover-real-schema.mjs` (`RATE_CUTOVER_PROOF_PASS`). No screen uses the new functions yet; the pilot runs from Mason's admin login after the live apply.
