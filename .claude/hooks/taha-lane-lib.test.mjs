#!/usr/bin/env node
// Taha lane block (taha-lane-lib.mjs, Mason 2026-11-22): which files count, the
// Dec 15 end, the one-PR override by code, and the real prompt hook end to end.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";
import {
  TAHA_LANE_UNTIL_MS, findTahaLaneOverride, isTahaLanePath, isTahaLaneSql, prFilesOnGitHub, issueTahaLaneCode, recordTahaLaneOverride,
  tahaLaneGate, tahaLaneProblem, tahaOverrideAttempt, tahaOverrideCommand, tellTahaOnGitHub,
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
eq(tahaLaneProblem({ files: [mig("supabase/migrations/20270224130000_field_invoice_fix.sql", null)], now: NOW }), null, "a field-billing migration needs no SQL read");
ok(tahaLaneProblem({ files: [mig("supabase/migrations/20270224130000_release_hold_reject_job.sql", "SELECT 1;")], now: NOW }), "a hold word still wins over a job word");
eq(tahaLaneProblem({ files: [mig("supabase/migrations/20270227000000_driver.sql", null)], now: NOW })?.files, ["supabase/migrations/20270227000000_driver.sql (its SQL could not be read)"], "unreadable SQL refuses, and says why");

// Reading the SQL from GitHub at the PR's commit.
const REF = "a".repeat(40);
const ghFake = (answers) => { const calls = []; const fn = (args) => { calls.push(args); const a = answers(args); if (a instanceof Error) throw a; return a; }; fn.calls = calls; return fn; };
const migTsv = `added\tsupabase/migrations/20270227_x.sql\t\t${REF}\nremoved\tsupabase/migrations/20270101_old.sql\t\t\nmodified\tsrc/a.ts\t\t${REF}\n`;
let fake = ghFake((args) => args.includes("--paginate") ? migTsv : "UPDATE orders SET x = 1;");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake }), [
  { filename: "supabase/migrations/20270227_x.sql", previous_filename: undefined, sql: "UPDATE orders SET x = 1;" },
  { filename: "supabase/migrations/20270101_old.sql", previous_filename: undefined, sql: null },
  { filename: "src/a.ts", previous_filename: undefined },
], "migrations carry their SQL; a removed one is unreadable; app files carry none");
ok(fake.calls.some((a) => a.includes("Accept: application/vnd.github.raw") && a.some((x) => x === `repos/o/r/contents/supabase/migrations/20270227_x.sql?ref=${REF}`)), "the SQL is read at the PR's own commit");
eq(fake.calls.length, 2, "only the one readable migration is fetched");
fake = ghFake((args) => args.includes("--paginate") ? migTsv : new Error("404"));
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake })[0].sql, null, "a failed SQL read is unreadable, not empty");
fake = ghFake((args) => args.includes("--paginate") ? `added\tsupabase/migrations/20270227_x.sql\t\t\n` : "UPDATE orders SET x = 1;");
eq(prFilesOnGitHub({ repo: "o/r", number: 7, gh: fake })[0].sql, null, "no commit to read at is unreadable");

eq(tahaLaneProblem({ files: f("src/pages/Quotes.tsx"), now: TAHA_LANE_UNTIL_MS }), null, "off after Dec 15");
eq(tahaLaneProblem({ files: null, now: TAHA_LANE_UNTIL_MS + 1 }), null, "off after Dec 15 even when unreadable");
ok(tahaLaneProblem({ files: f("src/pages/Quotes.tsx"), now: TAHA_LANE_UNTIL_MS - 1 }), "still on at the last moment of Dec 15");

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
