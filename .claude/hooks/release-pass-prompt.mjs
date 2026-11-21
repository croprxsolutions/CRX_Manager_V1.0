#!/usr/bin/env node
// UserPromptSubmit half of Mason's release pass (release-pass-lib.mjs; Mason, 2026-11-20).
//   `ship the release` / `go live #2105` → this session may take that live for 24 hours.
//   `stop the release`                  → this session's pass is withdrawn.
// Anything else → silent. A <system-reminder> block the app puts in front of his words is not his.

import { readFileSync } from "node:fs";
import { replyWithoutReminders } from "./owner-approval-lib.mjs";
import { skipStateDirs } from "./coderabbit-skip-lib.mjs";
import { recordReleasePass, releasePassCommand, withdrawReleasePass } from "./release-pass-lib.mjs";

function emit(extra) {
  if (extra) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: extra } }));
  process.exit(0);
}

let payload;
try { payload = globalThis.__CRX_ROUTED_HOOK_PAYLOAD ?? JSON.parse(readFileSync(0, "utf8")); } catch { emit(); }

const command = releasePassCommand(replyWithoutReminders(payload?.prompt));
if (!command) emit();
if (command.kind === "unnamed") {
  emit("RELEASE PASS NOT RECORDED — Mason said \"go live\" but named no PR. Ask him in one line which one (go live #<number>), or whether he meant: ship the release.");
}

const sessionId = payload?.session_id ?? payload?.sessionId;
// Output only outside this try: under prompt-router.mjs process.exit throws.
let saved = null;
let stillLive = false;
let failure = "";
try {
  const dirs = skipStateDirs([payload?.cwd, process.env.CLAUDE_PROJECT_DIR, process.cwd()]);
  if (command.kind === "cancel") ({ stillLive } = withdrawReleasePass({ dirs, sessionId }));
  else saved = recordReleasePass({ dirs, sessionId, release: command.release, pullRequests: command.pullRequests, said: command.said });
} catch (error) {
  failure = String(error?.message || error);
  stillLive = command.kind === "cancel";
}

if (command.kind === "cancel") {
  emit(stillLive
    ? `RELEASE PASS NOT CONFIRMED WITHDRAWN${failure ? ` (${failure})` : ""}. Treat it as withdrawn anyway: take nothing live from this session, and tell Mason in one line.`
    : "RELEASE PASS WITHDRAWN — Mason said stop. Take nothing further live from this session; finish only the checks for anything already applied, and report what state live is in.");
}
if (!saved) {
  emit(`RELEASE PASS NOT RECORDED${failure ? ` (${failure})` : " (no usable session id, or no folder of this session has .claude/)"}. Tell Mason in one line; nothing goes live from this session without it.`);
}

const what = [saved.release ? "the open weekly release (release/next)" : "", ...saved.pullRequests.map((n) => `#${n}`)].filter(Boolean).join(", ");
emit([
  `RELEASE PASS RECORDED — Mason authorized THIS session to take ${what} live, until ${saved.expiresAt}, without waiting for him or Taha.`,
  "Do it the ship.md › Going live way: fix what blocks it, wait for every check, the Sol proof and the apply proofs, post `Ready to merge: <head sha>` on the release PR before the first live apply (it freezes staging merges), apply migrations in stamp order, merge with --match-head-commit, merge the back-merge, then check the live site.",
  "Still NOT covered: any migration that deletes data (show Mason exactly what it deletes and get his `yes`), a genuine business decision (stop and ask), Taha's 4-hour hold and any `hold` from him, Edge Function deploys, secrets and login settings. If a live apply fails partway, stop everything and report; don't move on.",
  "Confirm to Mason in one line: what is covered, until when, and that `stop the release` cancels it.",
].join("\n"));
