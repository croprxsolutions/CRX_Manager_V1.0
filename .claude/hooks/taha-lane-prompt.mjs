#!/usr/bin/env node
// UserPromptSubmit half of the Taha lane block (taha-lane-lib.mjs, Mason 2026-11-22).
// Mason's whole message `taha override #<PR> <code>` turns the code a merge refusal
// issued for that PR into a 24-hour override for that PR at the commit it was refused at.
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
    ? "TAHA LANE OVERRIDE NOT RECORDED — Mason's message mentioned \"taha override\" but was not exactly `taha override #<PR> <6-digit code>`. Nothing was overridden. Ask him to send it again as a message of its own."
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
emit(`TAHA LANE OVERRIDE RECORDED — Mason let PR #${res.payload.pullRequest} at ${res.payload.headSha.slice(0, 9)} past the Taha lane block until ${res.payload.expiresAt} ` +
  "(this PR at this commit only; a new push needs a new code; every other merge gate still applies). " +
  "Confirm to him in one line and retry the merge; the gate posts the PR comment telling Taha.");
