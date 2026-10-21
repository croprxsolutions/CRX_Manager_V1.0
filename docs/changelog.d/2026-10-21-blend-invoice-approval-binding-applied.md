## 2026-10-21 — blend-ticket invoice approval binding is live

`20261021070000_blend_invoice_approval_binding` (PR #995) was applied live at 20:41:00 UTC
(3:41 PM Central; ledger version `20261021204100`) through `scripts/apply-migration-file.mjs`,
before PR #995 merged as `a254cbfcf`. Live read-back: one overload
`create_invoice_from_blend_ticket(uuid,uuid,text,text,jsonb)`, body md5 matching the migration's
postflight pin, SECURITY DEFINER with `search_path=public, pg_temp`, authenticated may execute and
anon may not.

Docs: migration-history row 961 marked APPLIED LIVE with a fresh ledger capture (1043 rows);
`docs/manual/CURRENT_STATE.md` and `docs/manual/KNOWN_ISSUES.md` re-stamped from the same read.

`.claude/schema-registry.json` regenerated from live introspection (2026-10-21 ~20:50 UTC, all six queries):
high-water `20261021204100`, the four 2026-10-20/21 migrations added to the applied names, and
`below_cost_approvals.operation` now lists `create_invoice_from_blend_ticket` (added live by
`20261020210000`). Section counts are unchanged (38 status lists, 120 parsed checks).
