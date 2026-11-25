#!/usr/bin/env node
// Taha lane block (taha-lane-lib.mjs, Mason 2026-11-22): which files count, the
// no end date, Taha's Approve on the head, the one-PR override by code, and the real prompt hook end to end.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";
import {
  findTahaLaneOverride, isTahaLanePath, isTahaLaneSql, prFilesOnGitHub, issueTahaLaneCode, recordTahaLaneOverride,
  tahaApprovedHead, tahaApprovedOnGitHub, tahaLaneGate, tahaLaneProblem, tahaOverrideAttempt, tahaOverrideCommand, tellTahaOnGitHub,
} from "./taha-lane-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (v, m) => { assert.ok(v, m); pass++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++; };
const NOW = Date.UTC(2026, 10, 23, 15, 0, 0);
const f = (...names) => names.map((filename) => ({ filename, status: "modified" }));

// ── which files are Taha's ──────────────────────────────────────────────────
for (const p of [
  "src/pages/QuoteBuilder.tsx", "src/components/quotes/Line.tsx", "src/pages/Invoices.tsx", "src/pages/PaymentHistory.tsx",
  "src/pages/MonthEndClose.tsx", "src/lib/createInventoryHoldIntentBinding.test.ts", "src/pages/Prepay.tsx",
  "supabase/migrations/20270216110000_purchasing_plan_booking_reservations.sql",
  "supabase/migrations/20270224120000_month_close_payments_received_recheck.sql", "src/lib/billingFeatures.ts",
  "src/pages/CommissionPayments.tsx", "src/lib/creditLimit.ts",
  // Codex P1/P2 on #2303: bill splits are billing; data "fields" are not field billing.
  "src/pages/OrderDetail.tsx", "src/pages/OrderDetail.billing.test.tsx", "src/lib/billSplitLock.ts","src/components/orders/LineBillSplit.tsx", "src/lib/invoiceRowPdfFields.ts",
  "supabase/migrations/20270129180000_ki81_quote_line_sent_field.sql", "supabase/migrations/20260702131000_a3_save_quote_restore_dropped_fields.sql",
  // Taha's review of #2303: the chemical-side screens he named (Mason chose this list, not refuse-by-default).
  "src/pages/ARaging.tsx", "src/lib/arAging.ts", "src/lib/reconciliation.ts", "src/pages/Reports.tsx", "src/pages/SalesReports.tsx",
  "src/pages/FinancialDashboard.tsx", "src/components/reports/X.tsx", "src/pages/NewOrder.tsx", "src/pages/Orders.tsx",
  "src/components/orders/SaleMoneySummary.tsx", "src/components/orders/WhoPaysCard.tsx", "src/pages/CustomerDetail.tsx",
  "src/pages/CustomerTransactionReview.tsx", "supabase/migrations/20270101000000_any_rep_changes_booked_prices.sql",
  "supabase/migrations/20260301200001_prepay_application_rpcs.sql", "supabase/migrations/20260702182000_layer2_release_hold_reject_job.sql",
  "supabase/migrations/20260702172500_layer2_convert_quote_to_order_job_aware.sql",
  // Taha's review of #2303: the block's own wiring needs Mason's code too.
  ".claude/hooks/taha-lane-lib.mjs", ".claude/hooks/taha-lane-prompt.mjs", ".claude/hooks/pr-merge-guard.mjs",
  ".claude/hooks/prompt-router.mjs", ".codex/hooks/production-action-guard.mjs", ".claude/settings.json", ".codex/hooks.json",
  ".claude/hooks/sol-risk-lib.mjs", // holds GATED_MERGE_BASES; dropping staging there would turn the block off
]) ok(isTahaLanePath(p), `${p} is Taha's`);
for (const p of [
  "src/pages/FieldApplicationInvoice.tsx", "src/components/field-invoices/Row.tsx", "src/pages/FieldInvoices.tsx",
  "supabase/migrations/20270224110000_retire_per_acre_field_pricing.sql", "src/pages/JobDetail.tsx", "src/pages/BlendTickets.tsx",
  "src/pages/Deliveries.tsx", "src/pages/InventoryPage.tsx", "src/lib/threshold.ts", "docs/workflows/QUOTE_TO_DELIVERY.md",
  "scripts/quote-report.mjs", ".claude/hooks/codex-push-lib.mjs", ".claude/hooks/pr-merge-guard.test.mjs",
  "src/lib/fieldAppNewInvoiceAddress.ts", "src/pages/FieldStop.billing.test.tsx", "src/pages/FieldAppSplitInvoiceEditor.tsx",
  "src/components/field-invoices/UnbilledApplicationsPanel.tsx", "src/pages/VendorBillDetail.tsx",
  "supabase/migrations/20261022021000_order_invoice_refuses_field_split.sql",
]) ok(!isTahaLanePath(p), `${p} is not Taha's`);

// ── the problem ─────────────────────────────────────────────────────────────
eq(tahaLaneProblem({ files: f("src/pages/Deliveries.tsx"), now: NOW }), null, "no lane file → no problem");
ok(tahaLaneProblem({ files: f("src/pages/Quotes.tsx"), now: NOW })?.reason.includes("Quotes.tsx"), "a lane file is named");
ok(tahaLaneProblem({ files: [{ filename: "src/x.ts", previous_filename: "src/pages/Quotes.tsx", status: "renamed" }], now: NOW }), "a file moved out of the lane still counts");
ok(tahaLaneProblem({ files: null, now: NOW }), "unreadable files refuse");
eq(tahaLaneProblem({ files: [], now: NOW }), null, "a PR with no files changes nothing of Taha's");
ok(tahaLaneProblem({ files: f(...Array.from({ length: 250 }, (_, i) => `docs/n${i}.md`)), now: NOW }), "a 250-file list may be cut short: refuse");

// ── reading the PR's files from GitHub ──────────────────────────────────────
const tsv = "modified\tsrc/pages/Quotes.tsx\t\nrenamed\tsrc/x.ts\tsrc/pages/Invoices.tsx\n";
eq(prFilesOnGitHub({ repo: undefined, number: 7, gh: () => tsv }),
  [{ filename: "src/pages/Quotes.tsx", previous_filename: undefined }, { filename: "src/x.ts", previous_filename: "src/pages/Invoices.tsx" }], "rows are read");
eq(prFilesOnGitHub({ repo: undefined, number: 7, gh: () => "" }), [], "no rows is no files");
eq(prFilesOnGitHub({ repo: undefined, number: 7, gh: () => { throw new Error("offline"); } }), null, "GitHub down → unreadable");
eq(prFilesOnGitHub({ repo: undefined, number: 7, gh: () => "{\"not\":\"tsv\"}" }), null, "a strange answer → unreadable");
eq(prFilesOnGitHub({ repo: undefined, number: NaN, gh: () => tsv }), null, "no PR number → unreadable");

// ── a migration is judged by its SQL, not only its name (Taha, 2026-11-23: #2331, #2338) ──
for (const [sql, why] of [
  ["ALTER TABLE public.order_items ADD CONSTRAINT q CHECK (quantity > 0);", "#2331: a check on order lines"],
  ["CREATE OR REPLACE FUNCTION public._complete_delivery_impl() AS $$ BEGIN INSERT INTO invoices (id) VALUES (1); END $$;", "#2338: a delivery step that writes invoices"],
  ['UPDATE "public"."payments" SET x = 1;', "a quoted update"],
  ["DELETE FROM ONLY prepay_credits WHERE id = 1;", "a delete"],
  ["LOCK TABLE public.quotes IN SHARE MODE;", "a table lock"],
  ["TRUNCATE commissions;", "a truncate"],
  ["CREATE TRIGGER t BEFORE UPDATE ON public.inventory_holds FOR EACH ROW EXECUTE FUNCTION f();", "a trigger on holds"],
  ["CREATE POLICY p ON quote_items FOR SELECT USING (true);", "a policy"],
  ["GRANT SELECT ON TABLE public.invoice_items TO authenticated;", "a grant"],
  ["SELECT id FROM public.invoices WHERE id = 1 FOR UPDATE;", "a row lock on invoices"],
  ["CREATE FUNCTION public.post_invoice_v2() RETURNS void AS $$ SELECT 1 $$;", "a function named for invoices"],
  ["DROP FUNCTION IF EXISTS public.release_hold(uuid);", "dropping a hold function"],
  [null, "SQL that could not be read"],
  // Luna round 1 (2026-11-23).
  ["SELECT '--' AS note; UPDATE public.invoices SET x = 1;", "a -- inside a string is not a comment"],
  ["SELECT '/*' AS a; UPDATE invoices SET x = 1; SELECT '*/';", "a /* inside a string is not a comment"],
  ["SELECT E'it\\'s -- here'; DELETE FROM payments;", "an escaped quote in an E'' string"],
  ["/* outer /* inner */ still a comment */ UPDATE orders SET x = 1;", "nested block comments end in the right place"],
  ["COPY public.invoices FROM STDIN;", "COPY into a lane table"],
  ["CREATE TABLE IF NOT EXISTS public.invoice_items (id int);", "CREATE TABLE of a lane table"],
  ["SELECT * INTO quotes FROM other;", "SELECT INTO a lane table"],
  ["DO $$ BEGIN EXECUTE 'UPDATE invoices SET x = 1'; END $$;", "dynamic SQL in a string"],
  // Luna round 2 (2026-11-23).
  ['SELECT 1 AS "x--y"; UPDATE public.invoices SET status = \'x\';', "a -- inside a quoted identifier is not a comment"],
  ["DO $$ BEGIN EXECUTE 'UPDATE ' || 'invoices SET status = ''x'''; END $$;", "dynamic SQL built from pieces"],
  ["ALTER TABLE public.bookings ADD COLUMN source text;", "a bookings table"],
]) ok(isTahaLaneSql(sql), `Taha's: ${why}`);
for (const [sql, why] of [
  ["UPDATE deliveries SET driver_id = NULL; INSERT INTO activity_feed (x) VALUES (1);", "deliveries only"],
  ["SELECT count(*) FROM invoices i JOIN orders o ON o.id = i.order_id;", "reading invoices"],
  ["-- UPDATE invoices SET x = 1\n/* INSERT INTO payments */ SELECT 1;", "lane words only in comments"],
  ["UPDATE invoices_archive SET x = 1;", "a table that only starts with a lane name"],
  ["CREATE OR REPLACE FUNCTION public.close_delivery_receipt() AS $$ SELECT 1 $$;", "a neutral function"],
  ["CREATE FUNCTION public.save_spray_job_invoice() AS $$ SELECT 1 $$;", "a field-billing function name"],
]) ok(!isTahaLaneSql(sql), `not Taha's: ${why}`);
const mig = (filename, sql) => ({ filename, status: "added", sql });
ok(tahaLaneProblem({ files: [mig("supabase/migrations/20270226213000_refuse_impossible_quantities_and_dates.sql", "ALTER TABLE public.order_items ADD CHECK (q > 0);")], now: NOW }),
  "a neutral-named migration that changes order lines is refused");
eq(tahaLaneProblem({ files: [mig("supabase/migrations/20270227000000_driver.sql", "UPDATE deliveries SET x = 1;")], now: NOW }), null, "a neutral migration on deliveries passes");
// Mason, 2026-11-23: field billing stays his even when its SQL writes the shared invoice tables (#2260).
eq(tahaLaneProblem({ files: [mig("supabase/migrations/20270224130000_split_save_refuses_blend_billed_job.sql", "INSERT INTO invoices (id) VALUES (1);")], now: NOW }), null, "a field-billing migration writing invoices stays Mason's");
ok(tahaLaneProblem({ files: [mig("supabase/migrations/20270224130000_field_invoice_fix.sql", null)], now: NOW }), "a field-billing migration whose SQL can't be read refuses (#2382 HIGH 1)");
ok(tahaLaneProblem({ files: [mig("supabase/migrations/20270224130000_release_hold_reject_job.sql", "SELECT 1;")], now: NOW }), "a hold word still wins over a job word");
eq(tahaLaneProblem({ files: [mig("supabase/migrations/20270227000000_driver.sql", null)], now: NOW })?.files, ["supabase/migrations/20270227000000_driver.sql (its SQL could not be read)"], "unreadable SQL refuses, and says why");

// ── Taha's review of #2382 ──────────────────────────────────────────────────
const MIGS = path.join(HERE, "..", "..", "supabase", "migrations");
const sql2338 = readFileSync(path.join(MIGS, "20270227110000_delivery_driver_checks_need_a_driver.sql"), "utf8");
const sql2260 = readFileSync(path.join(MIGS, "20270224130000_split_save_refuses_blend_billed_job.sql"), "utf8");
// HIGH 1: a field word in the name exempts only the shared invoice tables, not the whole SQL.
for (const name of ["20270227110000_delivery_and_job_driver_checks.sql", "20270227110000_driver_checks_application_rates.sql"]) {
  ok(tahaLaneProblem({ files: [mig(`supabase/migrations/${name}`, sql2338)], now: NOW }), `#2338's real SQL under ${name} is refused`);
}
eq(tahaLaneProblem({ files: [mig("supabase/migrations/20270224130000_split_save_refuses_blend_billed_job.sql", sql2260)], now: NOW }), null, "#2260's real SQL still passes");
ok(tahaLaneProblem({ files: [mig("supabase/migrations/20270301000000_month_end_close_job.sql", "UPDATE public.payments SET x = 1; UPDATE public.quotes SET y = 2;")], now: NOW }), "a job-named month-end migration writing payments and quotes is refused");
for (const [sql, why] of [
  ["INSERT INTO invoices (id) VALUES (1); UPDATE invoice_items SET x = 1; DELETE FROM invoice_shares; UPDATE invoice_line_shares SET y = 1;", "the shared invoice tables"],
  ["DELETE FROM commissions WHERE invoice_id = 1;", "a field invoice's commissions (#2260)"],
  ["SELECT * FROM invoices WHERE id = 1 FOR UPDATE;", "a row lock on a field invoice"],
  ["CREATE OR REPLACE FUNCTION public._save_field_app_invoice_impl() RETURNS void AS $$ SELECT 1 $$;", "a field-billing function"],
]) ok(!isTahaLaneSql(sql, { fieldBilling: true }), `field-billing file, Mason's: ${why}`);
for (const [sql, why] of [
  ["UPDATE orders SET x = 1;", "orders"], ["INSERT INTO credit_memo_applications (id) VALUES (1);", "credit-memo applications"],
  ["UPDATE inventory_holds SET x = 1;", "holds"], ["INSERT INTO prepay_credits (id) VALUES (1);", "prepay"],
  ["INSERT INTO split_invoice_provenance (id) VALUES (1);", "split-invoice tables"],
  ["SELECT 1 FROM payments WHERE id = 1 FOR UPDATE;", "a row lock on payments"],
  ["CREATE OR REPLACE FUNCTION public.post_invoice() RETURNS void AS $$ SELECT 1 $$;", "a lane-named function"],
  ["CREATE OR REPLACE FUNCTION public._guard_credit_memo_application_immutable() RETURNS trigger AS $$ SELECT 1 $$;", "a listed lane function with a field word"],
  [null, "unreadable SQL"],
]) ok(isTahaLaneSql(sql, { fieldBilling: true }), `field-billing file, still Taha's: ${why}`);
// HIGH 2: Taha's functions with no lane word, and the new AR and month-end words.
const wrapper2324 = `CREATE OR REPLACE FUNCTION public._complete_delivery_authorized_impl(p_delivery_id uuid, p_idempotency_key text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $function$
BEGIN
  UPDATE public.deliveries SET checked = true WHERE id = p_delivery_id;
  RETURN public._complete_delivery_authorized_impl_20270122(p_delivery_id, p_idempotency_key);
END $function$;`;
ok(tahaLaneProblem({ files: [mig("supabase/migrations/20270227180000_f05b_delivery_line_checks.sql", wrapper2324)], now: NOW }), "#2324's wrapper is refused");
for (const fn of ["complete_delivery", "_start_and_complete_delivery_impl", "start_and_complete_delivery", "void_delivery", "cancel_delivery", "void_order",
  "cancel_order", "update_order_items", "price_order", "apply_write_off", "reverse_write_off", "close_accounting_period", "reopen_accounting_period",
  "_lock_accounting_months", "get_ar_reminder_candidates", "get_customer_balance_listing", "get_monthly_summary", "prevent_order_shares_edit_after_post",
  "apply_credit_memo", "ar_snapshot", "monthly_rollup", "write_off_small_balances", "receivables_sweep",
  // Taha's #2382 MED 1: "_"-prefixed impls and wrappers behind the public names.
  "_void_order_impl_20260714", "_cancel_order_idem_impl_20260721", "_price_order_replay_impl_20261015",
  "_update_order_items_impl", "_void_delivery_replay_impl_20261015", "_cancel_delivery_replay_impl_20261015"]) {
  ok(isTahaLaneSql(`CREATE OR REPLACE FUNCTION public.${fn}() RETURNS void AS $$ SELECT 1 $$;`), `redefining ${fn} is Taha's`);
}
for (const fn of ["completed_delivery_report", "save_job", "get_artifact", "monthly_job_application_report"]) {
  ok(!isTahaLaneSql(`CREATE OR REPLACE FUNCTION public.${fn}() RETURNS void AS $$ SELECT 1 $$;`), `${fn} is not Taha's`);
}
// MED 3: AR and month-end tables.
for (const t of ["accounting_periods", "write_offs", "ar_reminder_tracking", "credit_memo_sales_tax", "billing_m4_switch", "return_credit_customer_claims"]) {
  ok(isTahaLaneSql(`UPDATE public.${t} SET x = 1;`), `writing ${t} is Taha's`);
}
// MED 4: grants, revokes and comments on his functions, and a rename to a lane name.
ok(isTahaLaneSql("GRANT EXECUTE ON FUNCTION public.void_invoice(uuid) TO authenticated;"), "GRANT on void_invoice is Taha's");
ok(isTahaLaneSql("REVOKE ALL ON FUNCTION public.helper(uuid), public.apply_write_off(uuid, numeric(10,2)) FROM PUBLIC;"), "REVOKE on a list naming his function is Taha's");
ok(isTahaLaneSql("ALTER FUNCTION public.helper_x(uuid) RENAME TO post_invoice_v3;"), "RENAME TO post_invoice_v3 is Taha's");
ok(!isTahaLaneSql("GRANT EXECUTE ON FUNCTION public.save_job(uuid) TO authenticated; ALTER FUNCTION public.a() RENAME TO b;"), "a grant or rename outside his lane passes");
// LOW 5: lists.
for (const sql of ["TRUNCATE public.deliveries, public.invoices;", "DROP TABLE a, invoices;", "DROP FUNCTION a(), post_invoice();", "DROP FUNCTION IF EXISTS public.a(uuid, text), public.void_order(uuid);"]) {
  ok(isTahaLaneSql(sql), `a list naming his table or function: ${sql}`);
}
ok(!isTahaLaneSql("DROP FUNCTION a(), b(uuid); TRUNCATE deliveries, jobs;"), "lists with nothing of his pass");
// LOW 6: a stray quote inside a dollar-quoted comment does not hide the next line.
ok(isTahaLaneSql("COMMENT ON FUNCTION public.f() IS $c$Mason's note$c$;\nSELECT 'a -- b'; UPDATE public.invoices SET x = 1;"), "an apostrophe in $c$…$c$ does not flip the scanner");
ok(!isTahaLaneSql("CREATE FUNCTION public.f() RETURNS void AS $$ BEGIN -- UPDATE invoices\n PERFORM 1; END $$;"), "a comment inside a $$ body is still a comment");
ok(isTahaLaneSql("CREATE FUNCTION public.f() RETURNS void AS $$ BEGIN EXECUTE $q$UPDATE invoices SET x = 1$q$; END $$;"), "a nested $q$ string is still read");
// LOW 9: the row lock must be in the same statement as the read.
ok(!isTahaLaneSql("SELECT 1 FROM product_rate_lock FOR SHARE; SELECT count(*) FROM quote_items;"), "a lock on another table plus a separate read passes");
ok(isTahaLaneSql("SELECT 1 FROM product_rate_lock p JOIN quote_items q ON q.id = p.id FOR SHARE;"), "a lock in the statement that reads his table counts");
// Booking stock (Taha on #2382): inventory.quantity_prebooked.
for (const [sql, why] of [
  ["UPDATE public.inventory SET quantity_prebooked = quantity_prebooked + 1 WHERE id = 1;", "an update"],
  ["UPDATE inventory SET quantity_available = 1, quantity_prebooked = 0;", "a second SET column"],
  ["INSERT INTO public.inventory (product_id, quantity_prebooked) VALUES (1, 0);", "an insert"],
  ["CREATE FUNCTION public.f() RETURNS trigger AS $$ BEGIN NEW.quantity_prebooked := 0; RETURN NEW; END $$;", "a function body"],
  ["ALTER TABLE inventory ALTER COLUMN quantity_prebooked SET DEFAULT 0;", "a column change"],
  // Advisory Sol on #2382.
  ["UPDATE inventory SET (quantity_available, quantity_prebooked) = (100, 0);", "a tuple assignment"],
  ["ALTER TABLE inventory DROP quantity_prebooked;", "a drop without COLUMN"],
  // Taha's #2382 LOW 2: three forms staging does not use yet.
  ["CREATE FUNCTION public.t() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.quantity_prebooked = 0; RETURN NEW; END $$;", "a PL/pgSQL `=` assignment"],
  ["CREATE FUNCTION public.t() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF x THEN quantity_prebooked = 0; END IF; END $$;", "a bare `=` after THEN"],
  ["UPDATE public.inventory i SET quantity_available = (SELECT 1 FROM x h WHERE h.product_id = i.product_id), quantity_prebooked = 0;", "a SET after a subquery's WHERE"],
  ["ALTER TABLE public.inventory RENAME COLUMN x TO quantity_prebooked;", "a rename to it"],
  // Taha's review of #2408, LOW 3: the other statement starts.
  ["CREATE FUNCTION public.t() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN v := 1; NEW.quantity_prebooked = 0; RETURN NEW; END $$;", "a `=` after `;`"],
  ["CREATE FUNCTION public.t() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF x THEN v := 1; ELSE NEW.quantity_prebooked = 0; END IF; END $$;", "a `=` after ELSE"],
  ["CREATE FUNCTION public.t() RETURNS void LANGUAGE plpgsql AS $$ BEGIN LOOP r.quantity_prebooked = 0; EXIT; END LOOP; END $$;", "a `=` after LOOP"],
]) ok(isTahaLaneSql(sql), `quantity_prebooked: ${why}`);
ok(!isTahaLaneSql("CREATE FUNCTION public.t() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.quantity_prebooked_released = 0; RETURN NEW; END $$;"), "quantity_prebooked_released is another column");
ok(!isTahaLaneSql("UPDATE inventory SET quantity_available = 1 WHERE quantity_prebooked = 0 AND (quantity_on_hand > 0);"), "a WHERE comparing quantity_prebooked is still a read");
// Gap 1 (Taha via Mason, 2026-11-24): a "job" or "application" file name does not skip the SQL read.
for (const name of ["20990101000000_job_fix.sql", "20990101000000_application_fix.sql"]) {
  ok(tahaLaneProblem({ files: [mig(`supabase/migrations/${name}`, "UPDATE public.orders SET status = 'x';")], now: NOW }), `${name} writing orders is refused`);
  ok(tahaLaneProblem({ files: [mig(`supabase/migrations/${name}`, "CREATE FUNCTION public.apply_write_off() RETURNS void AS $$ SELECT 1 $$;")], now: NOW }), `${name} redefining apply_write_off is refused`);
}
// Gap 2: his functions with no lane word, from a sweep of staging (2026-11-24), "_"-prefixed impls included.
for (const fn of ["create_direct_order", "_create_rush_order_below_cost_impl_20260810", "bulk_import_order", "restore_cancelled_order",
  "_close_undelivered_order_remainder_20260718", "bump_order_item_edit_version", "check_unpriced_orders", "trg_recalc_order_totals",
  "guard_order_item_shares", "_validate_order_shares_total", "_assert_order_line_fits", "create_return", "_receive_return_intent_impl_20260812",
  "generate_finance_charges", "create_delivery_with_items", "_create_quick_delivery_intent_impl_20260802", "edit_delivery", "fix_delivery",
  "correct_delivery_brands", "batch_cancel_deliveries", "_delivery_line_matches_order_line", "_enforce_delivery_items_parent_lock",
  "_prebook_quick_delivery_inventory",
  // Taha's review of #2408, LOW 1 and LOW 2.
  "get_customer_year_end_summary", "get_batch_year_end_summaries", "check_period_open", "preview_finance_charges",
  "get_sales_summary_report", "get_sales_detail_report", "get_gross_sales_report", "get_profitability_report",
  "financial_dashboard_summary", "bump_order_edit_version", "prevent_oifa_edit_after_post", "guard_order_reopen_inactive_product"]) {
  ok(isTahaLaneSql(`CREATE OR REPLACE FUNCTION public.${fn}() RETURNS void AS $$ SELECT 1 $$;`), `redefining ${fn} is Taha's`);
}
for (const fn of ["complete_job", "save_field_app_invoice", "create_order_from_blend_ticket", "receive_po_items", "edit_deliveryman_profile"]) {
  ok(!isTahaLaneSql(`CREATE OR REPLACE FUNCTION public.${fn}() RETURNS void AS $$ SELECT 1 $$;`), `${fn} stays out of his list`);
}
// Advisory Sol on #2382: ONLY after a comma, and function prefixes end at a name boundary.
ok(isTahaLaneSql("TRUNCATE TABLE ONLY deliveries, ONLY invoices;"), "ONLY on a later list item");
ok(!isTahaLaneSql("CREATE FUNCTION public.void_ordering_cache() RETURNS void AS $$ SELECT 1 $$;"), "void_ordering_cache is not void_order");
ok(isTahaLaneSql("CREATE FUNCTION public.void_order_v2() RETURNS void AS $$ SELECT 1 $$;"), "void_order_v2 is void_order");
ok(!isTahaLaneSql("UPDATE inventory SET quantity_available = 1 WHERE quantity_prebooked = 0; SELECT quantity_prebooked FROM inventory;"), "reading quantity_prebooked is not a write");

// Reading the SQL from GitHub at the PR's commit.
const REF = "a".repeat(40);
const ghFake = (answers) => { const calls = []; const fn = (args) => { calls.push(args); const a = answers(args); if (a instanceof Error) throw a; return a; }; fn.calls = calls; return fn; };
const migTsv = `added\tsupabase/migrations/20270227_x.sql\t\t${REF}\nremoved\tsupabase/migrations/20270101_old.sql\t\t\nmodified\tsrc/a.ts\t\t${REF}\n`;
let fake = ghFake((args) => args.includes("--paginate") ? migTsv : "UPDATE orders SET x = 1;");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: REF }), [
  { filename: "supabase/migrations/20270227_x.sql", previous_filename: undefined, sql: "UPDATE orders SET x = 1;" },
  { filename: "supabase/migrations/20270101_old.sql", previous_filename: undefined, sql: null },
  { filename: "src/a.ts", previous_filename: undefined },
], "migrations carry their SQL; a removed one is unreadable; app files carry none");
ok(fake.calls.some((a) => a.includes("Accept: application/vnd.github.raw") && a.some((x) => x === `repos/o/r/contents/supabase/migrations/20270227_x.sql?ref=${REF}`)), "the SQL is read at the PR's own commit");
eq(fake.calls.length, 2, "only the one readable migration is fetched");
fake = ghFake((args) => args.includes("--paginate") ? migTsv : new Error("404"));
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: REF })[0].sql, null, "a failed SQL read is unreadable, not empty");
fake = ghFake((args) => args.includes("--paginate") ? `added\tsupabase/migrations/20270227_x.sql\t\t\n` : "UPDATE orders SET x = 1;");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: REF })[0].sql, null, "no commit to read at is unreadable");
// #2382 LOW 8: the SQL must be read at the head the merge is pinned to.
fake = ghFake((args) => args.includes("--paginate") ? migTsv : "SELECT 1;");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: "b".repeat(40) }), null, "GitHub listing another commit than the pinned head is unreadable");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake })[0].sql, null, "no pinned head is unreadable");
// Advisory Sol on #2382: a list GitHub built for another head is unreadable; a SQL file moved out of the read folders counts as removed.
fake = ghFake((args) => args.includes("--paginate") ? `modified\tsrc/a.ts\t\t${"c".repeat(40)}\n` : "");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: REF }), null, "a file list from another head is unreadable");
fake = ghFake((args) => args.includes("--paginate") ? `renamed\tscripts/archive/fix.sql\tsupabase/migrations/20270227_fix.sql\t${REF}\n` : "SELECT 1;");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: REF })[0].sql, null, "a migration moved out of supabase/migrations counts as removed");
fake = ghFake((args) => args.includes("--paginate") ? migTsv : "SELECT 1;");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: REF.toUpperCase() })[0].sql, "SELECT 1;", "the head is compared without case");
// #2382 LOW 7: baselines and hand-run undo scripts are read too; other scripts are not.
fake = ghFake((args) => args.includes("--paginate")
  ? ["supabase/baselines/cron_jobs.sql", "scripts/smoke/x-reverse.sql", "scripts/.staging-migrations/y.sql", "scripts/smoke/x.sql"].map((n) => `added\t${n}\t\t${REF}`).join("\n")
  : "UPDATE payments SET x = 1;");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: REF }).map((e) => "sql" in e), [true, true, true, false], "baselines, reverse scripts and staging-migration copies carry SQL");
ok(tahaLaneProblem({ files: prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake, headSha: REF }), now: NOW })?.files.includes("supabase/baselines/cron_jobs.sql"),
  "a field-named baseline that writes payments is refused");

// Mason, 2026-11-24: no end date. A date long after Dec 15 changes nothing.
ok(tahaLaneProblem({ files: f("src/pages/Quotes.tsx"), now: Date.UTC(2027, 5, 1) }), "still on after Dec 15");
ok(tahaLaneProblem({ files: null, now: Date.UTC(2027, 5, 1) }), "unreadable files still refuse after Dec 15");

// ── the command names the PR ────────────────────────────────────────────────
eq(tahaOverrideCommand("taha override #2242 123456"), { pullRequest: 2242, code: "123456" }, "plain command");
eq(tahaOverrideCommand("  Taha Override #2242 123456."), { pullRequest: 2242, code: "123456" }, "phone capitalisation and a period");
eq(tahaOverrideCommand("taha override 123456"), null, "a code without the PR is not the command");
eq(tahaOverrideCommand("taha override #2242 12345"), null, "five digits is not a code");
eq(tahaOverrideCommand("please taha override #2242 123456"), null, "other words before it");
eq(tahaOverrideCommand("taha override #2242 123456 now"), null, "other words after it");
ok(tahaOverrideAttempt("taha override 123456"), "the old form is noticed and refused");
ok(!tahaOverrideAttempt("hello"), "ordinary chat is not an attempt");

// ── code → override, one PR at one commit, 24 hours ────────────────────────
const A = "a".repeat(40), B = "b".repeat(40);
const root = tempDir("taha-lane-");
const dir = path.join(root, ".claude", "session-" + "state");
mkdirSync(path.dirname(dir), { recursive: true });
const dirs = [dir];
eq(issueTahaLaneCode({ dirs, pullRequest: 2242, headSha: "nope", now: NOW }), null, "no code without a real head");
const code = issueTahaLaneCode({ dirs, pullRequest: 2242, headSha: A, now: NOW, newCode: () => "424242" });
eq(code, "424242", "a code is issued");
eq(issueTahaLaneCode({ dirs, pullRequest: 2242, headSha: A, now: NOW + 1000, newCode: () => "999999" }), "424242", "a live code for the same PR and head is reused");
eq(issueTahaLaneCode({ dirs, pullRequest: 2242, headSha: B, now: NOW + 1000, newCode: () => "777777" }), "777777", "a new head gets a new code");
eq(findTahaLaneOverride({ dirs, pullRequest: 2242, headSha: A, now: NOW }), null, "a code alone is not an override");
eq(recordTahaLaneOverride({ dirs, pullRequest: 2242, code: "111111", now: NOW }).ok, false, "an unknown code records nothing");
eq(recordTahaLaneOverride({ dirs, pullRequest: 2242, code, now: NOW + 25 * 3600e3 }).ok, false, "a code older than 24 hours records nothing");
const wrongPr = recordTahaLaneOverride({ dirs, pullRequest: 2292, code, now: NOW + 30e3 });
ok(!wrongPr.ok && /issued for #2242, not #2292/.test(wrongPr.reason), "Mason naming another PR records nothing");
const rec = recordTahaLaneOverride({ dirs, pullRequest: 2242, code, now: NOW + 60e3 });
ok(rec.ok && rec.payload.pullRequest === 2242 && rec.payload.headSha === A, "the code becomes an override for its PR and head");
eq(recordTahaLaneOverride({ dirs, pullRequest: 2242, code, now: NOW + 120e3 }).ok, false, "a code works once");
ok(findTahaLaneOverride({ dirs, pullRequest: 2242, headSha: A, now: NOW + 3600e3 }), "the override is found for that PR and head");
eq(findTahaLaneOverride({ dirs, pullRequest: 2242, headSha: B, now: NOW + 3600e3 }), null, "a later push is not covered");
eq(findTahaLaneOverride({ dirs, pullRequest: 2243, headSha: A, now: NOW + 3600e3 }), null, "no other PR is covered");
eq(findTahaLaneOverride({ dirs, pullRequest: 2242, headSha: A, now: NOW + 60e3 + 24 * 3600e3 }), null, "the override ends after 24 hours");

// ── the gate the merge guards call ──────────────────────────────────────────
const lane = f("src/pages/Quotes.tsx");
const failTell = tahaLaneGate({ prefix: "T", pullRequest: 2242, headSha: A, files: lane, dirs, now: NOW + 3600e3, tellTaha: () => false });
ok(/comment telling Taha could not be posted/.test(failTell), "override but Taha can't be told → refused");
const told = [];
eq(tahaLaneGate({ prefix: "T", pullRequest: 2242, headSha: A, files: lane, dirs, now: NOW + 3600e3, tellTaha: (b) => { told.push(b); return true; } }), null, "override + Taha told → through");
ok(told.length === 1 && told[0].startsWith("@TahaKhanAbdalli") && told[0].includes(A), "the comment tags Taha and names the commit");
eq(tahaLaneGate({ prefix: "T", pullRequest: 2242, headSha: A, files: lane, dirs, now: NOW + 3600e3, tellTaha: () => { told.push("again"); return true; } }), null, "a retry still passes");
eq(told.length, 1, "and Taha is told once, not on every retry");
const pushed = tahaLaneGate({ prefix: "T", pullRequest: 2242, headSha: B, files: lane, dirs, now: NOW + 3600e3, tellTaha: () => true });
ok(/taha override #2242 777777/.test(pushed), "after a new push the block is back, with the new head's code");
const refusal = tahaLaneGate({ prefix: "T", pullRequest: 2300, headSha: A, files: lane, dirs, now: NOW });
ok(/TAHA LANE BLOCK/.test(refusal) && /taha override #2300 \d{6}/.test(refusal), "a refusal gives Mason the exact line, PR included");
eq(tahaLaneGate({ prefix: "T", pullRequest: 2300, headSha: A, files: f("src/pages/Deliveries.tsx"), dirs, now: NOW }), null, "outside the lane, nothing to do");
// Taha's Approve on the exact head (Mason, 2026-11-24).
const rv = (state, commit, id = "50602678", at = "2026-11-24T15:00:00Z") => ({ id, state, commit, at });
ok(tahaApprovedHead([rv("APPROVED", A)], A), "Taha approved this head");
ok(tahaApprovedHead([rv("APPROVED", A.toUpperCase())], A), "commit compared without case");
ok(!tahaApprovedHead([rv("APPROVED", B)], A), "an Approve of an older head does not count");
ok(!tahaApprovedHead([rv("APPROVED", A, "12345")], A), "someone else's Approve does not count");
ok(!tahaApprovedHead([{ login: "TahaKhanAbdalli", state: "APPROVED", commit: A }], A), "his login alone (renamable) does not count; his account number does");
ok(!tahaApprovedHead([rv("APPROVED", A)], A, "2026-11-24T16:00:00Z"), "the PR's base branch changed after his Approve: refused");
ok(tahaApprovedHead([rv("APPROVED", A)], A, "2026-11-24T14:00:00Z"), "a base change before his Approve is fine");
ok(!tahaApprovedHead([rv("APPROVED", A, "50602678", "")], A, "2026-11-24T14:00:00Z"), "an Approve with no time, after a base change, refuses");
ok(!tahaApprovedHead([rv("APPROVED", A), rv("CHANGES_REQUESTED", A)], A), "changes requested after the Approve wins");
ok(!tahaApprovedHead([rv("DISMISSED", A)], A), "a dismissed Approve does not count");
ok(tahaApprovedHead([rv("APPROVED", A), rv("COMMENTED", A)], A), "a later comment does not undo the Approve");
ok(tahaApprovedHead([rv("CHANGES_REQUESTED", A), rv("APPROVED", A)], A), "an Approve after changes requested counts");
ok(!tahaApprovedHead([rv("APPROVED", A)], "short"), "an unusable head never counts");
ok(!tahaApprovedHead([rv("APPROVED", A), rv("DISMISSED", B)], A), "a dismissal after his Approve, on any commit, holds it (#2406)");
ok(tahaApprovedHead([rv("APPROVED", A), rv("DISMISSED", A), rv("APPROVED", A)], A), "a fresh Approve after a dismissal counts");
const revGh = (tsv, base = "") => (args) => {
  if (args.some((a) => /\/pulls\/5\/reviews/.test(a))) return tsv;
  if (args.some((a) => /\/issues\/5\/timeline/.test(a))) { if (base === null) throw new Error("502"); return base; }
  throw new Error("wrong call");
};
const approvedTsv = `50602678\tAPPROVED\t${A}\t2026-11-24T15:00:00Z\n`;
ok(tahaApprovedOnGitHub({ repo: "o/r", gh: revGh(approvedTsv), pullRequest: 5, headSha: A }), "read from GitHub: approved");
ok(!tahaApprovedOnGitHub({ repo: "o/r", gh: revGh(approvedTsv, "2026-11-20T00:00:00Z\n2026-11-24T16:00:00Z\n"), pullRequest: 5, headSha: A }), "read from GitHub: retargeted after the Approve");
ok(!tahaApprovedOnGitHub({ repo: "o/r", gh: revGh(approvedTsv, null), pullRequest: 5, headSha: A }), "an unreadable base history refuses");
ok(!tahaApprovedOnGitHub({ repo: "o/r", gh: () => { throw new Error("502"); }, pullRequest: 5, headSha: A }), "a failed read refuses");
let askedTaha = 0;
const approve = () => { askedTaha++; return true; };
eq(tahaLaneGate({ prefix: "T", pullRequest: 2400, headSha: A, files: lane, dirs, now: NOW, tahaApproved: approve }), null, "Taha's Approve lets lane code through, no code needed");
ok(/TAHA LANE BLOCK/.test(tahaLaneGate({ prefix: "T", pullRequest: 2400, headSha: A, files: lane, dirs, now: NOW, tahaApproved: () => false })), "without it, refused");
ok(/TAHA LANE BLOCK/.test(tahaLaneGate({ prefix: "T", pullRequest: 2400, headSha: A, files: f("src/pages/Quotes.tsx", ".claude/hooks/pr-merge-guard.mjs"), dirs, now: NOW, tahaApproved: approve })),
  "the block's own files still need Mason's code, even with Taha's Approve");
ok(/TAHA LANE BLOCK/.test(tahaLaneGate({ prefix: "T", pullRequest: 2400, headSha: A, files: null, dirs, now: NOW, tahaApproved: approve })), "an unreadable file list still refuses");
const laneNamedMig = "supabase/migrations/20270227000000_chemical_invoice_fix.sql";
ok(isTahaLanePath(laneNamedMig), "fixture: the migration's name alone is in Taha's lane");
ok(/TAHA LANE BLOCK/.test(tahaLaneGate({ prefix: "T", pullRequest: 2400, headSha: A, files: [mig(laneNamedMig, null)], dirs, now: NOW, tahaApproved: approve })),
  "a lane-named migration whose SQL could not be read still needs Mason's code, even with Taha's Approve (Astra BLOCKER 1)");
ok(/TAHA LANE BLOCK/.test(tahaLaneGate({ prefix: "T", pullRequest: 2400, headSha: A, files: [...f("src/pages/Quotes.tsx"), mig("supabase/migrations/20270227000000_x.sql", null)], dirs, now: NOW, tahaApproved: approve })),
  "any unreadable migration beside lane code still needs Mason's code");
eq(tahaLaneGate({ prefix: "T", pullRequest: 2400, headSha: A, files: [mig(laneNamedMig, "update public.chemical_invoices set x = 1;")], dirs, now: NOW, tahaApproved: approve }), null,
  "a readable lane migration goes through on Taha's Approve");
askedTaha = 0;
tahaLaneGate({ prefix: "T", pullRequest: 2400, headSha: A, files: f("src/pages/Deliveries.tsx"), dirs, now: NOW, tahaApproved: approve });
eq(askedTaha, 0, "outside the lane, GitHub is not even asked");
eq(tellTahaOnGitHub({ repo: undefined, pullRequest: 5, body: "x", gh: () => "123" }), true, "GitHub took the comment");
eq(tellTahaOnGitHub({ repo: undefined, pullRequest: 5, body: "x", gh: () => { throw new Error("403"); } }), false, "a failed post is false");

// ── the real prompt hook, as Claude Code runs it ───────────────────────────
const runHook = (prompt, cwd) => {
  const r = spawnSync(process.execPath, [path.join(HERE, "taha-lane-prompt.mjs")], {
    input: JSON.stringify({ prompt, cwd, session_id: "test-session-123" }), encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd },
  });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
};
const repo = tempDir("taha-lane-repo-");
spawnSync("git", ["init", "-q", repo]);
const state = path.join(repo, ".claude", "session-" + "state");
mkdirSync(state, { recursive: true });
const hookCode = issueTahaLaneCode({ dirs: [state], pullRequest: 2247, headSha: A });
eq(runHook("hello there", repo), "", "ordinary chat: the hook says nothing");
ok(runHook(`ok taha override #2247 ${hookCode}`, repo).includes("NOT RECORDED"), "a near miss is refused out loud");
ok(runHook("taha override #2247 000001", repo).includes("NOT RECORDED"), "a code the guard never issued is refused");
ok(runHook(`taha override #2292 ${hookCode}`, repo).includes("not #2292"), "the wrong PR is refused");
ok(runHook(`taha override #2247 ${hookCode}`, repo).includes("RECORDED — Mason let PR #2247"), "his code is recorded");
ok(readdirSync(state).includes("taha-lane-override-pr2247.json"), "the override file exists for the gates");

console.log(`taha-lane-lib tests: ${pass} passed`);
