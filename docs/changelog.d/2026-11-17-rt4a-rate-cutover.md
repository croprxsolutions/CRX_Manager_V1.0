## 2026-11-17 - RT-4a: switch a product group to its approved rate, and back

- Migration `20270125100000_product_rate_cutover.sql` adds a per-group rate source (`legacy` = today's rate, `approved` = the rate Mason approved in RT-3). Every group starts on `legacy`; the migration changes no rate or price.
- Admins preview and commit one group at a time (`preview_parent_rate_cutover`, `commit_parent_rate_cutover`, with a reason and an idempotency key). Switching writes the approved rate to the group and all its sizes, recomputes per-acre prices, and keeps the old values in a `rates_promoted` event. Switching back restores those old values at today's prices (`rates_restored`).
- Refused: rate lock off, inactive groups, draft rates, undecided or "needs label data" groups, sizes that disagree with their group, a unit change under a blend recipe or blank-unit blend line, a stale preview, and the held Piksi Dust Plus group (Mason, 2026-11-17).
- While a group uses its approved rate, its rate, unit, suggested text and form, its RT-3 rows and its outcome are frozen by database triggers, and the rate lock cannot be turned off. A size added to it takes the approved rate.
- A switch that keeps the same rate is refused when a size's saved per-acre prices are out of date.
- A size cannot move into or out of a group that uses its approved rate; switch the group back first. Both Piksi groups are held by ID. While a switch runs, blend recipe and blend ticket lines wait.
- Taha's review (2026-11-18): while a group uses its approved rate in a new unit, new blend recipe lines and blank-unit blend ticket lines on its sizes are refused, so switching back cannot get stuck; deleted recipes no longer block a switch back.
- Mason (2026-11-18): a switch that changes the rate rewrites the suggested-rate text from the approved rate (for example `1.8 Lb/acre`); switching back puts the old text back.
- Proof: `node scripts/smoke/prove-rate-cutover-real-schema.mjs` (`RATE_CUTOVER_PROOF_PASS`). No screen uses the new functions yet; the pilot runs from Mason's admin login after the live apply.
