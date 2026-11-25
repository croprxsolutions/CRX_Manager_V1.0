-- predicate: audit-log-completeness
-- Money-mutating SECURITY DEFINER RPCs that never write an audit row.
-- Catalog-based (pg_proc.prosrc scan) and strictly read-only.
--
-- INVARIANT
--   Every SECDEF function that MUTATES a money ledger must INSERT a row into
--   financial_audit_log (or activity_feed) in the same body. financial_audit_log
--   is the append-only ledger the AR/AP reconstructions in the fin-* predicates
--   read from (see fin-invoice-balance-identity's legacy_payment_ledger CTE), and
--   it is the only durable record of WHO moved money and WHY. A money RPC that
--   mutates without logging is invisible to those reconstructions and to any
--   forensic replay — the drift it causes cannot even be attributed after the fact.
--
-- POPULATION (money mutation, verified live 2026-08-07 = 39 functions)
--   public SECDEF non-trigger functions whose body contains a real write statement
--   (INSERT INTO / UPDATE) against one of:
--     payments, vendor_payments, write_offs, prepay_applications, prepay_credits,
--     credit_memo_applications, commission_payments, commissions,
--     invoice_line_allocations, allocation_sets, vendor_bills
--   OR an UPDATE ... SET on one of the invoices cached-money columns
--     (paid_amount_cents, prepay_applied_cents, write_off_cents,
--      credit_applied_cents, total_amount_cents).
--   This covers the invoice post/void, payment, commission, credit-memo, prepay,
--   write-off and AP paths. The [^;]* span on the invoices branch stops at the
--   first statement terminator, so the SET column must belong to that same UPDATE.
--
-- VIOLATION
--   A population member whose body has NO `INSERT INTO financial_audit_log` and
--   NO `INSERT INTO activity_feed`. A mere textual reference to the table (e.g.
--   reading it, or naming it in a comment) does NOT count as logging — the sink
--   must actually be written.
--
-- WOULD HAVE CAUGHT
--   The "silent money mutation" class: a new post/void/apply RPC shipped with its
--   money write but without its audit write. That RPC's effects then never appear
--   in financial_audit_log, so fin-invoice-balance-identity's legacy-payment
--   reconstruction under-counts and reports a false paid_amount_drift on real
--   invoices — the audit gap manifests as a phantom money bug elsewhere.
--
-- EXPECTED RESULT
--   Zero rows. Verified live 2026-08-07 against rhyzpcqhnizqbxphqdkr:
--   39 money-mutating SECDEF functions in population, 0 unlogged.
--
-- KNOWN FALSE-POSITIVE MODES
--   * A thin wrapper that delegates the whole mutation to an `_impl` function
--     which does the logging can flag if the wrapper itself also touches a money
--     table. Verify with pg_get_functiondef that the delegate logs, then allowlist
--     with the delegate named in the justification.
--   * A read-mostly reporting function that happens to UPDATE a cache column.
--     Verify it moves no customer money before allowlisting.
--   NEVER allowlist a function that genuinely moves money without logging — add
--   the audit INSERT instead.
--
-- ACTOR CONTRACT ROW (financial_audit_log:actor-contract)
--   The audit row is only useful if it records WHO. Function hashes do not cover
--   the column default or trigger attachment, so this also flags one row unless
--   financial_audit_log.actor_user_id is uuid NOT NULL DEFAULT auth.uid() (not
--   generated/identity) AND trg_fill_audit_actor is attached to that table as an
--   enabled (origin or always) BEFORE INSERT FOR EACH ROW trigger (tgtype 7, no
--   WHEN clause, no arguments) calling public._fill_audit_actor(). No other
--   user-defined INSERT trigger or rewrite rule may intercept audit rows.
--   Verified live on production and staging 2026-11-24. Never allowlist this row.

WITH money_tables AS (
  SELECT '(payments|vendor_payments|write_offs|prepay_applications|prepay_credits'
      || '|credit_memo_applications|commission_payments|commissions'
      || '|invoice_line_allocations|allocation_sets|vendor_bills)' AS t
),
fns AS (
  SELECT p.proname,
         pg_get_function_identity_arguments(p.oid) AS args,
         p.prosrc
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosecdef
    AND p.prokind = 'f'
    AND p.prorettype <> 'pg_catalog.trigger'::regtype
),
money_mutators AS (
  SELECT f.proname, f.args, f.prosrc
  FROM fns f
  CROSS JOIN money_tables m
  WHERE f.prosrc ~* ('\m(insert\s+into|update)\s+(public\.)?' || m.t || '\M')
     OR f.prosrc ~* ('update\s+(public\.)?invoices\M[^;]*\mset\M[^;]*'
                     || '(paid_amount_cents|prepay_applied_cents|write_off_cents'
                     || '|credit_applied_cents|total_amount_cents)')
)
SELECT proname || '(' || args || ')' AS violation_key,
       'money-mutating SECDEF function writes no financial_audit_log / activity_feed row'::text
         AS reason
FROM money_mutators
WHERE prosrc !~* '\minsert\s+into\s+(public\.)?(financial_audit_log|activity_feed)\M'

UNION ALL

SELECT 'financial_audit_log:actor-contract' AS violation_key,
       'financial_audit_log must keep its signed-in actor default and its sole user-defined INSERT trigger, with no rewrite rules'::text
         AS reason
WHERE NOT EXISTS (
        SELECT 1
        FROM pg_attribute a
        JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = to_regclass('public.financial_audit_log')
          AND a.attname = 'actor_user_id'
          AND NOT a.attisdropped
          AND a.atttypid = 'uuid'::regtype
          AND a.attnotnull
          AND a.attgenerated = ''
          AND a.attidentity = ''
          -- Deparsing may omit the schema when auth is on search_path. The
          -- catalog dependency still has to resolve to the real auth.uid().
          AND pg_get_expr(d.adbin, d.adrelid) IN ('auth.uid()', 'uid()')
          AND EXISTS (
                SELECT 1
                FROM pg_depend dep
                WHERE dep.classid = 'pg_attrdef'::regclass
                  AND dep.objid = d.oid
                  AND dep.refclassid = 'pg_proc'::regclass
                  AND dep.refobjid = to_regprocedure('auth.uid()')
              )
      )
   OR NOT EXISTS (
        SELECT 1
        FROM pg_trigger t
        WHERE t.tgrelid = to_regclass('public.financial_audit_log')
          AND t.tgname = 'trg_fill_audit_actor'
          AND NOT t.tgisinternal
          AND t.tgfoid = to_regprocedure('public._fill_audit_actor()')
          AND t.tgenabled IN ('O', 'A')
          AND t.tgtype = 7  -- ROW(1) | BEFORE(2) | INSERT(4)
          AND t.tgqual IS NULL
          AND t.tgnargs = 0
      )
   OR EXISTS (
        SELECT 1
        FROM pg_trigger t
        WHERE t.tgrelid = to_regclass('public.financial_audit_log')
          AND NOT t.tgisinternal
          AND t.tgname <> 'trg_fill_audit_actor'
          AND (t.tgtype & 4) = 4  -- INSERT
      )
   OR EXISTS (
        SELECT 1
        FROM pg_rewrite r
        WHERE r.ev_class = to_regclass('public.financial_audit_log')
      )
ORDER BY violation_key;
