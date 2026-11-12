// Tests for sol-risk-lib.mjs: which pull requests still need Sol (Mason, 2026-10-30).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifySolRisk, GATED_MERGE_BASES, solRiskOnGitHub, solRiskPathProblem, SOL_REQUIRED_PATHS, SOL_RISK_MAX_FILES,
  agentMergeProblem, mainCommitsInPrOnGitHub,
} from "./sol-risk-lib.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };
const file = (filename, extra = {}) => ({ filename, status: "modified", ...extra });

for (const name of [
  "docs/plans/product.md", "docs/reference/gotchas.md", "README.md", "AGENTS.md", "docs/workflows/SAFE_DEVELOPMENT_RULES.md",
  "src/components/Label.tsx", "src/lib/units.ts", "public/sw.js", ".gitignore",
  ".claude/commands/ship.md", ".claude/hooks/loop-guard.mjs", ".claude/hooks/pr-merge-guard.test.mjs", "scripts/agent-health-check.mjs",
  ".claude/hooks/pr-merge-guard.mjs", ".claude/hooks/sol-risk-lib.mjs", ".claude/hooks/env-guard.mjs", ".codex/hooks/production-action-guard.mjs", ".claude/settings.json",
  "scripts/write-codex-push-proof.mjs", "scripts/check-agent-guidance.mjs", ".claude/agents/rls-security-reviewer.md",
  "package.json", "package-lock.json", "tools/x/package.json", ".npmrc", "deno.lock",
  ".github/workflows/ci.yml", ".husky/pre-push", "vercel.json", "vite.config.ts", "index.html", "scripts/classify-ci-scope.mjs",
  "src/pages/Jobs.tsx", "src/pages/Fields.tsx",
  // Tests and specs with a money word in their name (Mason 2026-11-07).
  "src/__tests__/return-credit-remediation-guards.test.ts", "src/lib/invoiceMath.test.ts", "src/lib/priceRules.spec.tsx", "src/lib/__tests__/creditLimit.ts",
]) {
  check(`${name} does not need Sol`, () => assert.equal(solRiskPathProblem(name), null));
}
for (const name of [
  "src/lib/invoiceMath.ts", "src/pages/Inventory.tsx", "supabase/migrations/20261029_x.sql", "supabase/functions/send-email/index.ts", "supabase/config.toml",
  "src/lib/db.ts", "src/contexts/AuthContext.tsx", "src/lib/pagePermissions.ts", "src/components/auth/ResetPasswordPage.tsx", "SRC\\Components\\Auth\\LoginPage.tsx",
  "src/App.tsx", "src/appPages.tsx", "src/pages/MonthEndClose.tsx", "src/pages/Rebates.tsx", "src/pages/Receiving.tsx", "src/pages/LotTrace.tsx", "src/pages/JobDetail.tsx", "src/pages/OfficeCockpit.tsx", "src/pages/Reports.tsx", "src/pages/SettingsPage.tsx", "src/lib/offlineSync.ts", "src/components/receiving/ReceiveForm.tsx",
  // Listed paths still need Sol for their tests; a non-test file with "test" in its name is still money code.
  "src/components/auth/LoginPage.test.tsx", "src/components/receiving/__tests__/ReceiveForm.test.tsx", "src/lib/invoiceTestHelpers.ts", "src/lib/testInvoice.ts",
]) {
  check(`${name} needs Sol`, () => assert.ok(solRiskPathProblem(name)));
}
check("a rename out of a listed file needs Sol", () => {
  assert.equal(classifySolRisk([file("docs/plans/x.md", { status: "renamed", previous_filename: "src/lib/invoiceMath.ts" })]).risky, true);
});
check("a rename with no old name needs Sol", () => {
  assert.equal(classifySolRisk([file("docs/plans/x.md", { status: "renamed" })]).risky, true);
});
check("unreadable answers need Sol", () => {
  for (const files of [null, [], [null], [file("docs/a.md", { status: "changed" })],
    Array.from({ length: SOL_RISK_MAX_FILES }, (_, i) => file(`docs/f${i}.md`))]) {
    assert.equal(classifySolRisk(files).risky, true);
  }
});
check("the readable page lists every entry", () => {
  const page = readFileSync(new URL("../../docs/reference/sol-required-paths.md", import.meta.url), "utf8");
  for (const entry of SOL_REQUIRED_PATHS) assert.ok(page.includes(`\`${entry}\``), entry);
});

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const answer = (over = {}) => JSON.stringify({ status: "ahead", ahead_by: 1, head: HEAD, files: [file("src/components/Label.tsx")], ...over });
const ask = (stdout, extra = {}) => solRiskOnGitHub({ baseSha: BASE, headSha: HEAD, repo: "croprxsolutions/CRX_Manager_V1.0",
  gh: () => { if (stdout instanceof Error) throw stdout; return stdout; }, ...extra });

check("a comparison off the list is low risk, behind main or not", () => {
  assert.equal(ask(answer()).risky, false);
  assert.equal(ask(answer({ status: "diverged" })).risky, false);
});
check("a behind pull request on the list needs Sol", () => {
  assert.equal(ask(answer({ status: "diverged", files: [file("src/lib/db.ts")] })).risky, true);
});
check("the comparison is fetched for exactly base...head", () => {
  let seen;
  solRiskOnGitHub({ baseSha: BASE, headSha: HEAD, repo: "o/r", gh: (args) => { seen ??= args; return answer(); } });
  assert.equal(seen[1], `repos/o/r/compare/${BASE}...${HEAD}`);
});
check("GitHub failures and mismatched comparisons need Sol", () => {
  for (const out of [new Error("boom"), "not json", "null", answer({ status: "behind" }), answer({ status: "identical" }),
    answer({ head: "c".repeat(40) }), answer({ ahead_by: 0 })]) {
    assert.equal(ask(out).risky, true);
  }
  assert.equal(ask(answer(), { headSha: "short" }).risky, true);
});

// staging-first release flow: feature work, migrations included, merges into staging; only Taha or
// Mason merges into main (the weekly release PR and hotfixes) and the back-merge of main into staging.
check("main and staging are the merge bases every gate covers", () => {
  assert.deepEqual([...GATED_MERGE_BASES], ["main", "staging"]);
});
check("an agent never merges into main, whatever the branch", () => {
  for (const head of ["release/next", "hotfix/cents", "claude/x", "taha/x", "main", "", undefined]) {
    assert.match(agentMergeProblem("main", head), /never merges into main.*Taha or Mason/, String(head));
  }
});
check("an agent never merges the back-merge (main into staging)", () => {
  assert.match(agentMergeProblem("staging", "main"), /back-merge.*Taha's or Mason's/);
});
check("feature work into staging is the agent's, migrations included", () => {
  for (const head of ["claude/x", "codex/y", "ship/z", "taha/x", "hotfix/x", "release/next"]) assert.equal(agentMergeProblem("staging", head), null, head);
});
check("other bases are not this rule's business", () => {
  assert.equal(agentMergeProblem("claude/feature", "claude/x"), null);
});

check("a PR into staging carrying main's commits that staging lacks is a back-merge under another name", () => {
  const c = (ch) => ch.repeat(40);
  const STAGING = c("a"); const HEAD = c("e");
  // answers[sha] = what GitHub says for <sha>...main
  const ask = (answers, extra = {}) => mainCommitsInPrOnGitHub({ stagingSha: STAGING, headSha: HEAD, repo: "o/r",
    gh: (args) => { const sha = /compare\/([0-9a-f]{40})\.\.\.main$/.exec(args[1])?.[1]; const a = answers[sha]; if (a instanceof Error) throw a; return a ?? "missing"; }, ...extra });
  const j = (o) => JSON.stringify(o);
  // main inside staging (the normal state): one call, nothing to bring in.
  for (const status of ["identical", "behind"]) assert.equal(ask({ [STAGING]: j({ status, ahead_by: 0, commits: [] }) }), null, status);
  // main ahead of staging by b and c.
  const ahead = j({ status: "ahead", ahead_by: 2, commits: [c("b"), c("c")] });
  assert.match(ask({ [STAGING]: ahead, [HEAD]: j({ status: "ahead", ahead_by: 1, commits: [c("b")] }) }), /1 commit\(s\) from main.*back-merge.*Taha's or Mason's/, "the head holds c");
  assert.equal(ask({ [STAGING]: ahead, [HEAD]: j({ status: "diverged", ahead_by: 2, commits: [c("b"), c("c")] }) }), null, "the head holds neither");
  assert.match(ask({ [STAGING]: ahead, [HEAD]: j({ status: "identical", ahead_by: 0, commits: [] }) }), /2 commit\(s\)/, "the head holds all of main");
  // unreadable, cut short, unexpected or malformed answers fail closed, on either call.
  for (const bad of [new Error("offline"), "not json", j({ status: "ahead", ahead_by: 300, commits: [c("b")] }), j({ status: "ahead", ahead_by: 1 }), j({ status: "weird", ahead_by: 0, commits: [] }), j({ status: "behind", ahead_by: 1, commits: [] })]) {
    assert.ok(ask({ [STAGING]: bad }), `staging call: ${bad}`);
    assert.ok(ask({ [STAGING]: ahead, [HEAD]: bad }), `head call: ${bad}`);
  }
  assert.match(mainCommitsInPrOnGitHub({ stagingSha: "short", headSha: HEAD, repo: "o/r", gh: () => "{}" }), /unusable base commit/, "a bad staging sha fails closed");
  assert.ok(mainCommitsInPrOnGitHub({ stagingSha: STAGING, headSha: "short", repo: "o/r", gh: () => "{}" }), "a bad head sha fails closed");
});

console.log(`sol-risk-lib: ${passed} passed`);
