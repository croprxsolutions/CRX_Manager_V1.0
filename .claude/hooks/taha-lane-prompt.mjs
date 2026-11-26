#!/usr/bin/env node
// UserPromptSubmit half of the Taha lane block (taha-lane-lib.mjs, Mason 2026-11-22).
// Mason's whole message `taha override #<PR> <code>` turns the code a merge refusal
// issued for that PR into a 24-hour override for that PR (later pushes included, Mason 2026-11-25).
// Except on a PR that changes the block's own files: there it covers that head only (#2303).
// `... unavailable: <reason>` also lets the migration landing gate use it in place of Taha's
// go-ahead and 4-hour hold on a release or hotfix (Mason, 2026-11-25); a plain override does not.
// Anything else: silent, except a message that mentions the command but is not
// exactly it, which is refused out loud.

import { readFileSync } from "node:fs";
import { replyWithoutReminders } from "./owner-approval-lib.mjs";
import { skipStateDirs } from "./coderabbit-skip-lib.mjs";
import { recordTahaLaneOverride, tahaOverrideAttempt, tahaOverrideCommand } from "./taha-lane-lib.mjs";

function emit(extra) {
  if (extra) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

const reply = replyWithoutReminders(payload?.prompt);
const command = tahaOverrideCommand(reply);
if (!command) {
  emit(tahaOverrideAttempt(reply)
    ? "TAHA LANE OVERRIDE NOT RECORDED — Mason's message mentioned \"taha override\" but was not exactly `taha override #<PR> <6-digit code>` (optionally followed by `unavailable: <reason>`). Nothing was overridden. Ask him to send it again as a message of its own."
    : "");
}

// Output only outside this try: under prompt-router.mjs process.exit throws.
let res;
try {
  res = recordTahaLaneOverride({ dirs: skipStateDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]), ...command });
} catch (error) {
  res = { ok: false, reason: `the override hook failed (${error?.message || error})` };
}
if (!res.ok) emit(`TAHA LANE OVERRIDE NOT RECORDED — Mason sent #${command.pullRequest} ${command.code}, but ${res.reason}. Nothing was overridden. Tell him in one line; retrying the merge issues a fresh code.`);
emit(`TAHA LANE OVERRIDE RECORDED — Mason let PR #${res.payload.pullRequest} past Taha's checks until ${res.payload.expiresAt}: ` +
  (res.payload.tahaUnavailable
    ? `the lane block, and for a release or hotfix PR Taha's live-apply go-ahead and 4-hour hold (Mason says Taha is unavailable: ${res.payload.tahaUnavailable}) `
    : "the staging-merge lane block only; a live apply still needs Taha's go-ahead (add `unavailable: <reason>` if Mason says Taha can't) ") +
  "(this PR only, later pushes included unless it changes the block's own files; every other gate still applies). " +
  "Confirm to him in one line and retry; on a staging merge the lane gate posts the PR comment telling Taha.");
