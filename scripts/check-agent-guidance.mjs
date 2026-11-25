#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findWindowsShellVariableHooks } from "./windows-hook-command.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const checks = [];

function record(ok, name, note = "") {
  checks.push({ ok, name, note });
}

function read(relative) {
  return readFileSync(path.join(ROOT, relative), "utf8");
}

function readChecked(relative) {
  if (!existsSync(path.join(ROOT, relative))) {
    record(false, `${relative} exists`);
    return "";
  }
  return read(relative);
}

const agents = read("AGENTS.md");
const claude = read("CLAUDE.md");
const cursorRules = readChecked(".cursorrules");
const claudeModelTuning = readChecked("docs/reference/claude-model-tuning.md");
const codingGuidelines = readChecked("docs/reference/coding-guidelines.md");
const sqlCanonicalPatterns = readChecked("docs/reference/sql-canonical-patterns.md");
const safeDevelopmentRules = readChecked("docs/workflows/SAFE_DEVELOPMENT_RULES.md");
const quoteToDelivery = readChecked("docs/workflows/QUOTE_TO_DELIVERY.md");
const qaTesting = readChecked("docs/reference/qa-testing.md");
const agentGuardrails = readChecked("docs/reference/agent-guardrails.md");
const wholeCodebaseAudit = readChecked(".claude/workflows/whole-codebase-audit.js");
const preflightWorkflow = readChecked(".claude/commands/preflight.md");
const lifecycleAuditPrompts = [
  wholeCodebaseAudit,
  readChecked(".claude/workflows/overnight-bug-hunt.js"),
  readChecked(".claude/workflows/money-inventory-hunt.js"),
];
const shipWorkflow = readChecked(".claude/commands/ship.md");
// Mason, 2026-11-25 ("fix that guard so we can actually edit"): the safety rules
// are locked word for word in scripts/agent-guidance-locks.json (on the Sol list,
// so changing one needs a Sol review); everything else is pinned by key terms
// inside one paragraph or bullet, plus a tripwire for weakening words. All text
// comparisons ignore case, spacing and curly quotes.
const norm = (text) => String(text).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
const fold = (text) => norm(text).toLowerCase();
const hasAll = (text, terms) => terms.every((term) => fold(text).includes(fold(term)));
// A section runs from its own heading to the next `## ` heading, in any order.
const section = (text, heading) => {
  const part = text.replace(/\r\n/g, "\n").split(/^(?=## )/m).find((p) => p.split("\n")[0].trim() === `## ${heading}`);
  return part ? part.slice(part.indexOf("\n") + 1) : "";
};
// Paragraphs, bullets, numbered items, headings and table rows, folded; code
// fences, indentation and block-quote markers are ignored.
function units(text) {
  const out = [];
  let fence = false;
  let open = false;
  for (const line of String(text).replace(/\r\n/g, "\n").split("\n")) {
    const body = line.replace(/^\s*(?:>\s*)*/, "");
    if (body.startsWith("```")) { fence = !fence; open = false; continue; }
    if (fence || !body.trim()) { open = false; continue; }
    if (open && !/^(?:[-*+] |\d+[a-z]?\. |#{1,6} |\|)/.test(body)) out[out.length - 1] += ` ${body}`;
    else out.push(body);
    open = true;
  }
  return out.map(fold);
}
const unitWith = (text, terms) => units(text).find((unit) => hasAll(unit, terms)) || "";
const routingTable = section(agents, "Start and Route");
const protectedDelivery = section(agents, "Safety and Protected Delivery");
const protectedApprovalBullet = unitWith(protectedDelivery, ["explicit approval in the current conversation", "before"]);
// Mason's autonomous-landing rule (2026-09-26) replaced the armed-only migration
// exception. The merge and apply gates enforce it; since 2026-11-25 its full
// wording lives in ship.md Step 8 (AGENTS.md keeps a summary). The checks below
// pin every condition it attaches, so trimming one out of ship.md fails here.
const autonomousLandingBullet = unitWith(shipWorkflow, ["**Autonomous landing"]);
const routedGuidance = [...new Set(
  [...routingTable.matchAll(/`([^`]+\.(?:md|json))`/g)].map((match) => match[1]),
)];
const requiredRouteRows = [
  ["First session or unfamiliar area", ["docs/manual/AGENT_ONBOARDING.md", "docs/manual/ARCHITECTURE.md"]],
  ["Any code change", ["docs/reference/coding-guidelines.md", "docs/reference/gotchas.md", "docs/workflows/SAFE_DEVELOPMENT_RULES.md"]],
  ["Architecture, hard debugging, workflow/migration tracing, or PR impact", ["graphify"]],
  ["Database, migration, or RLS", ["docs/workflows/DATABASE_CHANGE_CHECKLIST.md", "docs/workflows/RLS_SECURITY_GUIDE.md", ".claude/schema-registry.json"]],
  ["Quote-to-cash or inventory", ["docs/workflows/QUOTE_TO_DELIVERY.md", "docs/workflows/INVENTORY_RULES.md"]],
  ["Frontend/UI", ["docs/workflows/UI_PATTERNS.md"]],
  ["Delegation, agent collaboration, or agent-surface changes", ["docs/workflows/AGENT_COLLABORATION.md", "docs/reference/agent-guardrails.md"]],
  ["Push, PR finalization, merge, release, or a live migration apply", [".claude/commands/ship.md"]],
  ["Settled decisions, known problems, or current status", ["docs/manual/DECISION_LOG.md", "decision-log.d/", "docs/manual/KNOWN_ISSUES.md", "known-issues.d/", "docs/manual/CURRENT_STATE.md"]],
  ["Mason asks how the system or agent process works", ["docs/manual/OWNER_PLAYBOOK.md"]],
];
const routingRows = new Map(
  [...routingTable.matchAll(/^\|\s*([^|\r\n]+?)\s*\|\s*([^|\r\n]+?)\s*\|\s*$/gm)]
    .map((match) => [match[1].trim(), match[2]]),
);
const missingRequiredRoutes = requiredRouteRows.flatMap(([task, paths]) => {
  const row = [...routingRows].find(([label]) => fold(label) === fold(task))?.[1] || "";
  return paths.filter((relative) => !row.includes(`\`${relative}\``)).map((relative) => `${task} -> ${relative}`);
});
const settings = JSON.parse(read(".claude/settings.json"));
const codexHooksText = read(".codex/hooks.json");
const codexHooks = JSON.parse(codexHooksText);
const gitignore = read(".gitignore");
// Git may materialize Markdown with CRLF on Windows even when the canonical
// repository text is LF. Compare content, not checkout-specific line endings.
const migrationDriftReviewer = read(".claude/agents/migration-drift-reviewer.md")
  .replace(/\r\n/g, "\n");
const migrationOrderingLib = read(".claude/hooks/migration-ordering-lib.mjs")
  .replace(/\r\n/g, "\n");
const migrationHistory = read("docs/reference/migration-history.md")
  .replace(/\r\n/g, "\n");
const migrationStampCheck = migrationDriftReviewer.match(
  /### CHECK 6 — Migration filename version-stamp mismatch([\s\S]*?)(?=\n### CHECK 7)/
)?.[1] || "";
const canonicalMigrationStampCheck = `
This is the B7 pattern from 2026-05-26.
1. Extract the timestamp prefix from each filename: \`<YYYYMMDDHHMMSS>_<description>.sql\`.
2. You CANNOT call Supabase MCP (your tools are Read/Grep/Glob/Bash). Do NOT attempt the Supabase MCP \`list_migrations\` tool. Compare the on-disk filename timestamps against each other for ordering sanity, then look for a current orchestrator-recorded \`list_migrations\` preflight in \`docs/reference/migration-history.md\` or the task evidence. Before apply, the disk timestamp must be **strictly greater than the current live effective ordering high-water**. Supabase MCP assigns a fresh live version at apply time, so the pre-apply filename is NOT expected to equal that future value.
3. Build the effective ordering stamp **row by row**, matching the deterministic apply guard: use the 14-digit timestamp embedded in that ledger row's \`name\` when present; only when the row's \`name\` has no 14-digit timestamp, use its 14-digit \`version\` as the conservative fallback. The fallback prevents a timestamp-less legacy name from disappearing from the comparison. Do NOT compare against a bare \`max(version)\` or \`.claude/schema-registry.json\`'s \`_meta.migrations_high_water\`: those version-only figures discard the ledger names, so they cannot tell which rows legitimately need the fallback and can emit a false **HIGH** when the newest applied row has an authored name stamp. \`.claude/hooks/migration-ordering-lib.mjs\` and \`scripts/refresh-applied-migrations.mjs\` are the executable sources for this row-by-row rule; \`docs/reference/migration-history.md\` explains the same calculation in plain English.
4. If no current live effective ordering high-water evidence derived from both \`name\` and fallback \`version\` is available, emit a **MED** finding (it does not block the proofs) saying live ordering was not checked in this review. The deterministic backstop is \`scripts/apply-migration-file.mjs\`: immediately before transmitting, it re-reads the live ledger, applies this same row-by-row rule, and refuses an out-of-order stamp (no live list, no apply). If evidence shows the filename is not greater, emit **HIGH** and require a fresh filename. If current evidence proves it is greater, this check is clean.
5. Always note the post-apply B7 reconciliation requirement: after a successful MCP apply, read the new ledger row's \`version\` and \`name\`, normalize the live name and disk basename with the repository's migration-ordering convention, and update migration history before commit. If the normalized live \`name\` already matches the authored disk basename, keep the disk filename; a differing apply-time \`version\` alone does **not** require a rename. Rename to the MCP-assigned version only when the live \`name\` does not preserve the authored basename, so disk and ledger would otherwise remain unmatched. This is a post-apply obligation, not a pre-apply finding.
`;
function hasImpossiblePreApplyEquality(text) {
  return text.split(/(?<=[.!?])\s+/).some((sentence) => {
    const withoutDirectlyNegatedComparison = sentence.replace(
      /\b(?:(?:not|is not) expected to|must not|not required to)\s+(?:be\s+)?(?:equal|match)\b|\bdoes not match\b|\bnot equal\b/gi,
      ""
    );
    return /(?:before apply(?:ing)?|pre-apply)/i.test(sentence)
      && /(?:equal|match)/i.test(withoutDirectlyNegatedComparison)
      && /(?:Supabase|MCP|future)/i.test(sentence);
  });
}
const impossiblePreApplyEquality = hasImpossiblePreApplyEquality(migrationStampCheck);
const adversarialEqualityRules = [
  "Before applying, require the disk filename to equal the version Supabase will assign.",
  "Before applying, a second review is not required, but the disk filename must equal the future Supabase version.",
];
const validNegativeEqualityRule = "Supabase MCP assigns a fresh live version at apply time, so the pre-apply filename is NOT expected to equal that future value.";

// Budgets are for the committed (LF) text; a Windows CRLF checkout adds a byte per line.
function lfBytes(text) {
  return Buffer.byteLength(text.replace(/\r\n/g, "\n"), "utf8");
}
record(lfBytes("a\r\nb\r\n") === lfBytes("a\nb\n"), "startup-context byte budgets ignore CRLF checkouts");
record(agents.split(/\r?\n/).length <= 90, "AGENTS.md stays lean", `${agents.split(/\r?\n/).length} lines`);
record(lfBytes(agents) <= 12000, "AGENTS.md stays within the startup-context budget", `${lfBytes(agents)} bytes`);
record(claude.split(/\r?\n/).length <= 60, "CLAUDE.md stays lean", `${claude.split(/\r?\n/).length} lines`);
record(lfBytes(claude) <= 6000, "CLAUDE.md stays within the startup-context budget", `${lfBytes(claude)} bytes`);
record(cursorRules.split(/\r?\n/).length <= 15, ".cursorrules stays a lean AGENTS.md router", `${cursorRules.split(/\r?\n/).length} lines`);
record(/AGENTS\.md.*canonical shared contract/i.test(cursorRules), ".cursorrules delegates shared policy to AGENTS.md");
record(!/\b\d{2,5}\s+(?:tables|migrations|pages|tests?|edge functions?)\b/i.test(cursorRules), ".cursorrules has no volatile project counts");
record(claude.trimStart().startsWith("@AGENTS.md"), "CLAUDE.md imports AGENTS.md first");
const ownerCommunication = section(agents, "Owner Communication");
record(ownerCommunication.trim().length > 0, "AGENTS.md defines the owner communication contract");
record(hasAll(ownerCommunication, ["cannot safely review code or diffs"]), "AGENTS.md acknowledges Mason cannot review code or diffs");
record(hasAll(ownerCommunication, ["never have to nudge", "keep moving"]), "owner communication keeps authorized work moving without nudges");
record(hasAll(ownerCommunication, ["what failed", "what it means", "trying next"]), "owner communication makes failures explicit");
// These two markers are literal tokens agents print, so they stay exact.
record(/NEEDS MASON - ACTION REQUIRED[\s\S]*NEEDS MASON - DECISION REQUIRED/.test(ownerCommunication), "owner communication makes genuine stops unmistakable");
// Mason, 2026-10-03: Claude dropped its pre-code approval pause and plans-then-proceeds like Codex.
record(hasAll(agents, ["Codex and Claude", "short plan", "without waiting for approval"]), "plan authority stays explicit for both agents");
// The bans stay in AGENTS.md (standalone PR-comment tasks may never open ship.md);
// ship.md Step 8 carries the full rule, money PRs included.
const coderabbitBullet = unitWith(protectedDelivery, ["CodeRabbit is optional"]);
record(
  hasAll(coderabbitBullet, ["`needs-coderabbit`", "Never post `@coderabbitai`", "unlabelled PR", "never ask Mason to comment, label, or click for CodeRabbit", "fix or refute every comment", "outdated threads never hold a merge"])
    && hasAll(unitWith(shipWorkflow, ["CodeRabbit is optional"]), ["no PR needs a CodeRabbit review", "money PRs included", "`needs-coderabbit` label", "Never post `@coderabbitai`", "never ask Mason"]),
  "CodeRabbit is optional (Mason, 2026-10-29): no PR, money included, needs its review without the needs-coderabbit label; never ask Mason to",
);
// The detailed request rules AGENTS.md points to: timing and the one-retry cap.
const coderabbitRules = readChecked("docs/reference/coderabbit-native-review.md");
record(
  /after the head is frozen and every required check is green/i.test(coderabbitRules)
    && /touches money, invoices, payments, inventory, or costs in any way \(code,\s*(?:>\s*)?database, or workflow; when unsure, it qualifies\)/i.test(coderabbitRules)
    && /review still in progress, wait up to 15 minutes/i.test(coderabbitRules)
    && /remove that from a qualifying PR's\s*(?:>\s*)?title before marking it ready/i.test(coderabbitRules)
    && /rate-limited, wait the time it states/i.test(coderabbitRules)
    && /Post once\s*(?:>\s*)?more only if that head still has no review/i.test(coderabbitRules)
    && /This one retry is part of the same single request/i.test(coderabbitRules)
    && /fresh Sol review[^.]*and one new full review/i.test(coderabbitRules)
    && /If that second try also\s*(?:>\s*)?gets no review, stop and report the PR stuck/i.test(coderabbitRules)
    && /never keep re-posting/i.test(coderabbitRules),
  "CodeRabbit full-review requests wait for a frozen, green head and stop after one retry (Mason, 2026-10-21)",
);
record(
  /Post it to Mason, then proceed without waiting for his confirmation/i.test(shipWorkflow)
    && !/Claude's checkpoint/i.test(shipWorkflow),
  "ship workflow plans then proceeds for Claude and Codex alike",
);
record(hasAll(agents, ["Deliver what was asked", "scope intended", "narrowing, widening, or transforming"]), "shared contract prevents silent scope changes");
record(hasAll(agents, ["Before presenting findings as current", "not behind `origin/main`"]), "reviews and audits require a current checkout");
record(hasAll(agents, ["simplest complete implementation"]), "AGENTS.md requires simple, complete implementations");
record(hasAll(agents, ["clarity, not cleverness"]), "AGENTS.md favors readable code over clever compression");
const hardRules = section(agents, "CRX Hard Rules");
record(hardRules.trim().length > 0, "AGENTS.md retains the CRX hard-rule section");
record(hasAll(hardRules, ["New tables", "Row Level Security", "policies in the same migration"]), "AGENTS.md retains new-table RLS requirements");
record(hasAll(hardRules, ["Mutating RPCs", "`p_idempotency_key text DEFAULT NULL`"]), "AGENTS.md retains mutating-RPC idempotency requirements");
record(hasAll(hardRules, ["Money", "exact whole cents"]), "AGENTS.md retains exact-money requirements");
record(hasAll(hardRules, ["`src/lib/db.ts`", "only Supabase client", "assertRpcResult()", "checkMutationResult()"]), "AGENTS.md retains Supabase client and result-check requirements");
record(hasAll(protectedDelivery, ["never use `--no-verify`", "never push directly to `main`"]), "AGENTS.md retains protected-delivery bans");
const autonomousLandingChecks = [
  ["a clean Sol proof covering the PR", ["clean Sol proof covers the PR"]],
  ["no review asking for changes", ["no review asks for changes"]],
  ["every required check green", ["every required check is green"]],
  ["migrations limited to NON-destructive ones", ["NON-destructive migration"]],
  ["data rewrites and access changes land on the proofs (Mason, 2026-11-11)", ["rewrites and access changes", "2026-11-11"]],
  ["the migration-apply-guard proof gate", ["migration-apply-guard proof gate"]],
  ["both reviewer proofs and a content-bound Sol proof", ["both reviewer proofs", "content-bound Sol proof"]],
  // 24 hours since Mason's 2026-10-29 decision (was 30 minutes); live state is re-checked at apply.
  ["24-hour proof freshness with live re-checks", ["under 24 hours", "ledger, pending set and PR state", "re-checked live at apply time"]],
  ["enforcement by the gates, not prose", ["merge and apply gates enforce it"]],
];
for (const [name, terms] of autonomousLandingChecks) {
  record(hasAll(autonomousLandingBullet, terms), `ship.md autonomous-landing rule requires ${name}`);
}
record(
  hasAll(unitWith(protectedDelivery, ["Autonomous landing"]), ["Codex never merges", "live apply", "to Claude", "into `staging`", "merge gate", "owner hold", "NON-destructive migration", "apply gate", "ship.md` Step 8"]),
  "AGENTS.md keeps the autonomous-landing summary: roles, both gates, the owner hold, and the ship.md Step 8 pointer",
);
record(hasAll(protectedDelivery, [".claude/commands/ship.md"]), "AGENTS.md routes volatile delivery mechanics to the ship workflow");
// Pinned after a 2026-10-03 slimming pass dropped these and a Luna round caught it.
const reviewChainChecks = [
  ["never disabling a gate", ["never bypass, disable, or weaken hooks"]],
  ["pinned reviewer models only", ["pinned models", "never a newer model the gates do not yet accept"]],
  ["the Luna exit bar", ["**Luna**", "no BLOCKER or HIGH remains", "every MED/LOW", "refuted with evidence", "deferral"]],
  ["a Sol review for listed risky merges (Mason, 2026-10-30: once, before the PR)", ["**Sol**", "high-effort review", "inside 24 hours", "PR's head", "money", "inventory", "database", "logins", "docs/reference/sol-required-paths.md"]],
  ["Sol running before the PR opens", ["Sol on the computer, before the PR opens"]],
  ["review fixes staying on the same PR", ["fixes stay on the same PR"]],
];
for (const [name, terms] of reviewChainChecks) {
  record(hasAll(protectedDelivery, terms), `AGENTS.md delivery rules keep ${name}`);
}
record(
  hasAll(unitWith(protectedDelivery, ["Guard-cleanup exception"]), ["naming what still enforces it", "Always kept", "secret protection", "no force-push", "no direct push to `main`", "no `--admin` merges", "CI and status checks", "destructive-migration approval", "migration-apply proof gate", "money and inventory database rules"]),
  "the guard-cleanup exception stays in AGENTS.md with its always-kept list",
);
// Locked safety lines (Mason, 2026-11-25). An AGENTS.md lock must equal a whole
// paragraph or bullet, so a sentence appended to it fails too; a ship.md passage
// must appear inside one paragraph or bullet. The names below are required, so
// emptying the lock file fails as well.
const LOCK_FILE = "scripts/agent-guidance-locks.json";
const REQUIRED_LOCKS = {
  "AGENTS.md": ["priority", "never-bans", "guard-cleanup", "review-chain", "sol", "staging-first", "coderabbit", "autonomous-landing", "owner-approval"],
  ".claude/commands/ship.md": ["autonomous-landing", "sol-base", "coderabbit"],
};
let locks = {};
try {
  locks = JSON.parse(readChecked(LOCK_FILE) || "{}");
} catch (error) {
  record(false, `${LOCK_FILE} is valid JSON`, error.message);
}
const lockedAgentsUnits = new Set();
for (const [file, names] of Object.entries(REQUIRED_LOCKS)) {
  const entry = locks[file] || {};
  const declared = { ...(entry.units || {}), ...(entry.passages || {}) };
  const undeclared = names.filter((name) => typeof declared[name] !== "string" || fold(declared[name]).length < 40);
  record(undeclared.length === 0, `${LOCK_FILE} declares every required ${file} lock`, undeclared.join(", "));
  const fileUnits = units(file === "AGENTS.md" ? agents : readChecked(file));
  for (const [name, text] of Object.entries(entry.units || {})) {
    record(fileUnits.includes(fold(text)), `${file} keeps locked rule "${name}" word for word`);
    if (file === "AGENTS.md") lockedAgentsUnits.add(fold(text));
  }
  for (const [name, text] of Object.entries(entry.passages || {})) {
    record(fileUnits.some((unit) => unit.includes(fold(text))), `${file} keeps locked passage "${name}" word for word`);
  }
}
// Key terms cannot tell "needs approval" from "approval is optional", so an
// unlocked AGENTS.md rule may not carry a weakening word (routing rows excepted).
const WEAKENERS = /\b(?:optional|advisory|no longer|need not|needs no|not required|preferred|ideally|if convenient|best[- ]effort|at (?:your|their|its|his) discretion|(?:may|can) (?:skip|ignore|waive))\b/;
const weakenedRules = units(agents).filter((unit) => !lockedAgentsUnits.has(unit) && !unit.startsWith("|") && WEAKENERS.test(unit));
record(weakenedRules.length === 0, "unlocked AGENTS.md rules carry no weakening words (optional, advisory, need not…)", weakenedRules.map((unit) => unit.slice(0, 70)).join("; "));
const tripwireSamples = ["- New tables: Row Level Security optional.", "- The Luna review is advisory.", "- Proofs under 24 hours are preferred."];
record(tripwireSamples.every((sample) => WEAKENERS.test(fold(sample))) && !WEAKENERS.test(fold(agents.match(/^- Mason cannot.*$/m)?.[0] || "x")), "weakening-word tripwire catches its samples and passes a plain rule");
// Mason, 2026-11-25: with wording unfrozen, a renamed or moved heading is the real risk.
// Every "AGENTS.md › <name>" citation (also written "`AGENTS.md` › <name>", possibly
// wrapped onto the next line) in a tracked text file must name a whole `## ` heading
// or bold bullet label in AGENTS.md (historical changelog entries excepted).
const agentsAnchors = [
  ...[...agents.matchAll(/^## (.+?)\s*$/gm)].map((match) => match[1]),
  ...[...agents.matchAll(/^- \*\*([^*]+?)[.:]?\*\*/gm)].map((match) => match[1]),
].map(fold);
function citationProblem(citedText) {
  const cited = norm(citedText.replace(/\\[nrt]/g, " ").replace(/\r?\n\s*(?:\/\/|#|\*|>)?/g, " "));
  const anchor = agentsAnchors.filter((name) => cited.toLowerCase().startsWith(name)).sort((a, b) => b.length - a.length)[0];
  // "Sol Proof Exceptions" is not "Sol": the cited name must end where the anchor does.
  if (anchor !== undefined && !/^(?:[A-Za-z0-9]| [A-Z][a-z])/.test(cited.slice(anchor.length))) return "";
  return cited.split(" ").slice(0, 4).join(" ");
}
record(
  citationProblem("Safety and Protected Delivery).") === "" && citationProblem("Safety\n  and Protected Delivery") === ""
    && citationProblem("Sol Proof Exceptions") !== "" && citationProblem("Operating Contracts") !== "",
  "the citation matcher accepts whole and wrapped headings and refuses longer names",
);
const listing = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const trackedFiles = listing.status === 0 ? listing.stdout.split("\0").filter(Boolean) : [];
record(trackedFiles.length > 100, "git lists the tracked files for the citation check", listing.status === 0 ? `${trackedFiles.length} files` : String(listing.stderr || listing.error).slice(0, 160));
const brokenCitations = [];
for (const relative of trackedFiles) {
  if (/(?:^|\/)(?:changelog\.d|CHANGELOG)/.test(relative) || relative === "scripts/check-agent-guidance.mjs") continue;
  const full = path.join(ROOT, relative);
  if (!existsSync(full)) continue;
  const bytes = readFileSync(full);
  if (bytes.length > 4_000_000 || bytes.includes(0)) continue;
  for (const match of bytes.toString("utf8").matchAll(/AGENTS\.md`?[ \t]*›[ \t]*([^\r\n]{0,80}(?:\r?\n[^\r\n]{0,80})?)/g)) {
    const problem = citationProblem(match[1]);
    if (problem) brokenCitations.push(`${relative}: AGENTS.md › ${problem}`);
  }
}
record(brokenCitations.length === 0, "every AGENTS.md › section citation names a heading or bold rule that exists", brokenCitations.join("; "));
record(/docs\/workflows\/SAFE_DEVELOPMENT_RULES\.md/.test(agents), "AGENTS.md routes detailed engineering rules on demand");
record(/docs\/workflows\/AGENT_COLLABORATION\.md/.test(agents), "AGENTS.md routes collaboration details on demand");
record(/Delegation, agent collaboration, or agent-surface changes/i.test(agents), "AGENTS.md routes delegation guidance on demand");
record(/docs\/reference\/claude-model-tuning\.md/.test(claude), "CLAUDE.md routes model tuning on demand");
const missingGuidance = routedGuidance.filter((relative) => !existsSync(path.join(ROOT, relative)));
record(missingRequiredRoutes.length === 0, "AGENTS.md retains every required task/path route", missingRequiredRoutes.join(", "));
record(missingGuidance.length === 0, "every path in the AGENTS.md routing table resolves", missingGuidance.join(", "));
record(
  existsSync(path.join(ROOT, ".claude/skills/graphify/SKILL.md")) &&
    existsSync(path.join(ROOT, ".agents/skills/graphify/SKILL.md")),
  "AGENTS.md graphify route resolves for Claude and Codex",
);
record(!/\b\d{2,5}\s+(?:migrations|pages|edge functions?)\b/i.test(agents), "AGENTS.md has no volatile project counts");
record(!/\b\d{2,5}\s+(?:migrations|pages|edge functions?)\b/i.test(claude), "CLAUDE.md has no volatile project counts");
record(/AGENTS\.md.*canonical shared (?:project )?contract/i.test(claude), "CLAUDE.md declares AGENTS.md canonical");
record(/explicit approval in the current conversation/i.test(protectedApprovalBullet), "AGENTS.md defines the current-conversation approval sentence");
const protectedActionChecks = [
  ["force-pushing", /force-pushing/i],
  ["applying a destructive migration", /applying a DESTRUCTIVE migration/i],
  ["changing live data", /changing live data/i],
  ["deploying an Edge Function", /deploying an Edge Function/i],
  ["out-of-band production changes", /out-of-band production change/i],
  ["deleting data", /deleting data/i],
  ["changing secrets", /changing secrets/i],
  ["authentication changes", /authentication/i],
  ["permission changes", /permissions/i],
  ["billing changes", /billing/i],
  ["domain changes", /domains/i],
  ["ownership changes", /ownership/i],
];
for (const [name, pattern] of protectedActionChecks) {
  record(pattern.test(protectedApprovalBullet), `AGENTS.md approval sentence protects ${name}`);
}
const alwaysLoadedGuidance = `${agents}\n${claude}\n${cursorRules}`;
record(!/VERDICT\s*:/i.test(alwaysLoadedGuidance), "always-loaded guidance contains no review-proof verdict label");
record(/Reviewer prompts must request every correctness, safety, and scope finding/i.test(claudeModelTuning), "Claude reviewer prompts retain the uncapped-finding default");
record(/Never lower effort on a money, RLS, or migration path to save tokens/i.test(claudeModelTuning), "Claude tuning preserves the high-risk effort floor");
record(/newer models \(Opus 5\.5, Fable 5\.1\) remains provisional but binding[\s\S]*must not treat this guidance as Opus-only or skip it/i.test(claudeModelTuning), "Claude model tuning remains binding for newer Opus and Fable models until superseded");
const codexModelTuning = readChecked("docs/reference/codex-model-tuning.md");
record(/Never lower effort on a money, RLS, or migration path to save tokens/i.test(codexModelTuning), "Codex tuning preserves the high-risk effort floor");
record(/Never run a Luna round through `scripts\/write-codex-push-proof\.mjs`/.test(codexModelTuning), "Codex tuning keeps Luna out of the proof wrapper");
record(/docs\/reference\/codex-model-tuning\.md/.test(agents), "AGENTS.md routes Codex model choice on demand");
record(
  /normal helper use requires no exemption marker/i.test(sqlCanonicalPatterns) &&
    !/When using helpers,\s+add[^\n]*idempotency-body-check:\s*exempt/i.test(sqlCanonicalPatterns),
  "canonical SQL guidance does not disable idempotency checks for normal helper use",
);
record(
  lifecycleAuditPrompts.every((prompt) => /For all nine entities, compare every status written by current source against the live CHECK constraints in pg_constraint/i.test(prompt)),
  "every lifecycle audit compares all nine entities with live CHECK constraints",
);
record(
  /enum: \['VERIFIED', 'REFUTED', 'UNVERIFIED'\]/.test(wholeCodebaseAudit)
    && /Uncertainty is UNVERIFIED, never REFUTED or FALSE_POSITIVE/.test(wholeCodebaseAudit)
    && /review\.executionStatus === 'VERIFIED'/.test(wholeCodebaseAudit)
    && /isNonEmptyString\(review\.evidenceSummary\)/.test(wholeCodebaseAudit)
    && /unverified: unverified\.length/.test(wholeCodebaseAudit),
  "whole-codebase audit preserves incomplete evidence as UNVERIFIED",
);
record(
  /closed_by_application/.test(quoteToDelivery) && /closed_short/.test(quoteToDelivery),
  "quote workflow documents every live terminal status",
);
record(
  /_enforce_quote_status_transition\(\)` is authoritative/.test(quoteToDelivery)
    && /`draft` \| `sent`, `cancelled`/.test(quoteToDelivery)
    && /closed_short` has an additional safety condition[\s\S]*BOOKING_HAS_ACTIVE_JOBS/.test(quoteToDelivery)
    && /\*\*cancelled\*\*: Quote was cancelled/.test(quoteToDelivery),
  "quote workflow preserves the authoritative transition map and terminal descriptions",
);
record(
  /under `tests\/e2e\/`/.test(qaTesting) && /docs\/reference\/qa-testing\.md/.test(codingGuidelines),
  "QA reference points to the real E2E directory and is reachable from routed guidance",
);
record(
  /Audit the Edge Functions in supabase\/functions \(create-user, epa-lookup, process-blend-ticket, process-document, reset-user-password, send-email, setup-blend-tickets-storage\)/.test(wholeCodebaseAudit)
    && /Hunt EDGE FUNCTIONS in supabase\/functions \(create-user, epa-lookup, process-blend-ticket, process-document, reset-user-password, send-email, setup-blend-tickets-storage\)/.test(lifecycleAuditPrompts[1]),
  "whole-codebase and overnight edge-function audits include epa-lookup",
);
record(/`… \\\| sl`/.test(agentGuardrails), "agent-guardrails table escapes its shell-pipe example");
record(/DECISION_LOG\.md[\s\S]*settled design choice[\s\S]*KNOWN_ISSUES\.md[\s\S]*problem is new/i.test(codingGuidelines), "every code change checks settled decisions and known issues");
record(/^Read this before any multi-file, data, money, security, permission, production, migration, or customer-facing change\./m.test(safeDevelopmentRules), "safe-development trigger matches the lean routing table");
record(
  /LEDGER_REQUIRED=true[\s\S]*new `supabase\/migrations\/\*\.sql` file[\s\S]*If `LEDGER_REQUIRED` is true/.test(preflightWorkflow)
    && /docs\/reference\/migration-history\.md/.test(preflightWorkflow),
  "preflight ledger guidance matches migration enforcement",
);
record(/mergeStateStatus[\s\S]*known-stale protection sub-resource/i.test(shipWorkflow), "ship workflow uses behavioral PR mergeability evidence");
record(migrationStampCheck.trim() === canonicalMigrationStampCheck.trim(), "migration drift reviewer B7 check matches the canonical fail-closed contract");
record(/Before apply, the disk timestamp must be \*\*strictly greater than the current live effective ordering high-water\*\*/i.test(migrationStampCheck), "migration drift reviewer checks disk timestamp above live effective ordering high-water");
record(/If no current live effective ordering high-water evidence derived from both `name` and fallback `version` is available, emit a \*\*MED\*\*[\s\S]*?`scripts\/apply-migration-file\.mjs`[\s\S]*?refuses an out-of-order stamp/i.test(migrationStampCheck), "migration drift reviewer notes missing live evidence and names the apply-time ordering backstop");
record(/If evidence shows the filename is not greater, emit \*\*HIGH\*\* and require a fresh filename/i.test(migrationStampCheck), "migration drift reviewer rejects stale or colliding timestamps");
record(/NOT expected to equal that future value/i.test(migrationStampCheck), "migration drift reviewer rejects unknowable pre-apply equality");
// Added 2026-08-24 after CHECK 6 used a bare max(version) and emitted a false
// HIGH, then tightened after exact-SHA review caught the opposite edge case:
// timestamp-less legacy names still need their row's version as a conservative
// fallback. Pin both halves of the deterministic row-by-row rule.
record(/use the 14-digit timestamp embedded in that ledger row's `name` when present/i.test(migrationStampCheck), "migration drift reviewer prefers each ledger row's authored name stamp");
record(/only when the row's `name` has no 14-digit timestamp, use its 14-digit `version` as the conservative fallback/i.test(migrationStampCheck), "migration drift reviewer preserves the version fallback for timestamp-less names");
record(/Do NOT compare against a bare `max\(version\)` or `.claude\/schema-registry\.json`'s `_meta\.migrations_high_water`/i.test(migrationStampCheck), "migration drift reviewer rejects version-only aggregate ordering evidence");
record(/migration-ordering-lib\.mjs` and `scripts\/refresh-applied-migrations\.mjs` are the executable sources/i.test(migrationStampCheck), "migration drift reviewer cites the executable row-by-row ordering sources");
record(!/session-staleness\.mjs[\s\S]*document the same row-by-row rule/i.test(migrationStampCheck), "migration drift reviewer does not miscite the schema-registry staleness heuristic");
record(/synthesizes `<version>_<name>`[\s\S]*effective stamp/i.test(migrationOrderingLib), "migration ordering library documents the timestamp-less-name fallback");
record(/derives an effective stamp row by row:[\s\S]*otherwise use that row's 14-digit `version`/i.test(migrationHistory), "migration history documents the row-by-row effective ordering high-water");
record(/A bare `max\(version\)` is never the ordering high-water/i.test(migrationHistory), "migration history rejects version-only aggregate ordering evidence");
record(!impossiblePreApplyEquality, "migration drift reviewer contains no affirmative pre-apply future-version equality rule");
record(adversarialEqualityRules.every(hasImpossiblePreApplyEquality), "migration drift reviewer equality detector rejects adversarial affirmative rules");
record(!hasImpossiblePreApplyEquality(validNegativeEqualityRule), "migration drift reviewer equality detector permits direct negation");
record(/after a successful MCP apply, read the new ledger row's `version` and `name`/i.test(migrationStampCheck), "migration drift reviewer requires a fresh post-apply ledger read");
record(/If the normalized live `name` already matches the authored disk basename, keep the disk filename/i.test(migrationStampCheck), "migration drift reviewer preserves an authored filename that matches the live name");
record(/a differing apply-time `version` alone does \*\*not\*\* require a rename/i.test(migrationStampCheck), "migration drift reviewer does not manufacture drift from version-name divergence");
record(/Rename to the MCP-assigned version only when the live `name` does not preserve the authored basename/i.test(migrationStampCheck), "migration drift reviewer retains the conditional B7 rename fallback");

// Added 2026-09-04. CHECK 2's METHOD paragraph is the whole of this branch's
// charter change: the local search is mandatory, and remote per-file history
// enumeration is forbidden because two real runs died after 598 and 751
// fetch_blob calls with no verdict at all.
//
// REVISED 2026-09-04 after CodeRabbit on PR #594. The method was first written
// as a SINGLE name-level pass ("ideally ONE grep -rnoiE"), which cannot answer
// the rule it is attached to: -o prints only the matched name, discarding the
// argument list and any preceding DROP FUNCTION, and steps 2-3 consume exactly
// those. It also said "do NOT read migration files one at a time", which
// outlawed the follow-up read that recovers them. The method is now two-phase —
// A discovers candidates, B reads their full declarations — so pin BOTH phases
// AND the sentence that denies phase A the verdict. Pinning phase A alone would
// be satisfied by the very defect this revision fixes.
//
// DEFERRED (Mason, 2026-09-04): the overload-EVIDENCE question — what live
// catalog proof may acquit a history-detected collision, and how the sandboxed
// proof runner could ever supply it — is a separate task with its own plan.
// See docs/manual/KNOWN_ISSUES.md.
// The charter hard-wraps its prose, so match against whitespace-flattened text.
const overloadCollisionCheck = migrationDriftReviewer.match(
  /### CHECK 2 — Function overload collision([\s\S]*?)(?=\n### CHECK 3)/
)?.[1] || "";
const overloadCollisionFlat = overloadCollisionCheck.replace(/\s+/g, " ");
record(overloadCollisionFlat.trim().length > 0, "migration drift reviewer CHECK 2 block is extractable");
record(/Answer this check in TWO bounded local phases/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps the two-phase bounded local method");
record(/PHASE A — discovery\.\* ONE local `grep -rniE` over `supabase\/migrations\/` covering every function name in this migration at once/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps the one-pass discovery phase");
record(/\*\*A name-level match does NOT decide this check\*\*/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 denies the discovery pass the verdict");
record(/`-o` in particular prints only the matched text, discarding both the argument list and any preceding `DROP FUNCTION`/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 names why a name-only grep is insufficient");
record(/Clearing CHECK 2 on phase A alone is a false clean/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 labels a phase-A-only clear a false clean");
record(/PHASE B — read the candidates\.\* For every file phase A named, read the full `CREATE OR REPLACE FUNCTION` declaration: its complete argument list, and whether a `DROP FUNCTION` for that name precedes it in the same migration/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 requires reading each candidate's full declaration");
record(/Phase B is bounded by the NUMBER OF MATCHES/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps phase B bounded by match count");
record(/forbids walking the corpus, never reading the specific files phase A identified/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 scopes the prohibition to corpus walking, not candidate reads");
record(/do NOT use any remote\/GitHub file-reading tool \(`fetch_blob` or similar\) to enumerate history/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 forbids remote per-file history enumeration");
record(/the local one-pass grep answered PHASE A in 0\.17 s, where the per-file remote walk died twice — after 598 and 751 fetches — with no verdict at all/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 keeps the measurement that justifies the method");
record(/If a previous definition with DIFFERENT argument types exists AND the new migration does NOT first `DROP FUNCTION` the old one, severity = \*\*BLOCKER\*\*/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 retains the differing-argument BLOCKER");
record(/Postgres allows multiple overloads; the bug is when the caller expects to resolve to one but hits the other/.test(overloadCollisionFlat), "migration drift reviewer CHECK 2 retains the caller-resolution rationale");

const allow = new Set(settings.permissions?.allow || []);
const ask = new Set(settings.permissions?.ask || []);
// Mason's decision 2026-07-11 (re-affirming 2026-07-05): no permission popups for
// push / SQL / migrations — the deterministic hooks (codex-push-guard,
// live-testdata-guard DDL block, migration-apply-guard proof file) are the real
// gate, plus his explicit OK in chat per AGENTS.md. These must be auto-allowed
// so the popup never returns, and must never fall into ask/deny silently.
const hookGated = [
  "Bash(git push:*)",
  "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__execute_sql",
  "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__apply_migration",
  "mcp__supabase__execute_sql",
  "mcp__supabase__apply_migration",
  "mcp__claude_ai_Supabase__execute_sql",
  "mcp__claude_ai_Supabase__apply_migration",
];
for (const permission of hookGated) {
  record(allow.has(permission), `${permission} is auto-allowed (deterministic hook is the gate)`);
  record(!ask.has(permission), `${permission} does not prompt`);
}
// Edge-function deploys have no deterministic hook backstop — they keep the popup.
const mustAsk = [
  "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__deploy_edge_function",
  "mcp__supabase__deploy_edge_function",
  "mcp__claude_ai_Supabase__deploy_edge_function",
];
for (const permission of mustAsk) {
  record(!allow.has(permission), `${permission} is not auto-allowed`);
  record(ask.has(permission), `${permission} requires approval`);
}

// Mason's choice "A" (2026-09-26, DECISION_LOG): a file keeps its Edit/Write `ask`
// prompt when an UNCOMMITTED local edit to it could change what reaches
// production before any PR review sees it. That set is derived here, not listed
// by hand, so it cannot drift: every hook that gates a tool EXECUTION (a
// PreToolUse group whose matcher covers Bash, PowerShell, MCP or "*" — not the
// write-time content checks, whose output still goes through PR review) in
// either manifest, the Codex adapter every Codex hook runs through, the two
// proof writers, the private-artifact containment check the git hooks run, and
// every repository module any of them loads. Reviewers found each gap in turn:
// Sol (merge guard, helper modules, containment check) and the Codex GitHub App
// (the live-data MCP guards).
function executionGuardRefs(manifest) {
  const refs = new Set();
  for (const group of manifest?.hooks?.PreToolUse || []) {
    const matcher = String(group?.matcher ?? "*");
    const writeOnly = matcher.split("|").every((part) => /^(Write|Edit|MultiEdit|NotebookEdit|apply_patch)$/.test(part.trim()));
    if (writeOnly) continue;
    for (const match of JSON.stringify(group?.hooks || []).matchAll(/(\.claude|\.codex)[\\/]{1,2}hooks[\\/]{1,2}([\w.-]+\.mjs)/g)) {
      refs.add(`${match[1]}/hooks/${match[2]}`);
    }
  }
  return refs;
}
const productionGateRoots = new Set([
  ...executionGuardRefs(settings),
  ...executionGuardRefs(codexHooks),
  ".codex/hooks/codex-hook-adapter.mjs",
  "scripts/write-codex-push-proof.mjs",
  "scripts/write-apply-proofs.mjs",
  // Writes the Claude-review proof (Sol, 2026-09-27): no merge gate consumes it
  // today, but a proof writer is exactly the kind of file whose local edit acts
  // before review.
  "scripts/run-claude-review.mjs",
  "scripts/check-supplier-pricing-phase3-private-artifacts.mjs",
]);
record(productionGateRoots.has(".claude/hooks/pr-merge-guard.mjs") && productionGateRoots.has(".codex/hooks/production-action-guard.mjs"), "production-gate roots are derived from the hook manifests", [...productionGateRoots].join(", "));
// Static imports, re-exports, literal dynamic imports, and literal relative
// script paths (child scripts a gate launches).
const GATE_IMPORT_RE = /(?:import\s[^'"]*?from\s*|export\s[^'"]*?from\s*|import\s*\(\s*|import\s*)["'](\.{1,2}\/[^"']+)["']/g;
const GATE_SCRIPT_PATH_RE = /["'](\.{1,2}\/[^"']+\.(?:mjs|cjs|js))["']/g;
const gateClosure = new Set();
const gateQueue = [...productionGateRoots];
while (gateQueue.length) {
  const relative = gateQueue.shift();
  if (gateClosure.has(relative)) continue;
  gateClosure.add(relative);
  const text = readChecked(relative);
  for (const pattern of [GATE_IMPORT_RE, GATE_SCRIPT_PATH_RE]) {
    for (const match of text.matchAll(pattern)) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
      if (!target.startsWith("..") && /\.(mjs|cjs|js)$/.test(target)) gateQueue.push(target);
    }
  }
}
// REVERSED by Mason, 2026-10-18 ("Change permissions to not always prompt me
// allow it"; DECISION_LOG): the Edit/Write prompts on these files are removed.
// What still stands between an edit and production: the review-proof guard
// refuses SHELL writes to every one of them except `package.json` (guarding it
// breaks installs and merges; the proof minters joined that guard in PR #974),
// Edit/Write stay visible in the transcript, and nothing reaches main without
// the PR path. Pin the reversal so
// a prompt is not silently re-added without a decision, and so the derived set
// keeps being computed (it documents what an unreviewed local edit could reach).
const promptedGateFiles = [...gateClosure]
  .filter((relative) => ask.has(`Edit(${relative})`) || ask.has(`Write(${relative})`))
  .sort();
// Any Edit/Write ask entry at all, wildcard included (`Edit(.claude/hooks/**)`),
// would quietly restore a prompt, so none may remain (CodeRabbit, PR #956).
const editWriteAsk = [...ask].filter((rule) => /^(?:Edit|Write|MultiEdit|NotebookEdit)\(/.test(rule)).sort();
record(editWriteAsk.length === 0, "no Edit/Write ask entries remain (Mason, 2026-10-18)", editWriteAsk.join(", "));
record(
  gateClosure.size > 0 && promptedGateFiles.length === 0,
  `production-gate files are edited without an ask prompt (Mason, 2026-10-18; ${gateClosure.size} files)`,
  promptedGateFiles.join(", "),
);
for (const pattern of [".codex/hooks.json", ".github/workflows/**", ".husky/**", "package.json", ".claude/settings.json", ".claude/settings.local.json"]) {
  record(!ask.has(`Edit(${pattern})`) && !ask.has(`Write(${pattern})`), `${pattern} is edited without an ask prompt (Mason, 2026-10-18)`);
}

const allHooks = Object.values(codexHooks.hooks || {})
  .flatMap((entries) => entries)
  .flatMap((entry) => entry.hooks || [])
  .filter((hook) => hook.type === "command");
record(!/C:\\\\CRX_Manager/i.test(codexHooksText), ".codex/hooks.json has no hard-coded checkout path");
record(allHooks.length > 0 && allHooks.every((hook) => hook.command && hook.commandWindows), "every Codex command hook has POSIX and Windows commands", `${allHooks.length} hooks`);
// A `commandWindows` string is run through a PowerShell parent, which expands
// any `$…` before the inner PowerShell parses it — the 2026-07-28 fail-open.
// Rationale and the full list of rejected forms: scripts/windows-hook-command.mjs.
const windowsVarHooks = findWindowsShellVariableHooks(allHooks);
record(windowsVarHooks.length === 0, "no Codex Windows hook command interpolates a shell variable", windowsVarHooks.length ? `${windowsVarHooks.length} hook(s) use a $variable` : `${allHooks.length} hooks clean`);
record(codexHooksText.includes(".claude/hooks/sql-safety.mjs"), "Codex invokes shared Claude hook sources");
record(codexHooksText.includes("production-action-guard.mjs"), "Codex production action guard is registered");
record(codexHooksText.includes("review-proof-guard.mjs"), "Codex review proof guard is registered");
record(!gitignore.split(/\r?\n/).some((line) => line.trim() === ".agents/" || line.trim() === ".codex/"), "tracked agent configuration is not blanket-ignored");
// Scope to the [mcp_servers.supabase] url line, parsed line-by-line so a
// commented heading, a commented url, a backup_url key, or a url in a later
// TOML table can never satisfy the check; the read_only flag is matched at
// query-parameter boundaries so read_only=false0 / other_read_only=false fail.
let codexSupabaseUrl = "";
{
  let inSupabase = false;
  for (const line of read(".codex/config.toml").split(/\r?\n/)) {
    const heading = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (heading) { inSupabase = heading[1].trim() === "mcp_servers.supabase"; continue; }
    if (!inSupabase) continue;
    const url = line.match(/^\s*url\s*=\s*"([^"]+)"\s*(?:#.*)?$/);
    if (url) { codexSupabaseUrl = url[1]; break; }
  }
}
record(
  /[?&]read_only=false(?:&|$)/.test(codexSupabaseUrl) && !/[?&]read_only=true(?:&|$)/.test(codexSupabaseUrl),
  "Codex Supabase MCP url declares write access (Mason approved 2026-08-14)",
);

const sync = spawnSync(process.execPath, [path.join(ROOT, "scripts", "sync-agent-workflows.mjs"), "--check"], {
  cwd: ROOT,
  encoding: "utf8",
});
record(sync.status === 0, "Codex workflow adapters match Claude sources", (sync.stdout || sync.stderr).trim().split(/\r?\n/)[0] || "no output");

console.log("check-agent-guidance");
for (const item of checks) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name}${item.note ? ` - ${item.note}` : ""}`);
const failed = checks.filter((item) => !item.ok);
if (failed.length > 0) {
  console.log(`FAIL - ${failed.length} agent guidance check(s) failed.`);
  process.exit(1);
}
console.log("PASS - shared agent guidance and deterministic guards are aligned.");
