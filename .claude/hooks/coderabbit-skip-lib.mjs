// MASON'S "SKIP CODERABBIT" (Mason, 2026-10-22: "allow me to tell the session to
// skip coderabbit even if it is money and the LLM accept my command").
//
// A money PR (or one labelled needs-coderabbit) merges, or applies its
// migration, only after CodeRabbit completes a review of its head
// (codex-bot-review-lib.mjs, evaluateCodeRabbitRequirement). This module is how
// Mason waives that one requirement:
//   1. He sends a message that STARTS with `skip coderabbit` (any case, "code
//      rabbit" spelled apart too). "don't skip coderabbit" does not start with
//      it, so it never counts.
//   2. coderabbit-skip-prompt.mjs, run by Claude Code (and Codex) on each
//      message sent into a session, records a waiver for THAT session only,
//      good for 24 hours. A message starting `use coderabbit` cancels it.
//   3. The merge gates and the migration landing gate accept the waiver in
//      place of a missing CodeRabbit review, only when the merge or apply runs
//      in the session that holds it.
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
// Mason's PC with his permissions. The file lives in .claude/session-state,
// which the review proof guard keeps file tools out of.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export const CODERABBIT_SKIP_PURPOSE = "crx-coderabbit-skip-v1";
export const CODERABBIT_SKIP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SESSION_ID_RE = /^[0-9A-Za-z_-]{8,128}$/;
const SKIP_RE = /^\s*skip\s+code\s*rabbit\b/i;
const CANCEL_RE = /^\s*(?:use|require)\s+code\s*rabbit\b/i;

/** "skip" when Mason's message starts with `skip coderabbit`, "cancel" for `use coderabbit`, else null. */
export function coderabbitSkipCommand(reply) {
  const text = String(reply ?? "");
  if (SKIP_RE.test(text)) return "skip";
  if (CANCEL_RE.test(text)) return "cancel";
  return null;
}

export const coderabbitSkipFileName = (sessionId) => `coderabbit-skip-${sessionId}.json`;
export const usableSkipSessionId = (sessionId) => SESSION_ID_RE.test(String(sessionId || ""));

/**
 * Record Mason's waiver for this session in every folder of `dirs` that already
 * has .claude/ (never creates project folders). Returns the payload, or null
 * when nothing could be written.
 */
export function recordCodeRabbitSkip({ dirs, sessionId, said, now = Date.now() }) {
  if (!usableSkipSessionId(sessionId)) return null;
  const payload = {
    purpose: CODERABBIT_SKIP_PURPOSE,
    sessionId,
    said: String(said ?? "").trim().slice(0, 200),
    recordedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CODERABBIT_SKIP_MAX_AGE_MS).toISOString(),
  };
  let wrote = 0;
  for (const dir of dirs || []) {
    try {
      if (!existsSync(path.dirname(dir))) continue;
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, coderabbitSkipFileName(sessionId)), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      wrote++;
    } catch { /* another folder may still take it */ }
  }
  return wrote > 0 ? payload : null;
}

/** Remove this session's waiver everywhere. Returns how many files were removed. */
export function cancelCodeRabbitSkip({ dirs, sessionId, remove = (file) => rmSync(file, { force: true }) }) {
  if (!usableSkipSessionId(sessionId)) return 0;
  let removed = 0;
  for (const dir of dirs || []) {
    const file = path.join(dir, coderabbitSkipFileName(sessionId));
    try {
      if (!existsSync(file)) continue;
      remove(file);
      removed++;
    } catch { /* withdrawCodeRabbitSkip re-checks what is left */ }
  }
  return removed;
}

/**
 * Mason's `use coderabbit`: remove the waiver, then check none is still live,
 * because a copy that could not be deleted keeps the gates accepting it
 * (Luna round 2). Returns { removed, stillLive }.
 */
export function withdrawCodeRabbitSkip({ dirs, sessionId, now = Date.now(), remove }) {
  const removed = cancelCodeRabbitSkip({ dirs, sessionId, ...(remove ? { remove } : {}) });
  return { removed, stillLive: Boolean(findCodeRabbitSkip({ dirs, sessionId, now })) };
}

/**
 * This session's live waiver, or null. Anything malformed, for another
 * session, or expired is no waiver (the gate then requires the review).
 */
export function findCodeRabbitSkip({ dirs, sessionId, now = Date.now() }) {
  if (!usableSkipSessionId(sessionId)) return null;
  for (const dir of dirs || []) {
    let data;
    try { data = JSON.parse(readFileSync(path.join(dir, coderabbitSkipFileName(sessionId)), "utf8")); }
    catch { continue; }
    if (data?.purpose !== CODERABBIT_SKIP_PURPOSE || data?.sessionId !== sessionId) continue;
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
  const which = selector ? `#${String(selector).replace(/^#/, "")}` : "this pull request";
  return (
    `${prefix}: CODERABBIT SKIPPED BY MASON — ${which} has no CodeRabbit review of its head, but Mason waived ` +
    `that requirement in this session at ${skip.recordedAt} ("${skip.said}"; valid until ${skip.expiresAt}). ` +
    "The Sol review, required checks and CodeRabbit thread rules still applied. Record it on the PR: " +
    `gh pr comment ${selector || "<number>"} --body "CodeRabbit review skipped at Mason's request (said in the session that merged this PR)."\n`
  );
}
