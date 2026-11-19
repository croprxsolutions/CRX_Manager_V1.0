## 2026-11-19 - The staging database job stops on a one-shot whose rows still need it, and allows a moved one-shot entry

Sol 1 and 5 on the v0.1.0 release (#1990), both in `.github/scripts/db-apply.mjs`:

- **KI-137 one-shot.** A one-shot data migration is recorded, never run, because a restore brings its rows already corrected. A staging copy restored from live data from before KI-137 still has the old Powder Keg and Piksi labels, so recording KI-137 there would leave them, and `20270121110000` would then refuse. `supabase/baselines/one-shot-migrations.json` now has `stop_if_still_needed`, a check per one-shot. `db-apply` runs it before recording that one-shot, and if the rows are still uncorrected it stops before writing anything and says how to fix it: apply the file by hand (its own preflight checks every row), then run again. Only KI-137 has a check; the older one-shots behave as before. Live doesn't use this list: the release applies KI-137's SQL for real.
- **Restamped one-shot.** The PR check refused a restamp of a staging-only one-shot when its list entry moved with the file. An entry may now leave the list when this PR restamps that file into a new name the list holds.

Taha's call (2026-11-19): a loud stop, no automatic run.
