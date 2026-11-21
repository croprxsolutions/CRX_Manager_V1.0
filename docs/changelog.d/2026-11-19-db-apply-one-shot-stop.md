## 2026-11-19 - The staging database job stops on KI-137 while its rows still need it, and allows a moved one-shot entry

Sol 1 and 5 on the v0.1.0 release (#1990), both in `.github/scripts/db-apply.mjs`:

- **KI-137 one-shot.** A one-shot data migration is recorded, never run, because a restore brings its rows already corrected. A staging copy restored from live data from before KI-137 still has the old Powder Keg, Piksi and Treaty Extra labels, so recording KI-137 there would leave them, and `20270121110000` would then refuse. Before recording KI-137, `db-apply` now runs a read-only check (`ONE_SHOT_STOPS`, reviewed code, not data). If any row KI-137 relabels has a label other than its corrected one, or a Powder Keg family still has the old rate unit, it stops before writing anything. The message names the fix: apply the file to that same database in one transaction, then run again. The older one-shots behave as before. Live doesn't use this: the release applies KI-137's SQL for real.
- **Restamped one-shot.** The PR check refused a restamp of a staging-only one-shot when its list entry moved with the file. An entry may now leave the list when this PR restamps that file into a new name the list holds.

Taha's call (2026-11-19): a loud stop, no automatic run.
