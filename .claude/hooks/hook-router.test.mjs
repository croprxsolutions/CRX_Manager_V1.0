#!/usr/bin/env node

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promptModulesFor } from "./prompt-router.mjs";
import { postToolModulesFor } from "./posttool-router.mjs";
import { dirtyWarning, pushDir, pushTargets } from "./post-push-dirty-warning.mjs";
import { dedupeContextBlocks } from "./hook-router-runtime.mjs";
import { askTahaAfterSol, ghCommandCwd, githubAncestry, laterSolRisk, proofReader, readyTarget, solCoversHead } from "./taha-ready-after-sol.mjs";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";

const ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const PROMPT = path.join(ROOT, ".claude", "hooks", "prompt-router.mjs");
const POST = path.join(ROOT, ".claude", "hooks", "posttool-router.mjs");
let pass = 0;
const ok = (condition, message) => { assert.ok(condition, message); pass++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); pass++; };

function run(script, payload, { surface = "claude", projectDir } = {}) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir || ROOT };
  if (surface === "codex") env.CRX_AGENT_SURFACE = "codex";
  else delete env.CRX_AGENT_SURFACE;
  const result = spawnSync(process.execPath, [script], {
    cwd: ROOT,
    env,
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  eq(result.status, 0, `${path.basename(script)} exits zero: ${result.stderr}`);
  return result.stdout.trim() ? JSON.parse(result.stdout) : null;
}

// The ship reminder is gone (Mason, 2026-10-29): an ordinary build request adds no context.
{
  const output = run(PROMPT, { prompt: "implement this fix" }, { projectDir: tempDir("crx-router-ship-") });
  ok(!output?.hookSpecificOutput?.additionalContext?.includes("Ship-It reminder"), "prompt router no longer adds the Ship-It reminder");
}
// Unwired 2026-10-02 (Mason): these prompts no longer inject their reminders.
for (const [prompt, marker] of [
  ["drop this migration", "DELETE/DROP MIGRATION"],
  ["review this code", "Codex Review Gauntlet"],
  ["have claude and codex review this code", "Agent Pair Review"],
  ["ask claude to review the codex work", "Codex-to-Claude Handoff/Review"],
]) {
  const output = run(PROMPT, { prompt });
  ok(!String(output?.hookSpecificOutput?.additionalContext || "").includes(marker), `prompt router no longer injects ${marker}`);
}

// The landing policy is no longer injected per prompt: it lived only in the ship
// reminder, removed 2026-10-29, and AGENTS.md (loaded every session) states it.
// The dedupe helper stays for any future module that embeds it.
{
  const shipOnly = run(PROMPT, { prompt: "implement this fix" }, { projectDir: tempDir("crx-router-policy-") });
  ok(!String(shipOnly?.hookSpecificOutput?.additionalContext || "").includes("LANDING POLICY"), "an ordinary prompt no longer carries the landing policy");
  // Pure helper, mutation-pinned: only an exact whole-block repeat is replaced.
  eq(dedupeContextBlocks(["A\n\nPOLICY\n\nB", "C\n\nPOLICY"], [{ text: "POLICY", replacement: "P2" }]), ["A\n\nPOLICY\n\nB", "C\n\nP2"], "second occurrence replaced, first kept");
  eq(dedupeContextBlocks(["POLICY-ish", "POLICY"], [{ text: "POLICY", replacement: "P2" }]), ["POLICY-ish", "P2"], "a superstring counts as carrying the block (exact substring match)");
  eq(dedupeContextBlocks(["A", "B"], [{ text: "POLICY", replacement: "P2" }]), ["A", "B"], "contexts without the block are untouched");
  eq(dedupeContextBlocks(["A\n\nPOLICY", "B\n\nPOLICY"], []), ["A\n\nPOLICY", "B\n\nPOLICY"], "no blocks configured → no rewriting");
  // A context in which nothing was replaced comes back byte-for-byte — leading
  // and trailing whitespace and runs of blank lines included (CodeRabbit review
  // of #613 at ebebfc34d: the first cut trimmed and collapsed every context).
  const untouched = "  lead\n\n\n\nmiddle\n\n\ntrail  \n";
  eq(dedupeContextBlocks([untouched], []), [untouched], "no blocks configured → whitespace preserved exactly");
  eq(dedupeContextBlocks([untouched], [{ text: "POLICY", replacement: "P2" }]), [untouched], "block configured but absent → whitespace preserved exactly");
  eq(dedupeContextBlocks([`${untouched}POLICY`], [{ text: "POLICY", replacement: "P2" }]), [`${untouched}POLICY`], "first occurrence kept → whitespace preserved exactly");
  // Only the rewritten context is normalised, and only after the replacement.
  eq(dedupeContextBlocks(["POLICY", `${untouched}POLICY\n\n\n`], [{ text: "POLICY", replacement: "P2" }]), ["POLICY", "lead\n\nmiddle\n\ntrail  \nP2"], "the replaced context is trimmed and its blank-line runs collapsed");
}

const temp = tempDir("crx-hook-router-");
try {
  // The stop-word hold latch was removed (Mason, 2026-10-29: "if i want to stop i
  // just hit the stop button"): a typed stop adds no context and writes no latch.
  let output = run(PROMPT, { prompt: "pause now", session_id: "router-1" }, { projectDir: temp });
  ok(!String(output?.hookSpecificOutput?.additionalContext || "").includes("HOLD LATCHED"), "a typed stop no longer latches a hold");
  ok(!existsSync(path.join(temp, ".claude", "session-state", "hold-router-1.json")), "no hold file is written");

  // The autopilot reminder was unwired on 2026-10-02 (Mason), so a hands-free
  // request neither reminds nor writes the OVERNIGHT-INTENT flag that used to
  // trigger the overnight handshake denial.
  output = run(PROMPT, { prompt: "im going to bed, keep working" }, { projectDir: temp });
  ok(!String(output?.hookSpecificOutput?.additionalContext || "").includes("autopilot reminder"), "autopilot reminder is unwired");
  ok(!existsSync(path.join(temp, ".claude", "session-state", "OVERNIGHT-INTENT.flag")), "no overnight-intent flag is written");

  output = run(PROMPT, { prompt: "run this overnight" }, { surface: "codex", projectDir: temp });
  eq(output, null, "Codex router stays silent on an ordinary prompt");

  output = run(PROMPT, { prompt: "<task-notification>review this code</task-notification>" }, { projectDir: temp });
  eq(output, null, "machine-generated prompt remains silent across the router");

  output = run(POST, {
    tool_name: "Edit",
    tool_input: { file_path: path.join(temp, "supabase", "migrations", "20260827000000_router.sql") },
  }, { projectDir: temp });
  eq(output?.decision, undefined, "migration edit is a reminder, not a (cosmetic) PostToolUse block");
  ok(output?.hookSpecificOutput?.additionalContext.includes("MIGRATION SAFETY CHECK"), "migration reminder text is preserved as context");
  ok(existsSync(path.join(temp, ".claude", "session-state", "SESSION-HEARTBEAT")), "Claude PostToolUse router preserves heartbeat");

  // Full checklist once per file per session, then a one-line pointer (Mason, 2026-10-29).
  const migEdit = (file, session_id) => run(POST, {
    session_id,
    tool_name: "Edit",
    tool_input: { file_path: path.join(temp, "supabase", "migrations", file) },
  }, { projectDir: temp })?.hookSpecificOutput?.additionalContext || "";
  ok(migEdit("20260827000001_once.sql", "sess-a").includes("Before continuing, you MUST"), "first edit of a file shows the full checklist");
  const again = migEdit("20260827000001_once.sql", "sess-a");
  ok(again.includes("edited again") && !again.includes("Before continuing, you MUST"), "second edit of the same file shows the one-line pointer");
  ok(migEdit("20260827000002_other.sql", "sess-a").includes("Before continuing, you MUST"), "a different file gets its own full checklist");
  ok(migEdit("20260827000001_once.sql", "sess-b").includes("Before continuing, you MUST"), "another session gets the full checklist again");
  ok(run(POST, { tool_name: "Edit", tool_input: { file_path: path.join(temp, "supabase", "migrations", "20260827000001_once.sql") } },
    { projectDir: temp })?.hookSpecificOutput?.additionalContext.includes("Before continuing, you MUST"),
  "no session id always shows the full checklist");
  // Same basename in another folder is a different file (Luna, PR #1193).
  ok(migEdit(path.join("nested", "20260827000001_once.sql"), "sess-a").includes("Before continuing, you MUST"),
    "a same-named file in another migrations folder gets its own full checklist");

  const stateDir = path.join(temp, ".claude", "session-state");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, "applied-migrations.json"), "{}\n");
  output = run(POST, {
    tool_name: "mcp__supabase__apply_migration",
    tool_input: { name: "router_contract", query: "CREATE TABLE router_contract (id bigint);" },
  }, { projectDir: temp });
  const context = output?.hookSpecificOutput?.additionalContext || "";
  ok(context.includes("REGISTRY FRESHNESS"), "apply path preserves registry invalidation");
  ok(context.includes("Applied-migration snapshot invalidated"), "apply path preserves snapshot invalidation");
  ok(existsSync(path.join(stateDir, "applied-source-ledger.json")), "apply path preserves source ledger recording");
  ok(!existsSync(path.join(stateDir, "applied-migrations.json")), "apply path removes the stale applied snapshot");

  rmSync(path.join(stateDir, "SESSION-HEARTBEAT"), { force: true });
  output = run(POST, { tool_name: "Read", tool_input: {} }, { surface: "codex", projectDir: temp });
  eq(output, null, "irrelevant Codex PostToolUse event stays silent");
  ok(!existsSync(path.join(stateDir, "SESSION-HEARTBEAT")), "Codex router does not acquire Claude worktree heartbeat behavior");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

eq(promptModulesFor("codex").length, 3, "Codex prompt router has three shared modules (owner-approval reply, CodeRabbit skip, Taha lane override)");
eq(promptModulesFor("claude").length, 3, "Claude prompt router has no Claude-only modules");
ok(!promptModulesFor("claude").includes("./hold-latch-prompt.mjs"), "the hold latch is not routed (Mason, 2026-10-29)");
for (const surface of ["claude", "codex"]) {
  ok(promptModulesFor(surface).includes("./owner-approval-prompt.mjs"), `${surface} still routes the owner-approval reply`);
  ok(!promptModulesFor(surface).includes("./release-pass-prompt.mjs"), `${surface} does not route the removed release pass (Mason, 2026-11-22)`);
}
{
  const claudeSettings = readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8");
  const codexHooks = readFileSync(path.join(ROOT, ".codex", "hooks.json"), "utf8");
  ok(!claudeSettings.includes("hold-latch-guard.mjs") && !codexHooks.includes("hold-latch-guard.mjs"),
    "the hold-latch guard is wired in neither manifest");
}
eq(postToolModulesFor({ tool_name: "Edit" }, "claude"), ["./posttooluse-migration.mjs", "./eslint-autofix.mjs", "./session-heartbeat.mjs"], "write/edit path is explicit");
eq(postToolModulesFor({ tool_name: "mcp__supabase__apply_migration" }, "codex"), ["./registry-freshness.mjs", "./applied-snapshot-invalidate.mjs"], "Codex apply path is explicit");
eq(postToolModulesFor({ tool_name: "Bash", tool_input: { command: "git -C C:/x push origin HEAD" } }, "codex"), ["./post-push-dirty-warning.mjs", "./taha-ready-after-sol.mjs"], "a push routes the DIRTY-PR warning and the Taha label check");
eq(postToolModulesFor({ tool_name: "Bash", tool_input: { command: "gh pr create --base staging --fill" } }, "codex"), ["./taha-ready-after-sol.mjs"], "opening a PR routes the Taha label check");
eq(postToolModulesFor({ tool_name: "Bash", tool_input: { command: "gh pr ready 12" } }, "codex"), ["./taha-ready-after-sol.mjs"], "marking a PR ready routes the Taha label check");
eq(postToolModulesFor({ tool_name: "Bash", tool_input: { command: "git status" } }, "codex"), [], "a non-push command does not");
{
  // Warning only: DIRTY warns, UNKNOWN is retried once, anything else (or a gh failure) is silent.
  const views = (...answers) => async () => { const a = answers.shift(); if (a instanceof Error) throw a; return a; };
  const warn = (...answers) => dirtyWarning("x", { view: views(...answers), delayMs: 0 });
  eq(await warn({ number: 7, state: "OPEN", mergeStateStatus: "DIRTY" }), "⚠️ PR #7 conflicts with its base; GitHub runs no full CI until you merge the base in.", "DIRTY PR warns");
  eq(await warn({ state: "OPEN", mergeStateStatus: "UNKNOWN" }, { number: 8, state: "OPEN", mergeStateStatus: "DIRTY" }), "⚠️ PR #8 conflicts with its base; GitHub runs no full CI until you merge the base in.", "UNKNOWN is retried once");
  eq(await warn({ number: 9, state: "OPEN", mergeStateStatus: "CLEAN" }), "", "clean PR is silent");
  eq(await warn({ number: 9, state: "MERGED", mergeStateStatus: "DIRTY" }), "", "closed PR is silent");
  eq(await warn(new Error("ETIMEDOUT")), "", "gh error or timeout is silent");
  // Expected values go through path.resolve: CI runs on Linux, where "C:/a b" is a relative path.
  eq(pushDir('git -C "C:/a b" push', "C:/cwd"), path.resolve("C:/cwd", "C:/a b"), "git -C folder wins");
  eq(pushDir("git push", "C:/cwd"), "C:/cwd", "plain push uses the tool cwd");
  eq(pushDir("git -C C:/repoA status; git -C C:/repoB push origin HEAD", "C:/cwd"), path.resolve("C:/cwd", "C:/repoB"), "only the push's own -C counts");
  // #2014: every push in the command, and a refspec's destination branch.
  const targets = (command) => pushTargets(command, "C:/cwd").map(({ dir, branch }) => `${path.basename(dir)}@${branch}`);
  eq(targets("git -C C:/a push && git -C C:/b push").join(" "), "a@null b@null", "two repositories in one command: both checked");
  eq(targets("git push origin topic:release").join(" "), "cwd@release", "a refspec push asks for its destination branch");
  eq(targets("git push origin HEAD").join(" "), "cwd@null", "HEAD means the folder's current branch");
  eq(targets("git push origin HEAD other").join(" "), "cwd@null cwd@other", "HEAD beside another refspec still checks the current branch");
  eq(targets("git status").join(" "), "", "no push, nothing to check");
  eq(targets("git push origin HEAD:123").join(" "), "", "an all-digit branch is not mistaken for a PR number");
  eq(targets("git push origin a b c d").length, 3, "at most three pushes are asked about");
  const asked = [];
  await dirtyWarning("x", { branch: "release", delayMs: 0, view: async (_dir, branch) => { asked.push(branch); return { state: "OPEN", mergeStateStatus: "CLEAN" }; } });
  eq(asked.join(), "release", "the destination branch is passed to gh");
}

const claude = JSON.parse(readFileSync(path.join(ROOT, ".claude", "settings.json"), "utf8"));
const codex = JSON.parse(readFileSync(path.join(ROOT, ".codex", "hooks.json"), "utf8"));
eq(claude.hooks.UserPromptSubmit[0].hooks.length, 1, "Claude prompt event launches one configured process");
eq(claude.hooks.PostToolUse[0].hooks.length, 1, "Claude post event launches one configured process");
eq(codex.hooks.UserPromptSubmit[0].hooks.length, 1, "Codex prompt event launches one configured adapter");
eq(codex.hooks.PostToolUse[0].hooks.length, 1, "Codex post event launches one configured adapter");

function matcherFor(manifest, needle) {
  return manifest.hooks.PreToolUse.find((group) => group.hooks.some((hook) => `${hook.command} ${hook.commandWindows || ""}`.includes(needle)))?.matcher;
}
function configuredHooksFor(manifest, toolName) {
  return manifest.hooks.PreToolUse
    .filter((group) => group.matcher === "*" || new RegExp(`^(?:${group.matcher})$`, "i").test(toolName))
    .flatMap((group) => group.hooks);
}
for (const hook of ["migration-apply-guard.mjs", "live-testdata-guard.mjs", "mcp-tool-guard.mjs"]) {
  eq(matcherFor(codex, hook), "mcp__.*", `${hook} is MCP-only on Codex`);
}
for (const [surface, manifest] of [["Claude", claude], ["Codex", codex]]) {
  ok(
    configuredHooksFor(manifest, "MultiEdit").some((hook) => `${hook.command} ${hook.commandWindows || ""}`.includes("actor-binding-check.mjs")),
    `${surface} MultiEdit path invokes the actor-binding guard`,
  );
}
eq(matcherFor(codex, "production-action-guard.mjs"), "*", "production guard remains reachable for native Write, Edit, and apply_patch calls");
for (const toolName of ["Write", "Edit", "apply_patch"]) {
  ok(
    configuredHooksFor(codex, toolName).some((hook) => `${hook.command} ${hook.commandWindows || ""}`.includes("production-action-guard.mjs")),
    `configured Codex ${toolName} path invokes the production guard`,
  );
}

// A clean Sol on a lane PR's current head labels it for Taha (agents kept forgetting; #2610, 2026-11-26).
{
  const HEAD = "a".repeat(40), BASE = "b".repeat(40), EARLIER = "c".repeat(40), OTHER = "d".repeat(40), NEW_BASE = "e".repeat(40);
  const now = Date.now();
  const stamp = new Date(now - 60 * 60 * 1000).toISOString();
  const proof = (head, extra = {}) => ({ codex_ran: true, verdict: "clean", head_sha: head, base_sha: BASE, timestamp: stamp, model: "gpt-6.2-sol", reasoning_effort: "high", ...extra });
  const basePr = { number: 7, state: "OPEN", isDraft: false, isCrossRepository: false, author: { login: "MasonWells" }, headRefName: "claude/x",
    headRefOid: HEAD, baseRefName: "staging", baseRefOid: BASE, commits: [{ oid: HEAD }], reviews: [] };
  const laneFiles = ["modified", "src/pages/Quotes.tsx", "", HEAD].join("\t") + "\n";
  const otherFiles = ["modified", "src/pages/Fields.tsx", "", HEAD].join("\t") + "\n";
  const TAHA_ID = "50602678";
  const attempt = ({ pr = {}, files = laneFiles, proofs = { [HEAD]: proof(HEAD) }, headSha = HEAD, fail = null, views = null, approvedHead = null, compare = () => "0", budgetMs = 20_000, delayOn = null, delayMs = 0 } = {}) => {
    const calls = [];
    let viewed = 0;
    const gh = (args) => {
      calls.push(args.join(" "));
      if (delayOn && args.some((a) => a.includes(delayOn))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
      if (fail && args.some((a) => a.includes(fail))) throw new Error("HTTP 403");
      if (args[0] === "pr") return JSON.stringify({ ...basePr, ...pr, ...(views ? views[Math.min(viewed++, views.length - 1)] : {}) });
      if (args.some((a) => a.endsWith("/files?per_page=100"))) return files;
      if (args.some((a) => a.includes("/compare/"))) return compare(args);
      if (args.some((a) => a.includes("/timeline"))) return "";
      if (args.some((a) => a.includes("/reviews?"))) return approvedHead ? [TAHA_ID, "APPROVED", approvedHead, stamp, "1"].join("\t") + "\n" : "";
      return "{}";
    };
    const note = askTahaAfterSol({ cwd: ".", headSha, gh, readProof: (sha) => proofs[sha] ?? null, now, budgetMs, retryDelayMs: 1, wait: () => {} });
    return { note, calls, wrote: calls.filter((c) => c.includes("/labels") || c.includes("/requested_reviewers")) };
  };
  const done = attempt();
  ok(done.note.includes("PR #7") && done.wrote.length === 2, "clean Sol + lane + current head: label and review request");
  ok(done.wrote[0].includes("reviewers[]=TahaKhanAbdalli") && done.wrote[1].includes("labels[]=ready-for-taha"), "the same two calls the bot makes, the review request first (Taha LOW 5)");
  for (const [why, args] of [
    ["no clean Sol proof", { proofs: {} }],
    ["not in Taha's lane", { files: otherFiles }],
    ["draft", { pr: { isDraft: true } }],
    ["Taha's own PR (author)", { pr: { author: { login: "TahaKhanAbdalli" } } }],
    ["Taha's own PR (branch)", { pr: { headRefName: "taha/billing" } }],
    ["fork", { pr: { isCrossRepository: true } }],
    ["closed", { pr: { state: "MERGED" } }],
    ["Taha already reviewed this head", { pr: { reviews: [{ author: { login: "tahakhanabdalli" }, state: "APPROVED", commit: { oid: HEAD } }] } }],
  ]) {
    const r = attempt(args);
    ok(r.note === "" && r.wrote.length === 0, `no label when: ${why}`);
  }
  const failed = attempt({ fail: "requested_reviewers" });
  ok(failed.note.includes("could not ask Taha") && failed.note.includes("gh pr edit 7 --add-label ready-for-taha --add-reviewer TahaKhanAbdalli") && failed.wrote.length === 1, "a failed review request prints the manual command and adds no label on its own");
  const labelFailed = attempt({ fail: "/labels" });
  ok(labelFailed.note.includes("Taha is asked to review, but the ready-for-taha label could not be added") && labelFailed.note.includes("gh pr edit 7 --add-label ready-for-taha"), "request sent, label failed: says exactly that (Taha LOW 5)");
  // Taha LOW 2 / Codex bot: an unreadable file list is not "not in the lane".
  const noFiles = attempt({ fail: "/files" });
  ok(noFiles.wrote.length === 0 && noFiles.note.includes("not labelled for Taha yet") && noFiles.note.includes("changed files"), "file list unreadable: one line with the manual command");
  // Taha LOW 7: the lane is unknown then, so the command is conditional, and no sign-off of his is claimed.
  ok(noFiles.note.includes("could not tell whether it changes Taha's areas") && noFiles.note.includes("Only if it does, run: gh pr edit 7") && !noFiles.note.includes("signed off"), "unknown lane: the command is only for a PR in his areas");
  const manyFiles = laneFiles + Array.from({ length: 249 }, (_, i) => ["modified", `docs/n${i}.md`, "", HEAD].join("\t")).join("\n") + "\n";
  const many = attempt({ files: manyFiles });
  ok(many.wrote.length === 0 && many.note.includes("Only if it does, run: gh pr edit 7"), "250+ changed files (maybe cut short): lane unknown, conditional line (Codex bot)");
  const MIG = "supabase/migrations/20270101000000_field_x.sql";
  const migFiles = ["added", MIG, "", HEAD].join("\t") + "\n";
  const unreadSql = attempt({ files: migFiles, fail: "/contents/" });
  ok(unreadSql.wrote.length === 0 && unreadSql.note.includes("migrations' SQL") && unreadSql.note.includes("Only if it does") && !unreadSql.note.includes("signed off"), "only unreadable migration SQL: lane unknown, conditional line, no sign-off claimed");
  const slowSql = attempt({ files: migFiles, budgetMs: 200, delayOn: "/files", delayMs: 300 });
  ok(slowSql.wrote.length === 0 && !slowSql.note.includes("signed off"), "out of time in the lane check with no sign-off of his: never says he signed off");
  // Codex bot: `gh pr ready <n>` from another branch asks about PR n, judged on its own head.
  // Taha LOW 8 / Codex bot: a literal `cd <dir> &&` before gh pr create|ready is followed.
  // Absolute paths built for this OS, so the case holds on the Linux CI runner and on Windows.
  const here = path.resolve("base");
  const lane = path.resolve("wt", "lane"), spaced = path.resolve("wt", "my lane");
  const slash = (p) => p.replaceAll("\\", "/");
  eq([ghCommandCwd(`cd ${slash(lane)} && gh pr create --base staging --fill`, here), ghCommandCwd(`cd "${slash(spaced)}" && gh pr ready`, here), ghCommandCwd("gh pr ready", here), ghCommandCwd("cd $W && gh pr ready", here), ghCommandCwd("cd ../x && gh pr ready", here)],
    [lane, spaced, here, here, path.resolve(here, "../x")], "the folder a gh pr create/ready runs in");
  eq([readyTarget("gh pr ready 2643"), readyTarget("gh pr ready --undo"), readyTarget("gh pr ready"), readyTarget("gh pr create --fill")], ["2643", null, null, null], "the PR a gh pr ready names");
  const named = (() => { const calls = []; const note = askTahaAfterSol({ cwd: ".", pr: "7", gh: (args) => { calls.push(args.join(" ")); return args[0] === "pr" ? JSON.stringify(basePr) : args.some((a) => a.includes("/files")) ? laneFiles : "0"; }, readProof: (sha) => (sha === HEAD ? proof(HEAD) : null), now }); return { note, calls }; })();
  ok(named.calls[0].startsWith("pr view 7 ") && named.note.includes("Taha is asked"), "gh pr ready <n>: that PR is asked about and labelled");
  ok(askTahaAfterSol({ cwd: ".", headSha: HEAD, gh: () => { throw new Error("no pull requests found for branch \"claude/x\""); }, readProof: () => proof(HEAD), now }) === "", "no PR yet: silent");

  // Taha MED 1: his earlier sign-off that still carries over (staging catch-up, docs/ note, restamp) is not re-asked.
  const signedOff = { pr: { reviews: [{ author: { login: "TahaKhanAbdalli" }, state: "DISMISSED", commit: { oid: EARLIER } }] } };
  const carried = attempt({ ...signedOff, approvedHead: HEAD });
  ok(carried.note === "" && carried.wrote.length === 0, "Taha's earlier sign-off carries over to this head: no label, no new review request");
  ok(carried.calls.some((c) => c.includes("/timeline")), "the carry-over is asked of GitHub, as the bot does");
  const notCarried = attempt({ ...signedOff, approvedHead: null });
  ok(notCarried.wrote.length === 2, "his earlier sign-off does not carry over: label and re-ask him");
  const carryTimedOut = attempt({ ...signedOff, approvedHead: HEAD, budgetMs: 200, delayOn: "/timeline", delayMs: 300 });
  ok(carryTimedOut.wrote.length === 0 && carryTimedOut.note.includes("could not finish checking whether it carries over") && carryTimedOut.note.includes("Only if this push changed code"), "carry check out of time: no plain re-ask, a conditional line (Taha MED 1, delta)");
  const carryFailed = attempt({ ...signedOff, approvedHead: HEAD, fail: "/timeline" });
  ok(carryFailed.wrote.length === 0 && carryFailed.note.includes("could not finish checking") && carryFailed.note.includes("Only if this push changed code"), "carry check hits a GitHub error: no re-ask, a conditional line (Codex bot)");
  ok(!done.calls.some((c) => c.includes("/timeline")), "no sign-off of his on the PR: the carry-over check costs no calls");

  // Taha LOW 2: GitHub behind the push is asked once more, and never silently dropped when a clean Sol is on disk.
  const caughtUp = attempt({ views: [{ headRefOid: OTHER, commits: [{ oid: OTHER }] }, {}] });
  ok(caughtUp.wrote.length === 2 && caughtUp.calls.filter((c) => c.startsWith("pr view")).length === 2, "GitHub catches up on the second look: labelled");
  const behind = attempt({ views: [{ headRefOid: OTHER, commits: [{ oid: OTHER }] }] });
  ok(behind.wrote.length === 0 && behind.note.includes("not labelled for Taha yet") && behind.note.includes("gh pr edit 7"), "GitHub still behind the push: one line with the manual command");
  // Taha LOW 7: before the lane is read the line is conditional, plus the code-change condition once he signed off.
  ok(behind.note.includes("Only if it does, run: gh pr edit 7") && !behind.note.includes("changed code"), "GitHub behind: conditional line, lane unknown");
  const behindSigned = attempt({ ...signedOff, views: [{ ...signedOff.pr, headRefOid: OTHER, commits: [{ oid: OTHER }] }] });
  ok(behindSigned.wrote.length === 0 && behindSigned.note.includes("Only if it does and this push changed code"), "GitHub behind on a PR he signed off: both conditions");
  const filesFailSigned = attempt({ ...signedOff, fail: "/files" });
  ok(filesFailSigned.wrote.length === 0 && filesFailSigned.note.includes("Only if it does and this push changed code"), "file list unreadable on a PR he signed off: both conditions");
  ok(attempt({ views: [{ headRefOid: OTHER, commits: [{ oid: OTHER }] }], proofs: {} }).note === "", "GitHub behind but no clean Sol on disk: silent");
  const slow = askTahaAfterSol({ cwd: ".", headSha: HEAD, gh: () => { throw new Error("ETIMEDOUT"); }, readProof: () => proof(HEAD), now });
  ok(slow.includes("not labelled for Taha yet") && slow.includes("ETIMEDOUT"), "GitHub does not answer while a clean Sol is on disk: says so");
  // Staging moved since Sol: GitHub's compare answers the ancestry (no local fetch needed); if it cannot, say so.
  const moved = { pr: { baseRefOid: NEW_BASE } };
  const movedOk = attempt({ ...moved, compare: (args) => (args.includes(".merge_base_commit.sha") ? BASE : "0") });
  ok(movedOk.wrote.length === 2, "staging moved since Sol: GitHub's merge-base confirms coverage, labelled");
  const movedUnknown = attempt({ ...moved, compare: (args) => { if (args.includes(".merge_base_commit.sha")) throw new Error("HTTP 502"); return "0"; } });
  ok(movedUnknown.wrote.length === 0 && movedUnknown.note.includes("could not confirm"), "GitHub cannot say whether Sol covers the head: one line, no label");

  // Taha LOW 3: one deadline for the whole hook; each call gets only what is left.
  const timeouts = [];
  askTahaAfterSol({ cwd: ".", headSha: HEAD, gh: (args, _cwd, timeout) => { timeouts.push(timeout); return args[0] === "pr" ? JSON.stringify(basePr) : args.some((a) => a.includes("/files")) ? laneFiles : "0"; }, readProof: () => proof(HEAD), now, budgetMs: 4_000 });
  ok(timeouts.length > 0 && timeouts.every((t) => t >= 1 && t <= 4_000), "every GitHub call is capped by the hook's one deadline");
  const outOfTime = attempt({ budgetMs: 0 });
  ok(outOfTime.wrote.length === 0 && outOfTime.note.includes("not labelled for Taha yet"), "out of time before GitHub answers: one line, no half-done label");

  // "Covers" follows the merge gate: a clean Sol of this head or of an earlier commit of this PR.
  const pr = { headRefOid: HEAD, baseRefOid: BASE, baseRefName: "staging", commits: [{ oid: EARLIER }, { oid: HEAD }] };
  // History: BASE <- EARLIER <- HEAD; OTHER is unrelated.
  const chain = [BASE, EARLIER, HEAD];
  const isAncestor = (a, b) => (chain.includes(a) && chain.includes(b) ? chain.indexOf(a) <= chain.indexOf(b) : false);
  const covers = (proofs, more = {}) => solCoversHead({ pr, readProof: (sha) => proofs[sha] ?? null, isAncestor, mergeBase: () => BASE, laterRisky: () => false, now, ...more });
  ok(covers({ [HEAD]: proof(HEAD) }) === true, "a clean Sol of the current head covers it");
  ok(covers({ [EARLIER]: proof(EARLIER) }) === true, "a clean Sol of an earlier commit of this PR covers a fix pushed after it");
  ok(covers({ [OTHER]: proof(OTHER) }) === false, "a proof of a commit outside this PR does not");
  ok(covers({ [EARLIER]: proof(EARLIER, { owner_accepted: [{ code: "1" }] }) }) === false, "a Sol with findings Mason accepted is not clean here");
  ok(covers({ [EARLIER]: proof(EARLIER, { model: "gpt-6-luna" }) }) === false, "a Luna review is not Sol");
  ok(covers({ [EARLIER]: proof(EARLIER, { timestamp: new Date(now - 25 * 60 * 60 * 1000).toISOString() }) }) === false, "a Sol older than 24 hours does not");
  ok(covers({ [EARLIER]: proof(EARLIER, { review_ref: "origin/main" }) }) === false, "a review against main does not cover a PR into staging");
  ok(covers({}) === false, "no proof: not covered");
  ok(covers({ [EARLIER]: proof(EARLIER) }, { isAncestor: () => null }) === null, "ancestry unknown: unsure (null), never a plain no");
  // Codex bot: as the merge gate, an earlier commit's Sol covers only later commits that stay off the Sol list.
  ok(covers({ [EARLIER]: proof(EARLIER) }, { laterRisky: () => true }) === false, "a later commit on the Sol list: the earlier Sol does not cover the head");
  ok(covers({ [EARLIER]: proof(EARLIER) }, { laterRisky: () => null }) === null, "later commits unreadable: unsure, never covered");
  ok(covers({ [HEAD]: proof(HEAD) }, { laterRisky: () => true }) === true, "a Sol of the head itself needs no later-commit check");
  const compareWith = (files) => () => JSON.stringify({ status: "ahead", ahead_by: 1, head: HEAD, files: files.map((filename) => ({ filename, status: "modified" })) });
  ok(laterSolRisk(compareWith(["src/pages/Quotes.tsx"]))(EARLIER, HEAD) === true, "the merge gate's Sol-risk check: a quotes screen is on the list");
  ok(laterSolRisk(compareWith(["docs/notes.md"]))(EARLIER, HEAD) === false, "the merge gate's Sol-risk check: a docs note is not");
  ok(laterSolRisk(() => { throw new Error("HTTP 502"); })(EARLIER, HEAD) === null, "the comparison unreadable: unknown, not covered");

  // Taha LOW 4: the real proof reader (files across checkouts) and the GitHub-backed ancestry answers.
  const main = tempDir("crx-taha-ready-main-");
  const other = tempDir("crx-taha-ready-wt-");
  mkdirSync(path.join(other, ".claude", "session-state"), { recursive: true });
  writeFileSync(path.join(other, ".claude", "session-state", `codex-review-${EARLIER}.json`), JSON.stringify(proof(EARLIER)));
  const read = proofReader(main, () => `worktree ${main}\nHEAD ${HEAD}\n\nworktree ${other}\nHEAD ${EARLIER}\n`);
  ok(read(EARLIER)?.head_sha === EARLIER, "a proof written in another worktree of this checkout is found");
  ok(read(HEAD) === null && read("../x") === null, "no proof, or not a commit id: null");
  ok(proofReader(main, () => { throw new Error("no git"); })(EARLIER) === null, "worktree list unavailable: only this checkout is searched");
  const answers = (reply) => githubAncestry((args) => reply(args));
  ok(answers(() => "0").isAncestor(BASE, HEAD) === true, "GitHub: not behind, so contained");
  ok(answers(() => "3").isAncestor(BASE, HEAD) === false, "GitHub: behind, so not contained");
  ok(answers(() => { throw new Error("HTTP 404"); }).isAncestor(BASE, HEAD) === null, "GitHub error (e.g. a commit it lacks): unknown, not false");
  ok(answers(() => `${BASE}\n`).mergeBase(HEAD, NEW_BASE) === BASE && answers(() => { throw new Error("x"); }).mergeBase(HEAD, NEW_BASE) === null, "merge-base from GitHub; an error is unknown");
  const realCovers = solCoversHead({ pr: { ...pr, baseRefOid: NEW_BASE }, readProof: read, ...answers((args) => (args.includes(".merge_base_commit.sha") ? BASE : args.some((a) => a.includes(`${EARLIER}...${NEW_BASE}`)) ? "1" : "0")), laterRisky: () => false, now });
  ok(realCovers === true, "end to end: another worktree's Sol of an earlier commit covers the head after staging moved");
}

console.log(`hook-router: ${pass} assertions passed`);
