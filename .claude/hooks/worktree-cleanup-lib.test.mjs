#!/usr/bin/env node
// Tests for the worktree-cleanup safety classifier.
// Run: node .claude/hooks/worktree-cleanup-lib.test.mjs

import assert from "node:assert/strict";
import {
  classifyWorktree, classifyBranch, planCleanup, normPath,
  meaningfulDirt, isIgnorableDirtLine, IGNORABLE_DIRT_PATH,
  PROTECTED_BRANCHES, HARNESS_MARKER, ACTIVE_WINDOW_MS,
  ledgerHasEntries, ledgerKeepsWorktree, preciousIgnored, isRebuildableIgnored, classifyHusk,
} from "./worktree-cleanup-lib.mjs";

let pass = 0;
function eq(a, b, msg) { assert.deepEqual(a, b, msg); pass++; }
function ok(cond, msg) { assert.ok(cond, msg); pass++; }

const CUR = "C:/CRX_Manager/.claude/worktrees/active-abc123";
const ctx = { currentPath: CUR };

// A worktree that passes EVERY gate → removed.
const finished = {
  path: "C:/CRX_Manager/.claude/worktrees/done-xyz789",
  branch: "chore/done", detached: false, locked: false, dirty: false, merged: true, preciousIgnored: 0,
};
eq(classifyWorktree(finished, ctx), { action: "remove", reason: "merged-clean" }, "finished harness worktree → remove");

// ── Each gate, in isolation, must FLIP the verdict to keep ──

// 1. active session (the worktree we're standing in) — even if merged+clean.
eq(classifyWorktree({ ...finished, path: CUR }, ctx).action, "keep", "active session never removed");
eq(classifyWorktree({ ...finished, path: CUR }, ctx).reason, "active-session", "active reason");
// case/slash-insensitive path match
eq(classifyWorktree({ ...finished, path: CUR.replace(/\//g, "\\").toUpperCase() }, ctx).reason, "active-session",
  "active match is slash/case-insensitive");

// 2. detached / no branch
eq(classifyWorktree({ ...finished, branch: null, detached: true, merged: false }, ctx).reason, "detached", "unlanded detached head → keep");
eq(classifyWorktree({ ...finished, branch: null, detached: true }, ctx), { action: "remove", reason: "merged-clean" }, "detached head that landed + clean → remove");
eq(classifyWorktree({ ...finished, branch: null, detached: true, dirty: true }, ctx).reason, "dirty", "landed detached head with uncommitted work → keep");
eq(classifyWorktree({ ...finished, branch: null }, ctx).reason, "detached", "no branch → keep");

// 3. protected branch
for (const b of PROTECTED_BRANCHES) {
  eq(classifyWorktree({ ...finished, branch: b }, ctx).reason, "protected-branch", `${b} protected`);
}

// 4. locked worktree (an active/held session)
eq(classifyWorktree({ ...finished, locked: true }, ctx).reason, "locked", "locked → keep");

// 5. dirty (uncommitted work)
eq(classifyWorktree({ ...finished, dirty: true }, ctx).reason, "dirty", "dirty → keep");

// 5b. unresolved applied-source ledger (a live apply with no committed source
//     yet — Opus review 2026-08-19). Merged+clean can't see the gitignored
//     ledger, so it needs its own gate; sweeping would destroy the only record.
eq(classifyWorktree({ ...finished, hasAppliedLedgerEntries: true }, ctx).reason, "applied-ledger",
  "unresolved applied-source ledger → keep even when merged+clean");
eq(classifyWorktree({ ...finished, hasAppliedLedgerEntries: false }, ctx).action, "remove",
  "resolved/absent ledger → still removable when finished");

// 6. unmerged (real un-shipped commits)
eq(classifyWorktree({ ...finished, merged: false }, ctx).reason, "unmerged", "unmerged → keep");

// 7. not under .claude/worktrees/ (a manual long-lived checkout) — never auto-removed
eq(classifyWorktree({ ...finished, path: "C:/CRX_Layer2" }, ctx).reason, "not-harness",
  "manual worktree outside .claude/worktrees → keep");
eq(classifyWorktree({ ...finished, path: "C:/CRX_Manager" }, ctx).reason, "not-harness", "repo root → keep");

// 1b. recent activity (a LIVE sibling session) — even if merged+clean+unlocked.
//     This is the 2026-07-16 fix: previously only the current session's own path
//     was protected, so a sibling's sweep deleted an in-use checkout.
const NOW = 1_700_000_000_000;
const actCtx = { ...ctx, nowMs: NOW };
eq(classifyWorktree({ ...finished, lastActivityMs: NOW - 60_000 }, actCtx).reason, "recently-active",
  "worktree touched 1 min ago → keep (live sibling session)");
eq(classifyWorktree({ ...finished, lastActivityMs: NOW - (ACTIVE_WINDOW_MS - 1) }, actCtx).reason, "recently-active",
  "just inside the active window → keep");
eq(classifyWorktree({ ...finished, lastActivityMs: NOW - (ACTIVE_WINDOW_MS + 60_000) }, actCtx),
  { action: "remove", reason: "merged-clean" }, "idle past the window → still removed (finished)");
eq(classifyWorktree({ ...finished, lastActivityMs: 0 }, actCtx).action, "remove",
  "no activity signal (0) → eligible for removal, never kept-forever on a read miss");
eq(classifyWorktree({ ...finished, lastActivityMs: undefined }, actCtx).action, "remove",
  "missing activity fact → behaves like before (removed if finished)");
// recent activity must NOT rescue an UNMERGED worktree from being kept for the
// right reason — unmerged is already keep; but a recent+merged one keeps as
// recently-active, and precedence: active-session still wins over recently-active.
eq(classifyWorktree({ ...finished, path: CUR, lastActivityMs: NOW - 1000 }, actCtx).reason, "active-session",
  "active-session still takes precedence over recently-active");

// Gate PRECEDENCE: a dirty + unmerged manual worktree still keeps (any single gate is enough);
// and active beats everything.
ok(classifyWorktree({ ...finished, path: CUR, dirty: true, merged: false, locked: true }, ctx).reason === "active-session",
  "active takes precedence over all other gates");

// ── Orphan branch classifier ──
eq(classifyBranch({ branch: "claude/dead", merged: true, checkedOut: false }, {}),
  { action: "remove", reason: "merged" }, "merged orphan branch → remove");
eq(classifyBranch({ branch: "claude/live", merged: false, checkedOut: false }, {}).reason, "unmerged",
  "unmerged orphan branch → keep");
eq(classifyBranch({ branch: "main", merged: true, checkedOut: false }, {}).reason, "protected-branch",
  "main branch → keep");
eq(classifyBranch({ branch: "feat/x", merged: true, checkedOut: true }, {}).reason, "checked-out",
  "checked-out branch → keep (handled by worktree pass)");

// ── planCleanup end-to-end (mirrors this session's real fleet) ──
const plan = planCleanup({
  worktrees: [
    { path: CUR, branch: "claude/active", merged: false, dirty: false, locked: false, detached: false }, // active
    { path: "C:/CRX_Manager/.claude/worktrees/finished-1", branch: "chore/f1", merged: true, dirty: false, locked: false, detached: false, preciousIgnored: 0 }, // remove
    { path: "C:/CRX_Manager/.claude/worktrees/locked-1", branch: "wt-sync", merged: true, dirty: false, locked: true, detached: false }, // keep (locked)
    { path: "C:/CRX_Layer2", branch: "main", merged: true, dirty: false, locked: false, detached: false }, // keep (protected+manual)
  ],
  branches: [
    { branch: "claude/merged-orphan", merged: true, checkedOut: false }, // remove
    { branch: "claude/overnight-bug-hunt", merged: false, checkedOut: false }, // keep (unmerged)
  ],
}, ctx);
eq(plan.removeWorktrees.map((w) => w.branch), ["chore/f1"], "only the finished harness worktree is removed");
eq(plan.removeBranches.map((b) => b.branch), ["claude/merged-orphan"], "only the merged orphan branch is removed");
eq(plan.keep.length, 4, "everything else is kept with a reason (active + locked + protected/manual + unmerged orphan)");
ok(plan.keep.every((k) => typeof k.reason === "string" && k.reason), "every kept item carries a reason");

// invariant: nothing unmerged is EVER in a remove list
const allRemoved = [...plan.removeWorktrees, ...plan.removeBranches];
ok(allRemoved.every((x) => x.merged === true), "SAFETY: no unmerged item is ever removed");

// ── Ignorable-dirt filter (2026-08-18: settings.local.json noise) ──
ok(IGNORABLE_DIRT_PATH === ".claude/settings.local.json", "ignorable path stable");
ok(isIgnorableDirtLine(" M .claude/settings.local.json"), "unstaged modify of the harness file is ignorable");
ok(isIgnorableDirtLine("M  .claude/settings.local.json"), "staged modify is ignorable");
ok(isIgnorableDirtLine("?? .claude/settings.local.json"), "untracked copy is ignorable");
ok(isIgnorableDirtLine(" M .claude\\settings.local.json\r"), "backslashes + CR normalize");
ok(!isIgnorableDirtLine(" M .claude/settings.json"), "the SHARED settings.json is real dirt");
ok(!isIgnorableDirtLine(" M src/settings.local.json"), "same basename elsewhere is real dirt");
ok(!isIgnorableDirtLine("R  .claude/settings.local.json -> src/x.ts"), "renames stay real dirt");
ok(!isIgnorableDirtLine(" M .claude/settings.local.json.bak"), "suffixed lookalike is real dirt");
eq(meaningfulDirt(" M .claude/settings.local.json\n"), [], "sole harness-file dirt → clean for cleanup");
eq(meaningfulDirt(" M .claude/settings.local.json\n M src/app.ts\n"), [" M src/app.ts"],
  "harness file + real work → only the real work counts");
eq(meaningfulDirt(""), [], "empty porcelain → clean");
eq(meaningfulDirt("?? supabase/migrations/x.sql"), ["?? supabase/migrations/x.sql"],
  "an untracked migration is ALWAYS real dirt");

// ── ledgerHasEntries — the applied-ledger gate's shape rules (round 4) ──
// Only an object row with a non-empty string name (the recorder's one shape)
// counts as a real entry; junk rows alone must not pin a worktree forever.
ok(ledgerHasEntries(JSON.stringify([{ name: "add_widget_flag", ts: "2026-08-18T00:00:00Z" }])),
  "a real recorder entry counts");
ok(ledgerHasEntries(JSON.stringify([{ bogus: true }, { name: "real_one" }])),
  "one real entry among junk still counts");
ok(!ledgerHasEntries(JSON.stringify([])), "an empty ledger has no entries");
ok(!ledgerHasEntries(JSON.stringify([{ bogus: true }, { name: 123 }, { name: "  " }, null])),
  "junk-only rows (no name / non-string / blank) do not count");
ok(!ledgerHasEntries(JSON.stringify({ name: "not-an-array" })), "a non-array ledger has no entries");
assert.throws(() => ledgerHasEntries("{not json"), "unparseable text throws — the caller decides");
pass++;

// ── ledgerKeepsWorktree — the read-result → keep decision (CodeRabbit 2026-08-19) ──
// Fail toward KEEP on any doubt: ENOENT (truly absent) is the ONLY case that
// lets a worktree be swept; unreadable or malformed keeps it.
ok(!ledgerKeepsWorktree({ readError: Object.assign(new Error("no such file"), { code: "ENOENT" }) }),
  "absent ledger (ENOENT) → does NOT keep (sweepable)");
ok(ledgerKeepsWorktree({ readError: Object.assign(new Error("permission denied"), { code: "EACCES" }) }),
  "present-but-unreadable (EACCES) → KEEP");
ok(ledgerKeepsWorktree({ readError: Object.assign(new Error("is a directory"), { code: "EISDIR" }) }),
  "present-but-unreadable (EISDIR) → KEEP");
ok(ledgerKeepsWorktree({ readError: new Error("mystery I/O") }),
  "read error with NO code → present, cause unknown → KEEP");
ok(ledgerKeepsWorktree({ rawText: "{not json" }),
  "malformed ledger text → contents unknown → KEEP");
ok(ledgerKeepsWorktree({ rawText: JSON.stringify([{ name: "add_widget_flag" }]) }),
  "readable ledger WITH a real entry → KEEP");
ok(!ledgerKeepsWorktree({ rawText: JSON.stringify([]) }),
  "readable EMPTY ledger → no entries → does NOT keep");
ok(!ledgerKeepsWorktree({ rawText: JSON.stringify([{ bogus: true }]) }),
  "readable junk-only ledger → no real entry → does NOT keep");

// ── Ignored files `git worktree remove` would delete silently (2026-11-03) ──
eq(classifyWorktree({ ...finished, preciousIgnored: 2 }, ctx).reason, "ignored-files", "non-rebuildable ignored files → keep");
eq(classifyWorktree({ ...finished, preciousIgnored: null }, ctx).reason, "ignored-files", "unreadable ignored list → keep");
eq(classifyWorktree({ ...finished, preciousIgnored: undefined }, ctx).reason, "ignored-files", "unknown ignored list → keep");
const ignoredText = [
  "!! node_modules/", "!! dist/", "!! graphify-out/", "!! .claude/session-state/", "!! .claude/tmp/",
  "!! .codex/agents/", "!! .impeccable/hook.cache.json", "!! INV-2026-0002.pdf", "!! supabase/.temp/",
  "!! scripts/x/node_modules/", "!! tsconfig.app.tsbuildinfo", "!! .claude/settings.local.json", "!! .husky/_/",
  "?? src/new.ts", " M src/app.ts",
].join("\n");
eq(preciousIgnored(ignoredText), [], "rebuildable ignored paths (and non-ignored lines) don't count");
eq(preciousIgnored([
  "!! .env", "!! .env.local", "!! backups/", "!! crx.dump", "!! output/", "!! scripts/local-app/.state/",
  "!! 2026-07-26-supplier-pricing-phase3-owner-decision-sheet.csv", "!! harness-pr-body.local", "!! docs/.obsidian/",
  "!! .vercel/", "!! dist-old/", "!! src/dist/x.sql",
  "!! INV-2026-0107.pdf", "!! exports/INV-2026-0002.pdf", "!! build.generated.pdf", "!! notes.log",
].join("\n")).length, 16, "secrets, backups, dumps, local state, real invoices, logs and lookalikes all count as precious");
ok(isRebuildableIgnored("node_modules"), "bare node_modules is rebuildable");
ok(!isRebuildableIgnored(""), "empty path is not rebuildable");
ok(!isRebuildableIgnored(".claude/session-state-backup/"), "lookalike of a rebuildable dir is precious");

// ── Left-over folders git no longer lists (husks) ──
const OLD = NOW - (ACTIVE_WINDOW_MS + 60_000);
const husk = { registered: false, hasGit: false, realFiles: 0, newestMtimeMs: OLD };
eq(classifyHusk(husk, { nowMs: NOW }), { action: "remove", reason: "empty-husk" }, "old husk with no real files → remove");
eq(classifyHusk({ ...husk, realFiles: 1 }, { nowMs: NOW }).reason, "husk-has-files", "husk holding a file → report only");
eq(classifyHusk({ ...husk, realFiles: null }, { nowMs: NOW }).reason, "husk-has-files", "unreadable husk → keep");
eq(classifyHusk({ ...husk, newestMtimeMs: NOW - 60_000 }, { nowMs: NOW }).reason, "recently-active", "brand-new folder (maybe mid-creation) → keep");
eq(classifyHusk({ ...husk, newestMtimeMs: 0 }, { nowMs: NOW }).reason, "recently-active", "unknown age → keep");
eq(classifyHusk({ ...husk, registered: true }, { nowMs: NOW }).reason, "not-husk", "a registered worktree is never a husk");
eq(classifyHusk({ ...husk, hasGit: true }, { nowMs: NOW }).reason, "not-husk", "a folder with .git is never a husk");

// normPath sanity
eq(normPath("C:\\A\\B\\"), "c:/a/b", "normPath lowercases + forward-slashes + strips trailing");
ok(HARNESS_MARKER === "/.claude/worktrees/", "harness marker stable");

console.log(`worktree-cleanup-lib: ${pass} assertions passed`);
