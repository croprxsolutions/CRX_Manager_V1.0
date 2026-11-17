// Tests for sol-risk-lib.mjs: which pull requests still need Sol (Mason, 2026-10-30).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  classifySolRisk, GATED_MERGE_BASES, solRiskOnGitHub, solRiskPathProblem, SOL_REQUIRED_PATHS, SOL_RISK_MAX_FILES,
  agentMergeProblem, mainCommitsInPrOnGitHub, prApprovalProblem, releaseFreezeProblem, stagingDestructiveProblem,
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
  for (const head of ["claude/x", "codex/y", "ship/z", "taha/x", "release/nextish", "hotfixes"]) assert.equal(agentMergeProblem("staging", head), null, head);
  for (const head of ["hotfix/x", "release/next"]) assert.match(agentMergeProblem("staging", head), /go into main, not staging/, head);
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
  for (const bad of [new Error("offline"), "not json", j({ status: "ahead", ahead_by: 300, commits: [c("b")] }), j({ status: "ahead", ahead_by: 1 }), j({ status: "weird", ahead_by: 0, commits: [] }), j({ status: "behind", ahead_by: 1, commits: [] }), j({ status: "ahead", ahead_by: 0, commits: [] }), j({ status: "identical", ahead_by: 0, commits: [c("b")] }), j({ status: "behind", ahead_by: 0 })]) {
    assert.ok(ask({ [STAGING]: bad }), `staging call: ${bad}`);
    assert.ok(ask({ [STAGING]: ahead, [HEAD]: bad }), `head call: ${bad}`);
  }
  assert.match(mainCommitsInPrOnGitHub({ stagingSha: "short", headSha: HEAD, repo: "o/r", gh: () => "{}" }), /unusable base commit/, "a bad staging sha fails closed");
  assert.ok(mainCommitsInPrOnGitHub({ stagingSha: STAGING, headSha: "short", repo: "o/r", gh: () => "{}" }), "a bad head sha fails closed");
});

check("agents never approve a pull request (#1838 HIGH 2)", () => {
  for (const t of ["gh pr review 5 --approve", "gh pr review 5 -a", "gh pr review -ab ok 5", "gh api repos/o/r/pulls/5/reviews -f event=APPROVE",
    "gh api repos/o/r/pulls/5/reviews --method POST --input /tmp/review.json", "gh api graphql -F query=@q.graphql -f v='{}' # submitPullRequestReview"]) assert.ok(prApprovalProblem(t), t);
  for (const t of ["gh api repos/o/r/pulls/5/reviews", "gh api repos/o/r/pulls/5/reviews -f event=COMMENT -f body=note",
    "gh api repos/o/r/pulls/5/reviews -f event=COMMENT -f body='Please do not APPROVE this yet'"]) assert.equal(prApprovalProblem(t), null, t);
  for (const t of ["curl -d @body.json https://api.github.com/repos/o/r/pulls/5/reviews", "gh api graphql -F query=@/tmp/approve.graphql",
    "curl --data-binary @q.json https://api.github.com/graphql",
    "gh api repos/o/r/pulls/5/reviews -X POST --input review.json # event=COMMENT"]) assert.ok(prApprovalProblem(t), t);
  for (const t of ["gh pr review 5 --comment -b 'approve later'", "gh pr view 5 --json reviewDecision", "gh pr review 5 -r", "rg APPROVED src/"]) assert.equal(prApprovalProblem(t), null, t);
});

check("staging merges wait while the release is being applied (#1838 MED 2)", () => {
  const gh = (answers) => (args) => { const a = answers.find(([re]) => re.test(args.join(" "))); if (!a) throw new Error(`unexpected ${args.join(" ")}`); if (a[1] instanceof Error) throw a[1]; return a[1]; };
  const list = /pulls\?base=main&state=open/;
  const comments = /issues\/77\/comments/;
  const HEAD = "abcdef123456".padEnd(40, "0");
  const open = `77 ${HEAD}`;
  const c = (login, body) => JSON.stringify({ login, at: "2026-11-19T09:00:00Z", body });
  const run = (answers) => releaseFreezeProblem({ repo: "o/r", gh: gh(answers) });
  assert.equal(run([[list, ""]]), null, "no release PR open");
  assert.equal(run([[list, open], [comments, c("someone", "Staging proof: x")]]), null, "release open, nothing applied yet");
  assert.match(run([[list, open], [comments, c("masonwells1", "note\nApplied live: 20270110100000_x")]]), /#77.*being applied live/);
  assert.match(run([[list, open], [comments, c("TahaKhanAbdalli", "Ready to merge: abcdef123456")]]), /#77/, "Taha's go-ahead for the current head starts the freeze, with no expiry");
  assert.equal(run([[list, open], [comments, c("TahaKhanAbdalli", "Ready to merge: 123456789abc")]]), null, "a go-ahead for an older head freezes nothing");
  assert.equal(run([[list, open], [comments, c("stranger", "Ready to merge: abcdef123456") + "\n" + c("stranger", "Applied live: x")]]), null, "anyone else's text freezes nothing");
  assert.match(run([[list, new Error("HTTP 502")]]), /fail closed/);
  assert.match(run([[list, open], [comments, new Error("HTTP 502")]]), /fail closed/);
  assert.match(run([[list, "77"]]), /fail closed/);
});

check("an agent doesn't merge a destructive migration into staging (#1838 MED 3)", () => {
  const H = "a".repeat(40);
  const b64 = (t) => Buffer.from(t).toString("base64");
  const gh = (files, sql) => (args) => {
    const a = args.join(" ");
    if (/pulls\/5\/files/.test(a)) { if (files instanceof Error) throw files; return files; }
    if (/compare\/b{40}\.\.\.a{40}/.test(a)) return "c".repeat(40);
    if (/git\/trees\//.test(a)) return "t".repeat(40);
    if (/contents\/supabase\/migrations\/x\.sql\?ref=a{40}/.test(a)) { if (sql instanceof Error) throw sql; assert.ok(a.includes("application/vnd.github.raw")); return sql; }
    throw new Error(`unexpected ${a}`);
  };
  const run = (files, sql) => stagingDestructiveProblem({ repo: "o/r", gh: gh(files, sql), number: 5, headSha: H, baseSha: "b".repeat(40) });
  const MIG = "added\tsupabase/migrations/x.sql\t\n";
  assert.equal(run("modified\tsrc/a.ts\t\n", ""), null, "no migration");
  assert.equal(run(MIG, "ALTER TABLE t ADD COLUMN c int;"), null, "an additive migration");
  assert.equal(run("removed\tsupabase/migrations/x.sql\t\n", ""), null, "a removed migration is not read");
  assert.match(run(MIG, "DELETE FROM invoices WHERE true;"), /destructive migration.*x\.sql/);
  assert.match(run(MIG, "DROP TABLE t;"), /DROP TABLE/);
  assert.match(run(new Error("HTTP 502"), ""), /fail closed/);
  assert.match(run(MIG, new Error("HTTP 502")), /fail closed/);
  assert.match(stagingDestructiveProblem({ repo: "o/r", gh: gh("", ""), number: undefined, headSha: H, baseSha: "b".repeat(40) }), /fail closed/);
  assert.match(stagingDestructiveProblem({ repo: "o/r", gh: gh("", ""), number: 5, headSha: H, baseSha: undefined }), /fail closed/, "no base sha");
  assert.match(run(MIG, "   "), /came back empty/);
  assert.match(run("src/a.ts\n", ""), /unreadable file list.*fail closed/, "a list without status and tabs fails closed");
});

check("an agent doesn't merge a .github/ change into staging (Taha, 13 Nov)", () => {
  const gh = (files, trees = {}) => (args) => {
    const a = args.join(" ");
    if (/pulls\/5\/files/.test(a)) return files;
    if (/compare\/b{40}\.\.\.a{40}/.test(a)) { if (trees.base instanceof Error) throw trees.base; return trees.base ?? "c".repeat(40); }
    if (/git\/trees\/a{40}/.test(a)) { assert.ok(a.includes("truncated")); return trees.head ?? "t".repeat(40); }
    if (/git\/trees\/c{40}/.test(a)) { if (trees.old instanceof Error) throw trees.old; return trees.old ?? "t".repeat(40); }
    throw new Error(`unexpected ${a}`);
  };
  const run = (files, trees) => stagingDestructiveProblem({ repo: "o/r", gh: gh(files, trees), number: 5, headSha: "a".repeat(40), baseSha: "b".repeat(40) });
  assert.match(run("modified\t.github/workflows/release-flow.yml\t\n"), /\.github\/workflows\/release-flow\.yml.*Taha merges it, never an agent/);
  assert.match(run("removed\t.github/CODEOWNERS\t\n"), /\.github\/CODEOWNERS/, "a deletion counts");
  assert.match(run("renamed\tdocs/old.yml\t.github/workflows/ci.yml\n"), /\.github\/workflows\/ci\.yml/, "a move out of .github/ counts");
  assert.match(run("modified\tsrc/a.ts\t\nadded\t.github/scripts/x.mjs\t\n"), /\.github\/scripts\/x\.mjs/, "one .github file among others");
  assert.equal(run("modified\tsrc/.github-like.ts\t\nmodified\tdocs/github/a.md\t\n"), null, "only the top-level .github/ folder");
  assert.equal(run("modified\tsrc/a.ts"), null, "trimmed output (no trailing tab) still parses");
  assert.match(run("modified\t.github/x.yml"), /\.github\/x\.yml/, "trimmed output still sees .github/");
  // The file list is capped and not bound to the head, so the .github/ tree at the head is compared with the merge-base's.
  assert.match(run("modified\tsrc/a.ts\t\n", { head: "d".repeat(40) }), /changes \.github\/.*Taha merges it/, "a change the capped list missed");
  assert.match(run("", { head: "", old: "t".repeat(40) }), /changes \.github\//, "deleting the whole folder");
  assert.match(run("", { head: "d".repeat(40), old: "" }), /changes \.github\//, "adding the folder");
  assert.match(run("", { head: "", old: "" }), /not found on either side.*fail closed/, "a missing folder on both sides fails closed");
  assert.match(run("", { old: new Error("truncated") }), /could not be compared.*fail closed/, "a truncated tree fails closed");
  assert.match(run("", { base: "nope" }), /merge-base could not be read.*fail closed/);
  assert.match(run("", { base: new Error("HTTP 502") }), /could not be compared.*fail closed/);
  assert.match(run("", { old: new Error("HTTP 404") }), /could not be compared.*fail closed/);
});

console.log(`sol-risk-lib: ${passed} passed`);
