-- predicate: quote-price-lock-boundary
-- From the 2026-11-01 review of PR #1234. Three facts the sent-quote price lock rests on, none
-- watched by another sweep:
--   * _assert_quote_prices_as_sent decides whether a quote may become an order at its current
--     prices. It keeps its shape (invoker rights, no API role can call it, one overload, the
--     reviewed body), and all four callers still call it. Losing a caller gives no error anywhere.
--   * public.quote_price_changes is the trail that check trusts, so the browser may only read it:
--     RLS on, no write privilege or policy, the reviewed read condition, and only the save
--     implementation and the check name the table.
--   * Only definer-rights code writes quotes.expires_at (20261101100000). The save implementation's
--     own handling of it is pinned by its digest in allowlist.json.
--
-- A second predicate on the same theme stays separate: quote-versions-rpc-owned guards the version
-- snapshots; this one guards what is checked against them.
--
-- SCOPE: browser roles. service_role keeps its access, as on every table.
-- Contract: EXPECT ZERO rows. Exact-name, so a hit is a real regression: do not allowlist it. An
-- intended change to the check updates the body digest here in the same change.

SELECT 'quote_price_changes:rls-off' AS violation_key,
       'public.quote_price_changes must have row level security on, or missing' AS reason
 WHERE to_regclass('public.quote_price_changes') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_class c
                    WHERE c.oid = to_regclass('public.quote_price_changes') AND c.relrowsecurity)

UNION ALL

-- has_table_privilege sees only the table-level ACL, so columns are checked too. anon has no read.
SELECT 'quote_price_changes:browser-write-privilege' AS violation_key,
       'anon/authenticated must not hold INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER or REFERENCES on public.quote_price_changes, at table or column level, and anon must not read it' AS reason
 WHERE has_table_privilege('authenticated', 'public.quote_price_changes', 'INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES')
    OR has_table_privilege('anon', 'public.quote_price_changes', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES')
    OR has_any_column_privilege('authenticated', 'public.quote_price_changes', 'INSERT, UPDATE, REFERENCES')
    OR has_any_column_privilege('anon', 'public.quote_price_changes', 'SELECT, INSERT, UPDATE, REFERENCES')

UNION ALL

SELECT 'quote_price_changes:external-mutation-policy' AS violation_key,
       'public.quote_price_changes must have no INSERT, UPDATE, DELETE or FOR ALL policy' AS reason
 WHERE EXISTS (SELECT 1 FROM pg_policy p
                WHERE p.polrelid = 'public.quote_price_changes'::regclass
                  AND p.polcmd <> 'r')

UNION ALL

-- The read must survive, and must stay office-only: the same digest guards quote_versions.
SELECT 'quote_price_changes:read-path-regressed' AS violation_key,
       'authenticated lost its read of public.quote_price_changes, or quote_price_changes_select changed its row condition; an intended change must update the digest here (expected 466a3791a1874c9cba20ac690f330c7b)' AS reason
 WHERE NOT has_table_privilege('authenticated', 'public.quote_price_changes', 'SELECT')
    OR NOT EXISTS (
      SELECT 1 FROM pg_policy p
       WHERE p.polrelid = 'public.quote_price_changes'::regclass
         AND p.polname = 'quote_price_changes_select'
         AND p.polcmd = 'r'
         AND md5(pg_get_expr(p.polqual, p.polrelid)) = '466a3791a1874c9cba20ac690f330c7b'
    )
    OR (SELECT count(*) FROM pg_policy p
         WHERE p.polrelid = 'public.quote_price_changes'::regclass) <> 1

UNION ALL

-- Any routine outside the two reviewed ones that names the table, in any non-system schema. A name
-- match rather than a write match, so dynamic SQL is seen too; a new reader is added here on purpose.
SELECT 'quote_price_changes:foreign-reference:' || p.oid::regprocedure::text AS violation_key,
       'only _save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text) and _assert_quote_prices_as_sent(uuid) may name public.quote_price_changes' AS reason
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
   AND p.prosrc ILIKE '%quote_price_changes%'
   AND p.oid NOT IN (
     COALESCE(to_regprocedure('public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)')::oid, 0),
     COALESCE(to_regprocedure('public._assert_quote_prices_as_sent(uuid)')::oid, 0))

UNION ALL

SELECT '_assert_quote_prices_as_sent:overload-count' AS violation_key,
       'public._assert_quote_prices_as_sent must have exactly one overload; a new signature is born callable by the API roles' AS reason
 WHERE (SELECT count(*) FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname = '_assert_quote_prices_as_sent') <> 1

UNION ALL

SELECT '_assert_quote_prices_as_sent:shape' AS violation_key,
       'public._assert_quote_prices_as_sent(uuid) must exist, run with invoker rights, and pin search_path to public, pg_temp' AS reason
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('public._assert_quote_prices_as_sent(uuid)')
      AND NOT p.prosecdef
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[]
 )

UNION ALL

SELECT '_assert_quote_prices_as_sent:external-execute' AS violation_key,
       'anon/authenticated/service_role/PUBLIC must not hold EXECUTE on public._assert_quote_prices_as_sent(uuid); it runs only inside the definer-rights quote functions' AS reason
  FROM pg_proc p
 WHERE p.oid = to_regprocedure('public._assert_quote_prices_as_sent(uuid)')
   AND EXISTS (
     SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
      WHERE a.privilege_type = 'EXECUTE'
        AND a.grantee <> p.proowner
   )

UNION ALL

SELECT '_assert_quote_prices_as_sent:body-pinned' AS violation_key,
       'public._assert_quote_prices_as_sent(uuid) changed from its reviewed body; re-review it, then update the digest here (observed '
         || coalesce((SELECT length(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))::text || '/' || md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g')))
                        FROM pg_proc p
                       WHERE p.oid = to_regprocedure('public._assert_quote_prices_as_sent(uuid)')), 'signature unresolvable')
         || ')' AS reason
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure('public._assert_quote_prices_as_sent(uuid)')
      AND md5(btrim(regexp_replace(p.prosrc, '\s+', ' ', 'g'))) = 'c810034b0c786cd27b81c1b197d8eb14'
 )

UNION ALL

-- The four gates. Each must still call the check; both comment forms are removed so a commented-out
-- call does not count.
SELECT '_assert_quote_prices_as_sent:caller-lost:' || gate.sig AS violation_key,
       'this quote function no longer calls _assert_quote_prices_as_sent, so a changed price reaches an order, a draw or a job unchecked' AS reason
  FROM (VALUES
    ('public._save_quote_below_cost_impl_20260810(uuid,jsonb,jsonb,uuid,text)'),
    ('public._convert_quote_to_order_below_cost_impl_20260810(uuid,uuid,text,bigint)'),
    ('public._draw_down_quote_intent_impl_20260819(uuid,jsonb,uuid,text,text)'),
    ('public.create_job_from_quote_section(uuid,uuid,uuid,text)')
  ) AS gate(sig)
 WHERE NOT EXISTS (
   SELECT 1 FROM pg_proc p
    WHERE p.oid = to_regprocedure(gate.sig)
      AND regexp_replace(regexp_replace(p.prosrc, '/\*.*?\*/', '', 'g'), '--[^\n]*', '', 'g') ~ 'PERFORM\s+public\._assert_quote_prices_as_sent\s*\('
 )

UNION ALL

SELECT 'quotes.expires_at:browser-write-privilege' AS violation_key,
       'anon/authenticated must not hold INSERT or UPDATE on public.quotes.expires_at; only definer-rights code writes it' AS reason
 WHERE has_column_privilege('authenticated', 'public.quotes', 'expires_at', 'INSERT, UPDATE')
    OR has_column_privilege('anon', 'public.quotes', 'expires_at', 'INSERT, UPDATE')
