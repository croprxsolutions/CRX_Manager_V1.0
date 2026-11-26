#!/usr/bin/env node
// UserPromptSubmit half of the Taha lane block (taha-lane-lib.mjs, Mason 2026-11-22).
// Mason's whole message `taha override #<PR> <code>` turns the code a merge refusal
// issued for that PR into a 24-hour override for that PR (later pushes included, Mason 2026-11-25).
// Except on a PR that changes the block's own files: there it covers that head only (#2303).
// `... unavailable: <reason>`, with a code a live-apply refusal issued, lets the migration landing
// gate apply that commit without Taha's go-ahead and 4-hour hold (Mason, 2026-11-25); a plain override does not.
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
    ? `the live apply's wait for Taha's go-ahead and 4-hour hold, at commit ${res.payload.headSha} only (Mason says Taha is unavailable: ${res.payload.tahaUnavailable}; the apply tags Taha on the PR without that reason) `
    : "the staging-merge lane block only, never a live apply's wait for Taha (that needs the code a live-apply refusal gives, plus `unavailable: <reason>`) ") +
  "(this PR only; a staging-merge override covers later pushes unless the PR changes the block's own files; every other gate still applies). " +
  "Confirm to him in one line and retry; the gate posts the PR comment telling Taha.");
