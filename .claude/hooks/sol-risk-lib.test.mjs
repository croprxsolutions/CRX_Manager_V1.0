// Tests for sol-risk-lib.mjs: which pull requests still need Sol (Mason, 2026-10-30).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PROTECTED_HARNESS_FILES } from "../../.codex/hooks/production-action-guard.mjs";
import { classifySolRisk, solRiskOnGitHub, solRiskPathProblem, SOL_REQUIRED_NAMES, SOL_REQUIRED_PATHS, SOL_RISK_MAX_FILES } from "./sol-risk-lib.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };
const file = (filename, extra = {}) => ({ filename, status: "modified", ...extra });

for (const name of [
  "docs/plans/product.md", "docs/reference/gotchas.md", "README.md", "AGENTS.md", "docs/workflows/SAFE_DEVELOPMENT_RULES.md",
  "src/components/Label.tsx", "src/lib/units.ts", "public/sw.js", ".gitignore",
  ".claude/commands/ship.md", ".claude/hooks/loop-guard.mjs", ".claude/hooks/pr-merge-guard.test.mjs", "scripts/agent-health-check.mjs",
]) {
  check(`${name} does not need Sol`, () => assert.equal(solRiskPathProblem(name), null));
}
for (const name of [
  "src/lib/invoiceMath.ts", "src/pages/Inventory.tsx", "supabase/migrations/20261029_x.sql", "supabase/functions/send-email/index.ts", "supabase/config.toml",
  "src/lib/db.ts", "src/contexts/AuthContext.tsx", "src/lib/pagePermissions.ts", "src/components/auth/ResetPasswordPage.tsx", "SRC\\Components\\Auth\\LoginPage.tsx",
  "package.json", "package-lock.json", "tools/x/package.json", ".github/workflows/ci.yml", "vercel.json", ".husky/pre-push", ".claude/settings.json", ".codex/hooks.json",
  ".claude/hooks/pr-merge-guard.mjs", ".claude/hooks/codex-push-lib.mjs", ".claude/hooks/env-guard.mjs", ".claude/hooks/migration-apply-lib.mjs",
  ".claude/hooks/sol-risk-lib.mjs", ".codex/hooks/production-action-guard.mjs", "scripts/write-codex-push-proof.mjs", "scripts/write-apply-proofs-lib.mjs",
  "src/App.tsx", "src/appPages.tsx", "src/pages/MonthEndClose.tsx", "src/lib/offlineSync.ts", "src/components/receiving/ReceiveForm.tsx", "vite.config.ts", "index.html", ".npmrc", "tools/x/.npmrc", "deno.lock",
  ".claude/settings.local.json", ".claude/agents/rls-security-reviewer.md", ".claude/hooks/live-testdata-lib.mjs", ".claude/hooks/migration-access-lib.mjs", "scripts/classify-ci-scope.mjs", "scripts/verify-schema-baseline.mjs", "scripts/check-agent-guidance.mjs",
]) {
  check(`${name} needs Sol`, () => assert.ok(solRiskPathProblem(name)));
}
check("every Codex-protected file needs Sol", () => {
  for (const name of PROTECTED_HARNESS_FILES) assert.ok(solRiskPathProblem(name), name);
});
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
  for (const entry of [...SOL_REQUIRED_PATHS, ...SOL_REQUIRED_NAMES]) assert.ok(page.includes(`\`${entry}\``), entry);
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

console.log(`sol-risk-lib: ${passed} passed`);
