// Tests for sol-risk-lib.mjs: which pull requests still need Sol (Mason, 2026-10-29).
import assert from "node:assert/strict";
import { classifySolRisk, solRiskOnGitHub, solRiskPathProblem, SOL_LARGE_PR_LINES, SOL_RISK_MAX_FILES } from "./sol-risk-lib.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };
const file = (filename, changes = 10, extra = {}) => ({ filename, status: "modified", changes, ...extra });

check("ordinary UI files are low risk", () => {
  assert.equal(classifySolRisk([file("src/components/Label.tsx"), file("docs/reference/x.md")]).risky, false);
});
for (const name of [
  "src/lib/invoiceMath.ts", "src/pages/Inventory.tsx", "supabase/migrations/20261029_x.sql",
  "supabase/functions/send-email/index.ts", ".claude/hooks/pr-merge-guard.mjs", ".codex/hooks/x.mjs",
  ".github/workflows/ci.yml", "scripts/write-codex-push-proof.mjs", ".husky/pre-commit", ".agents/x.md",
  "package.json", "docs/plans/CLAUDE.md", "AGENTS.md", ".coderabbit.yaml", "vercel.json", ".Claude/hooks/x.mjs",
  "docs/workflows/SAFE_DEVELOPMENT_RULES.md", "docs/reference/agent-guardrails.md", "docs/reference/gotchas.md",
]) {
  check(`${name} needs Sol`, () => assert.ok(solRiskPathProblem(name)));
}
check("a rename out of a money file needs Sol", () => {
  assert.equal(classifySolRisk([file("src/components/Thing.tsx", 2, { status: "renamed", previous_filename: "src/lib/invoiceMath.ts" })]).risky, true);
});
check("a rename with no old name needs Sol", () => {
  assert.equal(classifySolRisk([file("src/components/Thing.tsx", 2, { status: "renamed" })]).risky, true);
});
check(`exactly ${SOL_LARGE_PR_LINES} lines is low risk, one more needs Sol`, () => {
  assert.equal(classifySolRisk([file("src/a.tsx", 300), file("src/b.tsx", 200)]).risky, false);
  assert.equal(classifySolRisk([file("src/a.tsx", 300), file("src/b.tsx", 201)]).risky, true);
});
check("unreadable answers need Sol", () => {
  for (const files of [null, [], [null], [file("src/a.tsx", 1, { changes: undefined })], [file("src/a.tsx", 1, { status: "changed" })],
    Array.from({ length: SOL_RISK_MAX_FILES }, (_, i) => file(`src/f${i}.tsx`, 0))]) {
    assert.equal(classifySolRisk(files).risky, true);
  }
});

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const answer = (over = {}) => JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0, merge_base: BASE, head: HEAD, files: [file("src/components/Label.tsx")], ...over });
const ask = (stdout, extra = {}) => solRiskOnGitHub({ baseSha: BASE, headSha: HEAD, repo: "croprxsolutions/CRX_Manager_V1.0", gh: () => { if (stdout instanceof Error) throw stdout; return stdout; }, ...extra });

check("a clean base..head comparison of a UI file is low risk", () => assert.equal(ask(answer()).risky, false));
check("the comparison is fetched for exactly base...head", () => {
  let seen;
  solRiskOnGitHub({ baseSha: BASE, headSha: HEAD, repo: "o/r", gh: (args) => { seen = args; return answer(); } });
  assert.equal(seen[1], `repos/o/r/compare/${BASE}...${HEAD}`);
});
check("GitHub failures and mismatched comparisons need Sol", () => {
  for (const out of [new Error("boom"), "not json", "null", answer({ status: "diverged" }), answer({ behind_by: 1 }),
    answer({ merge_base: "c".repeat(40) }), answer({ head: "c".repeat(40) }), answer({ ahead_by: 0 })]) {
    assert.equal(ask(out).risky, true);
  }
  assert.equal(ask(answer(), { headSha: "short" }).risky, true);
});

console.log(`sol-risk-lib: ${passed} passed`);
