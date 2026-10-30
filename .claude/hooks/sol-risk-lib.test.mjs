// Tests for sol-risk-lib.mjs: which pull requests still need Sol (Mason, 2026-10-29).
import assert from "node:assert/strict";
import { classifySolRisk, solRiskOnGitHub, solRiskPathProblem, SOL_LARGE_PR_LINES, SOL_RISK_MAX_FILES } from "./sol-risk-lib.mjs";

let passed = 0;
const check = (name, fn) => { fn(); passed += 1; console.log(`ok - ${name}`); };
const file = (filename, changes = 10, extra = {}) => ({ filename, status: "modified", changes, ...extra });

check("notes files are low risk", () => {
  assert.equal(classifySolRisk([file("docs/plans/product.md"), file("docs/manual/x.md"), file("docs/changelog.d/y.md")]).risky, false);
});
for (const name of [
  // Any code, configuration or asset (Sol, 2026-10-29: name and content rules kept missing real risks).
  "src/components/Label.tsx", "src/lib/units.ts", "src/lib/db.ts", "src/App.tsx", "public/sw.js", "vite.config.ts",
  ".gitignore", "src/lib/invoiceMath.ts", "supabase/migrations/20261029_x.sql", "supabase/functions/send-email/index.ts",
  "docs/plans/diagram.png", "docs/plans/data.json",
  // Agent rules and review machinery, even as notes.
  ".claude/hooks/pr-merge-guard.mjs", ".codex/hooks/x.mjs", ".github/workflows/ci.yml", "scripts/write-codex-push-proof.mjs",
  ".husky/pre-commit", ".agents/x.md", "package.json", "docs/plans/CLAUDE.md", "AGENTS.md", ".coderabbit.yaml", ".Claude/hooks/x.md",
  "docs/workflows/SAFE_DEVELOPMENT_RULES.md", "docs/reference/agent-guardrails.md", "docs/reference/gotchas.md",
  "docs/reference/sql-canonical-patterns.md", "README.md", "docs/x.md", "notes/todo.md",
]) {
  check(`${name} needs Sol`, () => assert.ok(solRiskPathProblem(name)));
}
check("a rename out of a code file needs Sol", () => {
  assert.equal(classifySolRisk([file("docs/plans/x.md", 2, { status: "renamed", previous_filename: "src/lib/invoiceMath.ts" })]).risky, true);
});
check("a rename with no old name needs Sol", () => {
  assert.equal(classifySolRisk([file("docs/plans/x.md", 2, { status: "renamed" })]).risky, true);
});
check(`exactly ${SOL_LARGE_PR_LINES} lines is low risk, one more needs Sol`, () => {
  assert.equal(classifySolRisk([file("docs/plans/a.md", 300), file("docs/plans/b.md", 200)]).risky, false);
  assert.equal(classifySolRisk([file("docs/plans/a.md", 300), file("docs/plans/b.md", 201)]).risky, true);
});
check("unreadable answers need Sol", () => {
  for (const files of [null, [], [null], [file("docs/a.md", 1, { changes: undefined })], [file("docs/a.md", 1, { status: "changed" })],
    Array.from({ length: SOL_RISK_MAX_FILES }, (_, i) => file(`docs/f${i}.md`, 0))]) {
    assert.equal(classifySolRisk(files).risky, true);
  }
});

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const answer = (over = {}) => JSON.stringify({ status: "ahead", ahead_by: 1, behind_by: 0, merge_base: BASE, head: HEAD, files: [file("docs/plans/note.md")], ...over });
// GraphQL file-kind lookup, at the head (d0) and the base (d1): docs/plans holds
// note.md as a plain file, or as `kind`.
const tree = (kind = { mode: 0o100644, type: "blob" }) => {
  const folder = { entries: [{ name: "note.md", ...kind }] };
  return JSON.stringify({ data: { repository: { d0: folder, d1: folder } } });
};
const ask = (stdout, extra = {}, kinds = tree()) => solRiskOnGitHub({ baseSha: BASE, headSha: HEAD, repo: "croprxsolutions/CRX_Manager_V1.0",
  gh: (args) => { if (args[1] === "graphql") return kinds; if (stdout instanceof Error) throw stdout; return stdout; }, ...extra });

check("a clean base..head comparison of a notes file is low risk", () => assert.equal(ask(answer()).risky, false));
check("a symlink, submodule or unreadable file kind at a notes path needs Sol", () => {
  assert.equal(ask(answer(), {}, tree({ mode: 0o120000, type: "blob" })).risky, true);
  assert.equal(ask(answer(), {}, tree({ mode: 0o160000, type: "commit" })).risky, true);
  assert.equal(ask(answer(), {}, "not json").risky, true);
});
check("the comparison is fetched for exactly base...head", () => {
  let seen;
  solRiskOnGitHub({ baseSha: BASE, headSha: HEAD, repo: "o/r", gh: (args) => { seen ??= args; return answer(); } });
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
