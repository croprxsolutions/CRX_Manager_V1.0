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
  TAHA_LANE_UNTIL_MS, findTahaLaneOverride, isTahaLanePath, prFilesOnGitHub, issueTahaLaneCode, recordTahaLaneOverride,
  tahaLaneGate, tahaLaneProblem, tahaOverrideAttempt, tahaOverrideCode,
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
]) ok(isTahaLanePath(p), `${p} is Taha's`);
for (const p of [
  "src/pages/FieldApplicationInvoice.tsx", "src/components/field-invoices/Row.tsx", "src/pages/FieldInvoices.tsx",
  "supabase/migrations/20270224110000_retire_per_acre_field_pricing.sql", "src/pages/JobDetail.tsx", "src/pages/BlendTickets.tsx",
  "src/pages/Deliveries.tsx", "src/pages/InventoryPage.tsx", "src/lib/threshold.ts", "docs/workflows/QUOTE_TO_DELIVERY.md",
  ".claude/hooks/taha-lane-lib.mjs", "scripts/quote-report.mjs",
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
eq(tahaLaneProblem({ files: f("src/pages/Quotes.tsx"), now: TAHA_LANE_UNTIL_MS }), null, "off after Dec 15");
eq(tahaLaneProblem({ files: null, now: TAHA_LANE_UNTIL_MS + 1 }), null, "off after Dec 15 even when unreadable");
ok(tahaLaneProblem({ files: f("src/pages/Quotes.tsx"), now: TAHA_LANE_UNTIL_MS - 1 }), "still on at the last moment of Dec 15");

// ── the command ─────────────────────────────────────────────────────────────
eq(tahaOverrideCode("taha override 123456"), "123456", "plain command");
eq(tahaOverrideCode("  Taha Override 123456."), "123456", "phone capitalisation and a period");
eq(tahaOverrideCode("taha override 12345"), null, "five digits is not a code");
eq(tahaOverrideCode("please taha override 123456"), null, "other words before it");
eq(tahaOverrideCode("taha override 123456 now"), null, "other words after it");
ok(tahaOverrideAttempt("ok taha override 123456"), "a near miss is noticed");
ok(!tahaOverrideAttempt("hello"), "ordinary chat is not an attempt");

// ── code → override, one PR, 24 hours ───────────────────────────────────────
const root = tempDir("taha-lane-");
const dir = path.join(root, ".claude", "session-state");
mkdirSync(path.dirname(dir), { recursive: true });
const dirs = [dir];
const code = issueTahaLaneCode({ dirs, pullRequest: 2242, now: NOW, newCode: () => "424242" });
eq(code, "424242", "a code is issued");
eq(issueTahaLaneCode({ dirs, pullRequest: 2242, now: NOW + 1000, newCode: () => "999999" }), "424242", "a live code for the same PR is reused");
eq(findTahaLaneOverride({ dirs, pullRequest: 2242, now: NOW }), null, "a code alone is not an override");
eq(recordTahaLaneOverride({ dirs, code: "111111", now: NOW }).ok, false, "an unknown code records nothing");
eq(recordTahaLaneOverride({ dirs, code, now: NOW + 25 * 3600e3 }).ok, false, "a code older than 24 hours records nothing");
const rec = recordTahaLaneOverride({ dirs, code, now: NOW + 60e3 });
ok(rec.ok && rec.payload.pullRequest === 2242, "the code becomes an override for its PR");
eq(recordTahaLaneOverride({ dirs, code, now: NOW + 120e3 }).ok, false, "a code works once");
ok(findTahaLaneOverride({ dirs, pullRequest: 2242, now: NOW + 3600e3 }), "the override is found for that PR");
eq(findTahaLaneOverride({ dirs, pullRequest: 2243, now: NOW + 3600e3 }), null, "no other PR is covered");
eq(findTahaLaneOverride({ dirs, pullRequest: 2242, now: NOW + 60e3 + 24 * 3600e3 }), null, "the override ends after 24 hours");

// ── the gate the merge guards call ──────────────────────────────────────────
const notes = [];
eq(tahaLaneGate({ prefix: "T", pullRequest: 2242, files: f("src/pages/Quotes.tsx"), dirs, now: NOW + 3600e3, notice: (t) => notes.push(t) }), null, "override lets the PR through");
ok(notes[0]?.includes("OVERRIDDEN BY MASON"), "and says so");
const refusal = tahaLaneGate({ prefix: "T", pullRequest: 2300, files: f("src/pages/Quotes.tsx"), dirs, now: NOW, notice: () => {} });
ok(/TAHA LANE BLOCK/.test(refusal) && /taha override \d{6}/.test(refusal), "a refusal gives Mason a code to type");
eq(tahaLaneGate({ prefix: "T", pullRequest: 2300, files: f("src/pages/Deliveries.tsx"), dirs, now: NOW }), null, "outside the lane, nothing to do");

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
const state = path.join(repo, ".claude", "session-state");
mkdirSync(state, { recursive: true });
const hookCode = issueTahaLaneCode({ dirs: [state], pullRequest: 2247 });
eq(runHook("hello there", repo), "", "ordinary chat: the hook says nothing");
ok(runHook(`ok taha override ${hookCode}`, repo).includes("NOT RECORDED"), "a near miss is refused out loud");
ok(runHook("taha override 000001", repo).includes("NOT RECORDED"), "a code the guard never issued is refused");
ok(runHook(`taha override ${hookCode}`, repo).includes("RECORDED — Mason let PR #2247"), "his code is recorded");
ok(readdirSync(state).includes("taha-lane-override-pr2247.json"), "the override file exists for the gates");

console.log(`taha-lane-lib tests: ${pass} passed`);
