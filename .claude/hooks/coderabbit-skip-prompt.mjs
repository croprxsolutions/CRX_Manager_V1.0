#!/usr/bin/env node
// UserPromptSubmit half of Mason's "skip coderabbit" (coderabbit-skip-lib.mjs;
// Mason, 2026-10-22).
//   - His message STARTS with `skip coderabbit` → this session may merge money
//     PRs (and apply their migrations) without a CodeRabbit review for 24 hours.
//   - His message starts with `use coderabbit` → that waiver is removed.
//   - Anything else → nothing happens and the hook says nothing.
// A whole <system-reminder> block the app puts in front of his words is not
// part of the message (owner-approval-lib.mjs, replyWithoutReminders).

import { readFileSync } from "node:fs";
import { replyWithoutReminders } from "./owner-approval-lib.mjs";
import { coderabbitSkipCommand, recordCodeRabbitSkip, skipStateDirs, withdrawCodeRabbitSkip } from "./coderabbit-skip-lib.mjs";

function emit(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  }
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

const reply = replyWithoutReminders(payload?.prompt);
const command = coderabbitSkipCommand(reply);
if (!command) emit();

// Output happens only outside this try: under prompt-router.mjs process.exit
// throws, and a catch here would turn a clean exit into a failure.
let recorded = null;
let removed = 0;
let stillLive = false;
let failure = "";
// The same id the gates read: Codex may send it camelCased (Luna round 2).
const sessionId = payload?.session_id ?? payload?.sessionId;
try {
  const dirs = skipStateDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
  if (command === "skip") recorded = recordCodeRabbitSkip({ dirs, sessionId, said: reply });
  else ({ removed, stillLive } = withdrawCodeRabbitSkip({ dirs, sessionId }));
} catch (error) {
  failure = String(error?.message || error);
  stillLive = command === "cancel";
}

if (command === "cancel") {
  if (stillLive) {
    emit([
      `CODERABBIT SKIP NOT CANCELLED — Mason said "use coderabbit", but his waiver for this session could not be removed${failure ? ` (${failure})` : ""}, so the merge gates may still accept it.`,
      "Tell him in one line, and request the CodeRabbit review on money PRs anyway: treat the waiver as withdrawn.",
    ].join("\n"));
  }
  emit(removed > 0
    ? "CODERABBIT SKIP CANCELLED — Mason said to use CodeRabbit again. Money PRs merged from this session need a completed CodeRabbit review of their head again."
    : "");
}

if (!recorded) {
  emit([
    `CODERABBIT SKIP NOT RECORDED — Mason's message started with "skip coderabbit", but the waiver could not be saved` +
      `${failure ? ` (${failure})` : " (this message carried no usable session id, or no folder of this session has .claude/)"}.`,
    "Tell him in one line: the merge gates will still require a CodeRabbit review on money PRs from this session.",
  ].join("\n"));
}

emit([
  `CODERABBIT SKIP RECORDED — Mason waived the CodeRabbit review requirement for money PRs merged from THIS session, until ${recorded.expiresAt}.`,
  "This is Mason's own instruction, recorded from his message: he does not want a CodeRabbit review (@coderabbitai full review) requested for PRs merged from this session while it lasts. The merge gates and the migration landing gate accept the waiver here only.",
  "Everything else still applies: the exact-SHA Sol review, every required check, and replying to and resolving any CodeRabbit thread already on the PR.",
  "When you merge a PR that had no CodeRabbit review under this waiver, post one comment on it first: " +
    "gh pr comment <n> --body \"CodeRabbit review skipped at Mason's request (said in the session that merged this PR).\"",
  "Confirm to Mason in one line. He cancels it by starting a message with: use coderabbit",
].join("\n"));
