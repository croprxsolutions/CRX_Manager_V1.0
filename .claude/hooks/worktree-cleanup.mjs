#!/usr/bin/env node
// SessionStart hook: auto-remove FINISHED worktrees/branches (Mason, 2026-07-13:
// "make sessions clean up their own worktree when done so we stop doing this by hand").
// Registered with "async": true (2026-10-23): over ~200 branches the `git cherry`
// pass took 30-35 s against its 30 s timeout, so it held up every session start
// and was killed before finishing. In the background no timeout applies and its
// report arrives on the next turn.
//
// A session can't delete its OWN active worktree (it's standing in it), so the
// contract is: each new session sweeps away the PREVIOUS finished ones. Net
// effect — worktrees and dead branches stop piling up, deferred by one session.
//
// SAFETY (the whole point): the pure classifier in worktree-cleanup-lib.mjs only
// ever marks something for removal when it is PROVABLY finished — its head is a
// merged GitHub PR's head (squash merges) or `git cherry` finds it all in
// origin/main, clean, no ignored files that can't be rebuilt, unlocked, not the
// active session, not a protected branch, and (for worktrees) under
// .claude/worktrees/. Left-over folders there that git no longer lists go only
// when they hold no real file. C:\CRX_* folders are listed by --report, never
// removed. Every deletion prints a recovery SHA. Fail-open: any error → do
// nothing, emit nothing.
//
// Modes:
//   (hook / default)  perform cleanup, emit a SessionStart report only if it acted
//   --report          DRY RUN: print the plan in plain text, delete nothing
//   --write           perform cleanup and print a plain-text report (manual use)

import { readFileSync, existsSync, statSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { parseWorktreePorcelain, mergedPrHeadsFromCache } from "./worktree-awareness-lib.mjs";
import {
  planCleanup, meaningfulDirt, ledgerKeepsWorktree, preciousIgnored, classifyHusk, normPath, IGNORABLE_DIRT_PATH,
} from "./worktree-cleanup-lib.mjs";

const argv = process.argv.slice(2);
const REPORT_ONLY = argv.includes("--report");
const HOOK_MODE = !argv.includes("--report") && !argv.includes("--write"); // default invocation = SessionStart hook

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function git(args, cwd, timeout = 6000) {
  return execFileSync("git", args, {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "ignore"], cwd: cwd || projectDir,
  });
}
function gitTry(args, cwd) { try { return { ok: true, out: git(args, cwd) }; } catch (e) { return { ok: false, out: "", err: e }; } }

// SessionStart passes a JSON payload on stdin; read & ignore so the pipe closes.
if (HOOK_MODE) { try { readFileSync(0, "utf8"); } catch { /* fine */ } }

function emitHook(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: extra },
    }));
  }
  process.exit(0);
}
// Unified "done, output nothing further" for whichever mode we're in.
function done(reportText) {
  if (HOOK_MODE) emitHook(reportText || null);
  if (reportText) process.stdout.write(reportText + "\n");
  process.exit(0);
}

try {
  // Must be a git repo.
  const wtList = gitTry(["worktree", "list", "--porcelain"]);
  if (!wtList.ok) done(null);

  // Parse worktrees (path/branch/head/detached) + capture the `locked` flag,
  // which the shared parser doesn't track. A locked worktree = a held/active
  // session; we never remove it.
  const entries = parseWorktreePorcelain(wtList.out);
  const lockedPaths = new Set();
  {
    let curPath = null;
    for (const raw of wtList.out.split("\n")) {
      const line = raw.replace(/\r/g, "");
      if (line.startsWith("worktree ")) curPath = line.slice("worktree ".length).trim();
      else if (line === "locked" || line.startsWith("locked ")) { if (curPath) lockedPaths.add(curPath); }
    }
  }

  // Best-effort refresh of origin/main — at most once per 30 minutes. This hook
  // fires on session startup, and a network fetch every time made session starts
  // slow and timeout-prone (2026-08-18 hook audit: SessionStart p90 ~11s). A
  // ≤30-min-old FETCH_HEAD is fresh enough here, and skipping is safe for the
  // same reason a failed fetch is: a STALE origin/main can only make us MORE
  // conservative (fewer things look merged), never less.
  const FETCH_TTL_MS = 30 * 60 * 1000;
  let fetchedRecently = false;
  const fetchHeadPath = gitTry(["rev-parse", "--git-path", "FETCH_HEAD"]);
  if (fetchHeadPath.ok) {
    try {
      fetchedRecently = Date.now() - statSync(path.resolve(projectDir, fetchHeadPath.out.trim())).mtimeMs < FETCH_TTL_MS;
    } catch { /* no FETCH_HEAD yet → fetch below */ }
  }
  if (!fetchedRecently) gitTry(["fetch", "origin", "--quiet"]);

  // Need origin/main to judge "merged". Without it, do nothing (fail safe).
  if (!gitTry(["rev-parse", "--verify", "--quiet", "origin/main"]).ok) done(null);

  const currentTop = (gitTry(["rev-parse", "--show-toplevel"]).out || projectDir).trim();
  const commonDir = path.resolve(projectDir, (gitTry(["rev-parse", "--git-common-dir"]).out || ".git").trim());
  const mainRoot = path.dirname(commonDir);

  // Merged-PR heads cached by worktree-awareness.mjs (it refreshes the file at
  // session start). A squash merge lands a new commit, so `git cherry` calls a
  // multi-commit squash-merged branch unmerged; a head that IS a merged PR's
  // head is landed. The cache holds only PRs merged into main (`gh pr list
  // --base main`). Missing cache → cherry only (more conservative, never less).
  let mergedHeads = null;
  try { mergedHeads = mergedPrHeadsFromCache(readFileSync(path.join(commonDir, "crx-merged-pr-heads.json"), "utf8")); } catch { /* not cached yet */ }
  const prOfSha = (sha) => (mergedHeads && sha ? mergedHeads.get(String(sha).toLowerCase()) : undefined);

  // A branch is "merged" iff its tip is a merged PR's head, or
  // `git cherry origin/main <branch>` reports no '+' lines.
  function isMerged(branch) {
    if (prOfSha((gitTry(["rev-parse", `refs/heads/${branch}`]).out || "").trim()) !== undefined) return true;
    const r = spawnSync("git", ["cherry", "origin/main", branch], {
      encoding: "utf8", timeout: 8000, cwd: projectDir,
    });
    if (r.status !== 0 || r.error) return false; // unknown → treat as NOT merged (safe)
    return !r.stdout.split("\n").some((l) => l.startsWith("+"));
  }
  // A detached head has no branch to cherry; it landed iff it is a merged PR's
  // head or already inside origin/main.
  function headLanded(sha) {
    if (!sha) return false;
    if (prOfSha(sha) !== undefined) return true;
    return spawnSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], { timeout: 8000, cwd: projectDir }).status === 0;
  }
  // Ignored, non-rebuildable paths `git worktree remove` would delete silently.
  // null (unreadable) → the classifier keeps the worktree.
  function preciousIgnoredCount(wtPath) {
    if (!existsSync(wtPath)) return 0;
    const r = gitTry(["status", "--porcelain", "--ignored"], wtPath);
    return r.ok ? preciousIgnored(r.out).length : null;
  }
  function porcelain(wtPath) {
    const r = gitTry(["status", "--porcelain"], wtPath);
    return r.ok ? r.out : null; // null = unreadable
  }
  // "Dirty" = has MEANINGFUL uncommitted work. A harness-touched
  // .claude/settings.local.json as the sole dirt does not count (see
  // IGNORABLE_DIRT_PATH in worktree-cleanup-lib.mjs) — that one file kept 11
  // fully-merged worktrees alive forever.
  function dirty(wtPath) {
    if (!existsSync(wtPath)) return false; // absent dir → let `git worktree remove` handle/prune it
    const out = porcelain(wtPath);
    return out === null ? true : meaningfulDirt(out).length > 0; // unreadable → assume dirty (keep)
  }

  // Newest mtime (ms) among a worktree's live-activity markers: its git HEAD
  // and reflog (touched on every commit/checkout/merge), and anything under
  // .claude/session-state (hook state an active session writes continuously).
  // Not the index: any `git status` (worktree-awareness runs one in every
  // worktree at each session start) may rewrite it, so every idle worktree
  // looked active forever (2026-11-03). Staged work is caught as dirty instead.
  // A recent value means a LIVE session — the classifier keeps it. Best-effort;
  // any error contributes nothing (0), so a worktree is never KEPT-forever on a
  // read error, only removed when it also looks provably finished.
  function lastActivityMs(wtPath) {
    if (!wtPath || !existsSync(wtPath)) return 0;
    const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
    let newest = 0;
    for (const rel of ["HEAD", "logs/HEAD"]) {
      const gp = gitTry(["rev-parse", "--git-path", rel], wtPath);
      if (gp.ok) newest = Math.max(newest, mtime(path.resolve(wtPath, gp.out.trim())));
    }
    // Codex and agent sessions keep their own state folders.
    for (const owner of [".claude", ".codex", ".agents"]) {
      const stateDir = path.join(wtPath, owner, "session-state");
      try {
        newest = Math.max(newest, mtime(stateDir));
        for (const name of readdirSync(stateDir)) newest = Math.max(newest, mtime(path.join(stateDir, name)));
      } catch { /* no session-state → contributes nothing */ }
    }
    return newest;
  }

  // Unresolved applied-source ledger = a recorded live apply whose committed
  // source stop-wrap never proved. Gitignored, so merged+clean can't see it;
  // sweeping the worktree would destroy the only record (Opus review
  // 2026-08-19). Fail toward KEEP on any doubt (CodeRabbit 2026-08-19): ENOENT
  // (truly absent) is the ONLY sweepable case — unreadable or malformed keeps
  // the worktree. The full decision lives in ledgerKeepsWorktree
  // (worktree-cleanup-lib.mjs), where every branch is unit-tested.
  function hasAppliedLedgerEntries(wtPath) {
    let rawText;
    let readError = null;
    try {
      rawText = readFileSync(path.join(wtPath, ".claude", "session-state", "applied-source-ledger.json"), "utf8");
    } catch (err) {
      readError = err;
    }
    return ledgerKeepsWorktree({ readError, rawText });
  }

  // Build worktree facts.
  const worktreeFacts = entries.map((e) => {
    // Read activity FIRST: `git status` below may rewrite the index and bump
    // its mtime, which would make every idle worktree look recently active.
    const activityMs = lastActivityMs(e.path);
    const merged = e.detached ? headLanded(e.head) : e.branch ? isMerged(e.branch) : false;
    return {
      path: e.path,
      branch: e.branch,
      head: e.head,
      detached: e.detached,
      locked: lockedPaths.has(e.path),
      dirty: !e.detached && !e.branch ? false : dirty(e.path),
      merged,
      lastActivityMs: activityMs,
      hasAppliedLedgerEntries: hasAppliedLedgerEntries(e.path),
      // Only worth the extra git call on a candidate.
      preciousIgnored: merged ? preciousIgnoredCount(e.path) : 0,
    };
  });
  const worktreeBranches = new Set(entries.map((e) => e.branch).filter(Boolean));

  // Orphan branches = local branches not checked out in any worktree.
  const allBranches = (gitTry(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).out || "")
    .split("\n").map((s) => s.trim()).filter(Boolean);
  const branchFacts = allBranches
    .filter((b) => !worktreeBranches.has(b))
    .map((b) => ({ branch: b, checkedOut: false, merged: isMerged(b) }));

  const plan = planCleanup({ worktrees: worktreeFacts, branches: branchFacts }, { currentPath: currentTop, nowMs: Date.now() });

  // Husks: folders under .claude/worktrees/ git no longer lists. The walk
  // never follows a link (lstat), so a dangling node_modules link is a link,
  // not a file, and its target is never entered.
  function scanHusk(dir) {
    let newest = 0;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let st;
      try { st = lstatSync(d); } catch { return { realFiles: null, newestMtimeMs: 0 }; }
      newest = Math.max(newest, st.mtimeMs);
      if (st.isSymbolicLink()) continue;
      if (!st.isDirectory()) return { realFiles: 1, newestMtimeMs: newest };
      try { for (const n of readdirSync(d)) stack.push(path.join(d, n)); } catch { return { realFiles: null, newestMtimeMs: 0 }; }
    }
    return { realFiles: 0, newestMtimeMs: newest };
  }
  const registered = new Set(entries.map((e) => normPath(e.path)));
  const huskRoot = path.join(mainRoot, ".claude", "worktrees");
  const husks = [];
  try {
    for (const name of readdirSync(huskRoot)) {
      const dir = path.join(huskRoot, name);
      try { if (!lstatSync(dir).isDirectory()) continue; } catch { continue; }
      const fact = { path: dir, registered: registered.has(normPath(dir)), hasGit: existsSync(path.join(dir, ".git")) };
      if (fact.registered || fact.hasGit) continue;
      Object.assign(fact, scanHusk(dir));
      husks.push({ ...fact, ...classifyHusk(fact) });
    }
  } catch { /* no worktrees folder */ }

  // Snapshot recovery SHAs BEFORE deleting anything.
  const shaOf = (ref) => (gitTry(["rev-parse", "--short", ref]).out || "").trim();
  for (const w of plan.removeWorktrees) w.sha = shaOf(w.branch || w.head);
  for (const b of plan.removeBranches) b.sha = shaOf(b.branch);
  const removeHusks = husks.filter((h) => h.action === "remove");

  const removed = [];
  const failed = [];

  if (!REPORT_ONLY) {
    for (const w of plan.removeWorktrees) {
      // Plain `remove` (no --force): git itself refuses if the tree became dirty
      // or locked in a race — a second safety net under the classifier.
      let rm = gitTry(["worktree", "remove", w.path]);
      if (!rm.ok) {
        // git refuses when the ONLY dirt is the ignorable harness file too. In
        // exactly that case (re-checked NOW, not at classification time — the
        // race safety net stays intact), restore/drop that one file and retry
        // plain remove once. Never --force: any other dirt still blocks.
        const out = existsSync(w.path) ? porcelain(w.path) : null;
        const lines = out === null ? [] : out.split("\n").filter((l) => l.trim());
        const onlyIgnorableDirt = lines.length > 0 && meaningfulDirt(out).length === 0;
        if (onlyIgnorableDirt) {
          // Save the file's bytes first: if the retry ALSO fails, the worktree
          // survives, and having reverted/deleted its permission grants without
          // removing it would be a destructive edit with no payoff (Opus
          // review 2026-08-19). Restore is best-effort.
          const dirtAbs = path.join(w.path, IGNORABLE_DIRT_PATH);
          const existedBefore = existsSync(dirtAbs);
          let savedDirt = null;
          if (existedBefore) { try { savedDirt = readFileSync(dirtAbs); } catch { /* present but unreadable */ } }
          const co = gitTry(["checkout", "HEAD", "--", IGNORABLE_DIRT_PATH], w.path); // tracked → restore index+worktree
          if (!co.ok) { try { rmSync(dirtAbs); } catch { /* untracked/missing */ } }
          rm = gitTry(["worktree", "remove", w.path]);
          if (!rm.ok) {
            // Retry failed → the worktree survives, so leave it in its ORIGINAL
            // state rather than whatever `checkout HEAD` re-materialized. If the
            // file EXISTED and we snapshotted it, restore those bytes. If it was
            // ABSENT originally (a deletion the user made, or genuinely missing),
            // the checkout may have re-created it from HEAD — remove it so the
            // surviving worktree isn't silently modified back to a file the user
            // had deleted (CodeRabbit PR #423). A present-but-unsnapshotted file
            // (read failed) is left as checked out — the best available state.
            if (existedBefore) {
              if (savedDirt !== null) { try { writeFileSync(dirtAbs, savedDirt); } catch { /* best-effort restore */ } }
            } else {
              try { rmSync(dirtAbs); } catch { /* nothing to undo */ }
            }
          }
        }
      }
      if (!rm.ok) { failed.push({ ...w, kind: "worktree" }); continue; }
      if (w.branch) gitTry(["branch", "-D", w.branch]); // free branch now that its worktree is gone
      removed.push({ kind: "worktree", ...w });
    }
    for (const b of plan.removeBranches) {
      const del = gitTry(["branch", "-D", b.branch]);
      if (!del.ok) { failed.push({ ...b, kind: "branch" }); continue; }
      removed.push({ kind: "branch", ...b });
    }
    if (removed.length) gitTry(["worktree", "prune"]); // tidy admin entries
    // A husk holds no real files, so nothing to recover. A locked file makes
    // rmSync throw; it stays for next time and is not reported each session.
    for (const h of removeHusks) {
      // Re-check right before deleting: another session may have reused the
      // path since the scan.
      const again = { registered: false, hasGit: existsSync(path.join(h.path, ".git")), ...scanHusk(h.path) };
      if (classifyHusk(again).action !== "remove") continue;
      try { rmSync(h.path, { recursive: true, force: true }); removed.push({ kind: "husk", path: h.path }); } catch { /* retried next session */ }
    }
  }

  // ── Build report ──
  const keptUnmerged = plan.keep.filter((k) => k.reason === "unmerged")
    .map((k) => `${k.branch}`);

  if (REPORT_ONLY) {
    const landedBy = (sha) => { const pr = prOfSha(gitTry(["rev-parse", sha]).out.trim()); return pr ? `merged PR #${pr}` : "in origin/main"; };
    const wLines = plan.removeWorktrees.map((w) => `  • ${w.path}  (${w.branch ? `branch ${w.branch}` : "detached"} — ${landedBy(w.branch || w.head)}, clean)`);
    const bLines = plan.removeBranches.map((b) => `  • branch ${b.branch}  (${landedBy(`refs/heads/${b.branch}`)})`);
    const hLines = removeHusks.map((h) => `  • ${h.path}  (left-over folder, no real files)`);
    const keptWorktrees = plan.keep.filter((k) => k.kind === "worktree" && k.reason !== "unmerged")
      .map((k) => `  • ${k.path} — ${k.reason}`);
    const keptHusks = husks.filter((h) => h.action === "keep").map((h) => `  • ${h.path} — ${h.reason === "husk-has-files" ? "left-over folder that still holds files: check by hand, may be unsaved work" : h.reason}`);
    // Folders beside the main checkout (C:\CRX_*): never deleted here, only listed.
    const sideLines = [];
    try {
      for (const name of readdirSync(path.dirname(mainRoot))) {
        const dir = path.join(path.dirname(mainRoot), name);
        if (!/^crx_/i.test(name) || /^crx_backups$/i.test(name) || normPath(dir) === normPath(mainRoot)) continue;
        try { if (!lstatSync(dir).isDirectory()) continue; } catch { continue; }
        const wt = worktreeFacts.find((f) => normPath(f.path) === normPath(dir));
        let verdict;
        if (wt) {
          verdict = wt.dirty ? "worktree with uncommitted work" : !wt.merged ? "worktree, not provably merged"
            : wt.preciousIgnored !== 0 ? "worktree, merged, but holds ignored files that can't be rebuilt (env, backups, notes…)" : "worktree, merged and clean: safe to remove";
        } else if (existsSync(path.join(dir, ".git"))) {
          const st = gitTry(["status", "--porcelain"], dir);
          const head = (gitTry(["rev-parse", "HEAD"], dir).out || "").trim();
          const clean = st.ok && meaningfulDirt(st.out).length === 0;
          verdict = `separate copy (clone), ${!st.ok ? "unreadable" : clean ? "clean" : "has uncommitted work"}, ${prOfSha(head) ? `head is merged PR #${prOfSha(head)}` : "head not a known merged PR"}`;
        } else {
          const s = scanHusk(dir);
          verdict = s.realFiles === 0 ? "no git, no real files: safe to remove" : "no git, holds files: check by hand";
        }
        sideLines.push(`  • ${dir} — ${verdict}`);
      }
    } catch { /* parent unreadable */ }
    const body = [
      `🧹 worktree-cleanup DRY RUN — would remove ${plan.removeWorktrees.length} worktree(s) + ${plan.removeBranches.length} branch(es) + ${removeHusks.length} left-over folder(s):`,
      ...wLines, ...bLines, ...hLines,
      keptWorktrees.length ? `Kept worktrees:\n${keptWorktrees.join("\n")}` : "",
      keptHusks.length ? `Kept left-over folders:\n${keptHusks.join("\n")}` : "",
      sideLines.length ? `Folders beside the main checkout (never auto-removed):\n${sideLines.join("\n")}` : "",
      keptUnmerged.length ? `Kept, not provably merged (${keptUnmerged.length}): ${keptUnmerged.join(", ")}` : "Kept: nothing unmerged.",
      mergedHeads ? "" : "(Merged-PR list not cached yet: squash-merged branches still look unmerged. A session start refreshes it.)",
      `(Nothing deleted — this is --report. Run without --report to execute.)`,
    ].filter(Boolean).join("\n");
    done(body);
  }

  if (removed.length === 0 && failed.length === 0) done(null); // stay silent when there was nothing to do

  const rLines = removed.map((r) =>
    r.kind === "husk"
      ? `  ✓ removed left-over folder ${r.path} (no real files)`
      : r.kind === "worktree"
        ? `  ✓ removed ${r.path} (${r.branch ? `branch ${r.branch}` : "detached"} — merged; recover: git branch ${r.branch || "<name>"} ${r.sha})`
        : `  ✓ deleted branch ${r.branch} (merged; recover: git branch ${r.branch} ${r.sha})`);
  const fLines = failed.map((f) => `  ⚠ could not remove ${f.kind} ${f.branch || f.path} (skipped — investigate)`);

  const report =
    `🧹 AUTO-CLEANED ${removed.length} finished item(s) (merged into origin/main or a merged PR, clean, recoverable):\n` +
    rLines.join("\n") +
    (fLines.length ? `\n${fLines.join("\n")}` : "") +
    // In a session the kept list is a count: every branch name (179 on
    // 2026-10-23, ~7K characters) was pasted into the session for nothing.
    (keptUnmerged.length
      ? (HOOK_MODE
        ? `\n\nKept ${keptUnmerged.length} branch(es) not provably merged (untouched; names: --report).`
        : `\n\nKept — not provably merged (untouched): ${keptUnmerged.join(", ")}`)
      : "") +
    `\n(From .claude/hooks/worktree-cleanup.mjs. Only provably-finished worktrees are removed; a session never removes its own. Dry-run: \`node .claude/hooks/worktree-cleanup.mjs --report\`.)`;

  done(report);
} catch (err) {
  // Absolute fail-open: never let cleanup brick a session start.
  if (!HOOK_MODE) process.stderr.write(`worktree-cleanup: skipped (${err && err.message})\n`);
  done(null);
}
