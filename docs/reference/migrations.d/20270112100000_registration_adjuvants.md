**LOCAL CANDIDATE — NOT APPLIED.** USE-2 part 1 (`docs/plans/2026-11-15-product-USE2-BUILD-SHEET.md` sections 3.0 and 4.0): `20270112100000_registration_adjuvants.sql` (SQL sha256: `2a07b17fd396a7e5fd893c3a62964266b9ca4f44a64e3eb53a90773f4879d49d`). Re-issues `_epa_label_adjuvants_valid` (the `epa_registrations.label_adjuvants` CHECK) with the new entry shape: each entry is one label statement, `{kind: required|recommended|do_not_use, adjuvant_types: 1-8 distinct trimmed types (any one of / none of), preferred?: one of its types (not on do_not_use), when?: condition up to 200 characters, note?: up to 500}`, at most 50 entries; NULL = not reviewed, `[]` = none on the label. REG-1's one-type shape had no rows (the preflight refuses if any list was filled). Adds `set_registration_adjuvants` (active admins and sales reps; retry key, reason, stale version check; changes only `label_adjuvants`, or creates a registration holding only the list with RUP 'unknown' when none exists; one `epa_registration_events` row). No live row is written; the postflight proves fourteen REG-1, DM-4 and PAR-1 functions unchanged and the registration and event counts unchanged.

Proof: `node scripts/smoke/prove-registration-adjuvants-real-schema.mjs` (disposable real-schema database; prints `REGISTRATION_ADJUVANTS_PROOF_PASS`; cases M0, M1, 1-6 and R, the rollback below).

Rollback (its own reviewed migration, after the screen PR is reverted so no screen calls the dropped save). The new validator is kept, so every list already entered stays valid and readable; nothing is deleted. Never CASCADE.

```sql
SET LOCAL lock_timeout = '5s';
DO $rb$
DECLARE v_caller text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_caller
  FROM pg_proc p
  WHERE p.prosrc ~ 'set_registration_adjuvants' AND p.oid <> 'public.set_registration_adjuvants(text,bigint,jsonb,text,text)'::regprocedure;
  IF v_caller IS NOT NULL THEN
    RAISE EXCEPTION 'USE2_ROLLBACK_REFUSED: still called by %', v_caller;
  END IF;
END
$rb$;
REVOKE ALL ON FUNCTION public.set_registration_adjuvants(text, bigint, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
DROP FUNCTION public.set_registration_adjuvants(text, bigint, jsonb, text, text);
```
