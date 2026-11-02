-- predicate: cost exposure review is current
--
-- Cost, profit and margin are admin-only (Mason, 2026-10-15). The column lock (20261022101000) keeps
-- the browser roles off the cost columns, but a SECURITY DEFINER function runs as its owner, so column
-- grants and RLS cannot limit what it returns. Each such function must gate itself, and only a human
-- (or reviewer agent) reading the body can confirm that. The KI-02 audit
-- (docs/audits/2026-11-02-cost-margin-definer-function-audit.md) read every one live.
--
-- This predicate lists every function `authenticated` can execute that, itself or through any helper it
-- calls (followed to the end of the chain, SECURITY DEFINER or not: an invoker helper called from a
-- definer runs with the owner's rights), names a cost/profit/margin field or serializes a whole row while
-- reading a cost-bearing table. The violation_key is the signature plus a 12-character md5 of the live
-- identity, owner, settings and source of the function and of EVERY function it reaches. An allowlist
-- entry therefore approves ONE reviewed call chain: a later CREATE OR REPLACE of the function or of any
-- helper it reaches (including a pass-through helper that drops a gate) changes the key and the function is flagged again until
-- someone re-reads it and refreshes its entry.
--
-- shortcut: calls are matched by name in the source text, so a helper reached only through dynamic SQL
--   is missed, and a whole row nested in jsonb_build_object is caught only under a one-letter alias;
--   only public-schema functions are followed (every cost table lives in public); upgrade to a
--   parser-based call graph if that ever hides a leak.
--
-- Rows returned = violations (expected ZERO after the allowlist).

WITH RECURSIVE fn AS (
  SELECT p.oid, p.proname, p.prosecdef, p.prosrc, p.proconfig, p.proowner,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
         p.prosrc ~* '(current_cost|total_cost|total_profit|margin|cost_cents|cost_per_unit|order_profit|cogs|\mprofit\M|snapshot_data|unit_cost|cost_at_)'
         -- a whole-row to_jsonb/row_to_json carries cost without naming it (get_dispatch_board_jobs, 2026-11-02)
         -- (also when the bare row or alias is aggregated or nested in an object: jsonb_agg(j), jsonb_build_object('job', j))
         OR ((p.prosrc ~* '(to_jsonb|row_to_json|to_json)\s*\(\s*[a-z_][a-z0-9_]*\s*\)'
              OR p.prosrc ~* '\m(jsonb?_agg|json_agg|array_agg)\s*\(\s*[a-z_][a-z0-9_]*\s*(\)|order\M)'
              OR p.prosrc ~* '\mjsonb?_build_object\s*\([^;]*?,\s*[a-z]\s*[,)]')
             AND p.prosrc ~* '\m(products|quotes|quote_items|quote_versions|orders|order_items|invoices|invoice_items|jobs|job_chemicals|blend_ticket_products|commissions|purchase_orders|purchase_order_items|application_services)\M') AS names_cost
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prokind = 'f'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d
                    WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')
),
edge AS (
  SELECT DISTINCT a.oid AS caller, b.oid AS callee
  FROM fn a JOIN fn b ON b.oid <> a.oid
   AND position(b.proname IN a.prosrc) > 0
   AND a.prosrc ~* ('\m' || b.proname || '\s*\(')
),
-- (root, node) pairs; UNION de-duplicates, so call cycles terminate.
reach (root, node) AS (
  SELECT f.oid, f.oid FROM fn f WHERE f.auth_exec
  UNION
  SELECT r.root, e.callee FROM reach r JOIN edge e ON e.caller = r.node
),
chain AS (
  SELECT r.root,
         bool_or(n.names_cost) AS names_cost,
         bool_or(n.prosecdef AND n.oid <> r.root) AS reaches_definer,
         -- each reached function's identity, owner, owner-rights flag and settings travel with its body, so swapping
         -- bodies between helpers, changing an owner or changing a search_path also changes the key. Each function is
         -- hashed on its own first, so a migration's post-apply keys can be computed before it is applied.
         md5(string_agg(md5(n.oid::regprocedure::text || '|' || n.proowner::regrole::text || '|' || n.prosecdef::text || '|'
                            || coalesce(array_to_string(n.proconfig, ','), '') || '|' || n.prosrc),
                        '' ORDER BY n.oid::regprocedure::text)) AS body_md5
  FROM reach r JOIN fn n ON n.oid = r.node
  GROUP BY r.root
)
SELECT format('%s(%s)#%s', f.proname, pg_get_function_identity_arguments(f.oid), left(c.body_md5, 12)) AS violation_key,
       f.prosecdef AS security_definer
FROM chain c JOIN fn f ON f.oid = c.root
WHERE c.names_cost AND (f.prosecdef OR c.reaches_definer)
ORDER BY 1;
