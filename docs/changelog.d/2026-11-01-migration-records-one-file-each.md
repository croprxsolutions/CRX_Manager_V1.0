## 2026-11-01 - Migration records move to one file each so the history file stops blocking merges

- **What changed:** each new migration now keeps its record, from candidate through applied, in its own file under `docs/reference/migrations.d/`. `docs/reference/migration-history.md` is frozen: older rows stay where they are, and new rows or live captures there fail `check:docs`.
- **Why:** every migration PR edited neighbouring rows in one file. GitHub reported conflicts that the local `merge=union` setting hid, and that setting then kept both versions of a row, which failed the doc-drift check. PR 1228 was blocked this way repeatedly on 2026-10-31 and 2026-11-01.
- **Gates:** `.claude/hooks/migration-records-lib.mjs` turns each record into one ordinary row and joins it to the frozen text, so the parked-migration parsers are unchanged. The doc-drift check, SessionStart report, `/fleet`, RPC contract tests and guard tests all read the combined view, and the apply-review packet copies the records. A misnamed, empty or unreadable record fails closed.
- **Still enforced:** exactly one record per migration since 2026-09-15, now also across both locations, plus a new check that a record matches a real migration file.
- **Records are strict:** each must start with a recognised status, name its own `.sql` file in its first paragraph, and match a migration file by name in both directions.
- **Parked report repaired:** the 1.4 MB history file had outgrown the 1 MB limit on `git show` output, so the "what is parked on main?" read failed and every report fell back to UNKNOWN. That read now uses the existing batch reader.
- **`.gitattributes`:** `merge=union` is removed for the frozen file. It stays for `DECISION_LOG.md`.
