**APPLIED LIVE.** Read-only ledger verification on 2026-11-13 found version `20261112230412`, name `20270108100000_ingredient_modes_of_action`. MOA-1 part 1 (`docs/plans/2026-11-12-product-MOA1-BUILD-SHEET.md` sections 3 and 4): `20270108100000_ingredient_modes_of_action.sql` (SQL sha256: `2fa8044bc4e0b5004bb37ced44d824c59c0696bc8a7b83930c1de062841de107`). New table `active_ingredient_modes_of_action` (one reviewed resistance group per ingredient, scheme and code; owner postgres, RLS on, active profiles read active rows, admins read all, no write grant), the admin writer `set_active_ingredient_modes` (retry key, lock first, stale check, one ingredient event per change), the reads `get_parent_mode_groups` (any active profile) and `get_ingredient_mode_users` (admin), and four private helpers including `_parent_mode_groups`. Group codes are 1-10 letters or digits (upper-cased; spaces, tabs and line breaks trimmed) and sort naturally (letter prefix, then number: 5 < 27, M3 < M10). Groups are worked out when read; a salt or ester with no list shows its acid's; a typed product group that disagrees stays live and is flagged. Nothing existing is changed; the postflight proves fifteen DM-1/DM-1b/DM-4 functions and the typed-group and ingredient rows unchanged.

Proof: `node scripts/smoke/prove-ingredient-modes-of-action-real-schema.mjs` (disposable real-schema database; prints `INGREDIENT_MODES_OF_ACTION_PROOF_PASS`; cases M1, 1-12 and R, the rollback below).

Rollback (its own reviewed migration, after the screen PR is reverted so no screen calls a dropped function). The table is kept, unreadable, as history; the ingredient events MOA-1 wrote stay (append-only). Never CASCADE. Postgres records no dependency between plpgsql or quoted-body SQL functions, so a plain DROP would not notice a later caller (CMP-2's filter): the first block refuses if any other function's source names one of the seven.

Known and accepted: retired groups and their notes stay readable to every active profile through `active_ingredient_events` (the sheet's chosen history; the groups are public HRAC/FRAC/IRAC reference data). An ingredient-list edit does not bump any parent's `chemistry_version` (groups are worked out when read), so a screen must not use that number as the cache key for groups. Deferred to CMP-2: retiring an ingredient leaves its active group rows, which still count (a salt naming a retired acid keeps showing the acid's groups).

```sql
SET LOCAL lock_timeout = '5s';
DO $rb$
DECLARE v_caller text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_caller
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prosrc ~ '(_parent_mode_groups|_ingredient_mode_list|_ingredient_mode_reach|_ingredient_modes_input|set_active_ingredient_modes|get_parent_mode_groups|get_ingredient_mode_users)'
    AND NOT (n.nspname = 'public' AND p.proname IN ('_parent_mode_groups', '_ingredient_mode_list', '_ingredient_mode_reach',
      '_ingredient_modes_input', 'set_active_ingredient_modes', 'get_parent_mode_groups', 'get_ingredient_mode_users'));
  IF v_caller IS NOT NULL THEN
    RAISE EXCEPTION 'MOA1_ROLLBACK_REFUSED: still called by %', v_caller;
  END IF;
END
$rb$;
REVOKE ALL ON FUNCTION public.set_active_ingredient_modes(uuid, jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public.get_parent_mode_groups(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
REVOKE ALL ON FUNCTION public.get_ingredient_mode_users(uuid) FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
DROP FUNCTION public.set_active_ingredient_modes(uuid, jsonb, jsonb, text, text);
DROP FUNCTION public.get_parent_mode_groups(uuid);
DROP FUNCTION public.get_ingredient_mode_users(uuid);
DROP FUNCTION public._parent_mode_groups(uuid);
DROP FUNCTION public._ingredient_mode_reach(uuid);
DROP FUNCTION public._ingredient_modes_input(jsonb, text);
DROP FUNCTION public._ingredient_mode_list(uuid);
REVOKE ALL ON TABLE public.active_ingredient_modes_of_action FROM PUBLIC, anon, authenticated, service_role, metabase_ro;
```
