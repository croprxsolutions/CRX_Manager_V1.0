## 2026-11-23 - v0.1.0 migration records stamped APPLIED LIVE

- The 37 release v0.1.0 (#1990) migration records in `docs/reference/migrations.d/` still said `LOCAL CANDIDATE — NOT APPLIED`. Each now starts `APPLIED LIVE <UTC> (<Central>)`, ledger version and name, as the README asks; the rest of each record is unchanged.
- Evidence: read-only queries of the live migration ledger on 2026-11-23 (Taha's OK): 1,244 rows, newest `20261121061349` `20270129190000_blend_invoice_release_fixes`; all 37 names present, versions `20261121055309` to `20261121061349`.
- `CURRENT_STATE.md` and `KNOWN_ISSUES.md` "Last verified" move to 2026-11-23 for the live ledger only.
- Needed before v0.2.0, whose release gates read these records. Back-merge main → staging after this lands.
