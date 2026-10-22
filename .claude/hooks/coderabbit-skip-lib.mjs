// MASON'S "SKIP CODERABBIT" (Mason, 2026-10-22: "allow me to tell the session to
// skip coderabbit even if it is money and the LLM accept my command"; then
// "make sure we set that up for the Per PR version before merge, dont grant that
// session 24 free on any other pr").
//
// A money PR (or one labelled needs-coderabbit) merges, or applies its
// migration, only after CodeRabbit completes a review of its head
// (codex-bot-review-lib.mjs, evaluateCodeRabbitRequirement). This module is how
// Mason waives that one requirement for ONE NAMED PR:
//   1. He sends a message that STARTS with `skip coderabbit` and names the pull
//      request: `skip coderabbit #1018` (or `skip coderabbit on PR 1018`; a short
//      list such as `#1018 #1020` names each). Any case; "code rabbit" spelled
//      apart works too. "don't skip coderabbit" does not start with it, so it
//      never counts, and `skip coderabbit` with no number records nothing.
//   2. coderabbit-skip-prompt.mjs, run by Claude Code (and Codex) on each
//      message sent into a session, records one waiver per named PR, for THAT
//      session only, good for 24 hours. A message starting `use coderabbit`
//      cancels every waiver this session holds.
//   3. The merge gates and the migration landing gate accept a waiver in place
//      of a missing CodeRabbit review only for the PR it names, and only when the
//      merge or apply runs in the session that holds it. Every other PR still
//      needs its review.
//
// What it does NOT waive: the exact-SHA Sol review, every required check, and
// the rule that every CodeRabbit thread already on the PR is replied to and
// resolved. A lookup that fails (unreadable) still refuses: the waiver answers
// "no review was done", not "GitHub could not be read".
//
// THE TRADE-OFF (same as owner-approval-lib.mjs). A peer session's message, a
// handoff or a relayed "Mason said skip" arrives wrapped in an envelope, so it
// does not START with the words and records nothing; a waiver in another
// conversation never counts here. Nothing stops an agent that deliberately
// fakes one, by running the hook by hand with a made-up message: agents run on
// Mason's PC with his permissions. Naming the PR limits what a forged waiver
// reaches to that one PR. The file lives in .claude/session-state, which the
// review proof guard keeps file tools out of.

// Node built-ins only: the Codex production gate imports this at startup, and
// it is on that gate's protected-harness list (Codex App P1 on #1035), so it
// must not pull in unprotected modules.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CODERABBIT_SKIP_PURPOSE = "crx-coderabbit-skip-v2";
export const CODERABBIT_SKIP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A message names a handful of PRs at most; more is not a deliberate list.
const MAX_NAMED_PRS = 5;

const SESSION_ID_RE = /^[0-9A-Za-z_-]{8,128}$/;
const SKIP_RE = /^\s*skip\s+code\s*rabbit\b/i;
const CANCEL_RE = /^\s*(?:use|require)\s+code\s*rabbit\b/i;
// What may follow the words: optional "on"/"for", then one or more PR numbers,
// each optionally written "PR", "pull request" or "#", separated by spaces,
// commas, "&" or "and". The list must come straight after the words.
const PR_REF = String.raw`(?:(?:pr|pull\s+request)\s*)?#?\d{1,7}`;
const SKIP_LIST_RE = new RegExp(
  String.raw`^\s*skip\s+code\s*rabbit[\s:,-]+(?:(?:on|for)\s+)?(${PR_REF}(?:\s*(?:,|&|\band\b)?\s*${PR_REF})*)(?!\d)`,
  "i",
);

/**
 * What Mason's message asks for: { kind: "skip", pullRequests: [n, ...] } when
 * it starts with `skip coderabbit` and names PRs; { kind: "skip-unnamed" } when
 * it starts with the words but names no PR; { kind: "cancel" } for
 * `use coderabbit`; otherwise null.
 */
export function coderabbitSkipCommand(reply) {
  const text = String(reply ?? "");
  if (SKIP_RE.test(text)) {
    const list = SKIP_LIST_RE.exec(text);
    const numbers = list ? [...new Set((list[1].match(/\d+/g) || []).map(Number))].filter((n) => n > 0) : [];
    if (numbers.length === 0 || numbers.length > MAX_NAMED_PRS) return { kind: "skip-unnamed" };
    return { kind: "skip", pullRequests: numbers };
  }
  if (CANCEL_RE.test(text)) return { kind: "cancel" };
  return null;
}

/**
 * The .claude/session-state folders of this session's checkout(s), one per
 * distinct real folder (Windows paths compared case-insensitively). The same
 * rule as owner-approval-lib's ownerRequestDirs, kept here so the hook and every
 * gate resolve identical folders without importing that module.
 */
export function skipStateDirs(sessionFolders) {
  const canonical = (s) => {
    const r = path.resolve(s);
    try { return realpathSync.native(r); } catch { return r; }
  };
  const key = (p) => (process.platform === "win32" ? p.toLowerCase() : p);
  const roots = new Map();
  for (const s of (sessionFolders || []).filter(Boolean)) {
    const c = canonical(String(s));
    if (!roots.has(key(c))) roots.set(key(c), c);
  }
  return [...roots.values()].map((r) => path.join(r, ".claude", "session-state"));
}

const usablePr = (n) => Number.isInteger(n) && n > 0;
export const coderabbitSkipFileName = (sessionId, pullRequest) => `coderabbit-skip-${sessionId}-pr${pullRequest}.json`;
export const usableSkipSessionId = (sessionId) => SESSION_ID_RE.test(String(sessionId || ""));
// Every waiver file this session could hold, whatever PR it names.
const sessionFileRe = (sessionId) => new RegExp(`^coderabbit-skip-${sessionId}-pr\\d+\\.json$`);

/**
 * Record Mason's waiver for ONE pull request in this session, in every folder of
 * `dirs` that already has .claude/ (never creates project folders). Returns the
 * payload, or null when nothing could be written.
 */
export function recordCodeRabbitSkip({ dirs, sessionId, pullRequest, said, now = Date.now() }) {
  if (!usableSkipSessionId(sessionId) || !usablePr(pullRequest)) return null;
  const payload = {
    purpose: CODERABBIT_SKIP_PURPOSE,
    sessionId,
    pullRequest,
    said: String(said ?? "").trim().slice(0, 200),
    recordedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CODERABBIT_SKIP_MAX_AGE_MS).toISOString(),
  };
  let wrote = 0;
  for (const dir of dirs || []) {
    try {
      if (!existsSync(path.dirname(dir))) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, coderabbitSkipFileName(sessionId, pullRequest)), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      wrote++;
    } catch { /* another folder may still take it */ }
  }
  return wrote > 0 ? payload : null;
}

/** Remove every waiver this session holds, whatever PR it names. Returns how many files were removed. */
export function cancelCodeRabbitSkip({ dirs, sessionId, remove = (file) => rmSync(file, { force: true }), list = readdirSync }) {
  if (!usableSkipSessionId(sessionId)) return 0;
  const mine = sessionFileRe(sessionId);
  let removed = 0;
  for (const dir of dirs || []) {
    let names;
    try { names = list(dir); } catch { continue; } // withdrawCodeRabbitSkip re-checks what is left
    for (const name of names) {
      if (!mine.test(String(name))) continue;
      try { remove(path.join(dir, String(name))); removed++; } catch { /* re-checked below */ }
    }
  }
  return removed;
}

// True unless the file is provably absent: existsSync also says false when a
// permission error hides the file, which would report a live waiver as gone
// (Codex App P2 on #1035). Only ENOENT/ENOTDIR count as absent.
export function mayExist(file, stat = lstatSync) {
  try { stat(file); return true; }
  catch (error) { return !(error?.code === "ENOENT" || error?.code === "ENOTDIR"); }
}

/**
 * Mason's `use coderabbit`: remove every waiver of this session, then check none
 * is left, because a copy that could not be deleted keeps the gates accepting it
 * (Luna round 2). Any file left counts, readable or not (Luna round 3), and a
 * folder that cannot be listed (anything but "does not exist") counts as still
 * holding one (Codex App P2). Returns { removed, stillLive }.
 */
export function withdrawCodeRabbitSkip({ dirs, sessionId, remove, list = readdirSync, exists = (file) => mayExist(file) }) {
  const removed = cancelCodeRabbitSkip({ dirs, sessionId, list, ...(remove ? { remove } : {}) });
  if (!usableSkipSessionId(sessionId)) return { removed, stillLive: false };
  const mine = sessionFileRe(sessionId);
  const stillLive = (dirs || []).some((dir) => {
    let names;
    try { names = list(dir); }
    catch (error) { return !(error?.code === "ENOENT" || error?.code === "ENOTDIR"); }
    return names.some((name) => mine.test(String(name)) && exists(path.join(dir, String(name))));
  });
  return { removed, stillLive };
}

/**
 * This session's live waiver for THIS pull request, or null. A waiver naming
 * another PR, another session, or anything malformed or expired is no waiver
 * (the gate then requires the review).
 */
export function findCodeRabbitSkip({ dirs, sessionId, pullRequest, now = Date.now() }) {
  if (!usableSkipSessionId(sessionId) || !usablePr(pullRequest)) return null;
  for (const dir of dirs || []) {
    let data;
    try { data = JSON.parse(readFileSync(path.join(dir, coderabbitSkipFileName(sessionId, pullRequest)), "utf8")); }
    catch { continue; }
    if (data?.purpose !== CODERABBIT_SKIP_PURPOSE || data?.sessionId !== sessionId || data?.pullRequest !== pullRequest) continue;
    const recorded = Date.parse(data?.recordedAt);
    const expires = Date.parse(data?.expiresAt);
    if (!Number.isFinite(recorded) || !Number.isFinite(expires)) continue;
    // A waiver dated in the future, or one claiming more than 24 hours, is not one he gave
    // (Luna round 1: no grace window, so it never outlives 24 hours from the gate's clock).
    if (recorded > now || expires - recorded > CODERABBIT_SKIP_MAX_AGE_MS) continue;
    if (now >= expires) continue;
    return data;
  }
  return null;
}

/** The note a gate prints when it lets a money PR through on Mason's waiver. */
export function coderabbitSkipNotice(prefix, selector, skip) {
  return (
    `${prefix}: CODERABBIT SKIPPED BY MASON — #${skip.pullRequest} has no CodeRabbit review of its head, but Mason waived ` +
    `that requirement for this PR in this session at ${skip.recordedAt} ("${skip.said}"; valid until ${skip.expiresAt}). ` +
    "The Sol review, required checks and CodeRabbit thread rules still applied. Record it on the PR: " +
    `gh pr comment ${selector || skip.pullRequest} --body "CodeRabbit review skipped at Mason's request (said in the session that merged this PR)."\n`
  );
}
