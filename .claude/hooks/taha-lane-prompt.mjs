#!/usr/bin/env node
// UserPromptSubmit half of the Taha lane block (taha-lane-lib.mjs, Mason 2026-11-22).
// Mason's whole message `taha override <code>` turns the code a merge refusal
// issued into a 24-hour override for that one PR. Anything else: silent, except a
// message that mentions the command with other text, which is refused out loud.

import { readFileSync } from "node:fs";
import { replyWithoutReminders } from "./owner-approval-lib.mjs";
import { skipStateDirs } from "./coderabbit-skip-lib.mjs";
import { recordTahaLaneOverride, tahaOverrideAttempt, tahaOverrideCode } from "./taha-lane-lib.mjs";

function emit(extra) {
  if (extra) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

const reply = replyWithoutReminders(payload?.prompt);
const code = tahaOverrideCode(reply);
if (!code) {
  emit(tahaOverrideAttempt(reply)
    ? "TAHA LANE OVERRIDE NOT RECORDED — Mason's message mentioned \"taha override\" but was not only `taha override <6-digit code>`. Nothing was overridden. Ask him to send it again as a message of its own."
    : "");
}

// Output only outside this try: under prompt-router.mjs process.exit throws.
let res;
try {
  res = recordTahaLaneOverride({ dirs: skipStateDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]), code });
} catch (error) {
  res = { ok: false, reason: `the override hook failed (${error?.message || error})` };
}
if (!res.ok) emit(`TAHA LANE OVERRIDE NOT RECORDED — Mason sent code ${code}, but ${res.reason}. Nothing was overridden. Tell him in one line; retrying the merge issues a fresh code.`);
emit(`TAHA LANE OVERRIDE RECORDED — Mason let PR #${res.payload.pullRequest} past the Taha lane block until ${res.payload.expiresAt} (this PR only; every other merge gate still applies). ` +
  "Confirm to him in one line, retry the merge, and once it lands comment on the PR so Taha knows it was Mason's call.");
