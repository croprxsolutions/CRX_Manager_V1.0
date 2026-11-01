## 2026-11-01 - Baseline data proof checks named rows

`supabase/baselines/README.md`'s data proof now checks each of the 53 Chem Man deliveries on its own
order, and each reservation release by order and product, so the right totals over the wrong rows
fail. Run in a rolled-back transaction on the test copy, it says `f` with no rows, `t` with correct
invented rows, and `f` for each of ten wrong sets, eight of which the totals-only query passed.
`scripts/list-post-baseline-migrations.mjs` no longer advises repairing one-shots after the push:
the README's push records them in order, under their whole name. `--one-shot-repair-plan` now only
lists those names. `npm run test:schema-baseline` also fails if the README's delivery list stops
matching `20261007150100`.
