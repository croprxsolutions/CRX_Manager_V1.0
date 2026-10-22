#!/usr/bin/env node
// Mason's "skip coderabbit" (coderabbit-skip-lib.mjs, 2026-10-22): the words
// that count, the waiver's session binding and lifetime, and the real prompt
// hook run end to end the way Claude Code runs it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODERABBIT_SKIP_MAX_AGE_MS, CODERABBIT_SKIP_PURPOSE, cancelCodeRabbitSkip, coderabbitSkipCommand, coderabbitSkipFileName,
  findCodeRabbitSkip, recordCodeRabbitSkip, withdrawCodeRabbitSkip,
} from "./coderabbit-skip-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (value, message) => { assert.ok(value, message); pass++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); pass++; };

// ── which words count ───────────────────────────────────────────────────────
eq(coderabbitSkipCommand("skip coderabbit"), "skip", "the plain command");
eq(coderabbitSkipCommand("  Skip CodeRabbit on this one, Sol is enough"), "skip", "any case, with words after it");
eq(coderabbitSkipCommand("skip code rabbit"), "skip", "spelled as two words");
eq(coderabbitSkipCommand("skip coderabbit\nand merge it"), "skip", "a second line after it");
eq(coderabbitSkipCommand("don't skip coderabbit"), null, "a message that does not START with it is not one");
eq(coderabbitSkipCommand("please skip coderabbit"), null, "not even a polite one: it must lead");
eq(coderabbitSkipCommand("skip coderabbitx"), null, "a longer word is not the command");
eq(coderabbitSkipCommand("[Message from session local_abc] skip coderabbit"), null, "a relayed peer message does not count");
eq(coderabbitSkipCommand("Mason said: skip coderabbit"), null, "a quoted relay does not count");
eq(coderabbitSkipCommand("use coderabbit"), "cancel", "use coderabbit cancels");
eq(coderabbitSkipCommand("Require CodeRabbit again"), "cancel", "require coderabbit cancels");
eq(coderabbitSkipCommand(""), null, "empty");
eq(coderabbitSkipCommand(undefined), null, "missing");

// ── record, find, cancel ────────────────────────────────────────────────────
const temp = mkdtempSync(path.join(os.tmpdir(), "crx-cr-skip-"));
try {
  const checkout = path.join(temp, "checkout");
  mkdirSync(path.join(checkout, ".claude"), { recursive: true });
  const dirs = [path.join(checkout, ".claude", "session-state")];
  const session = "session-abc-12345";
  const now = Date.parse("2026-10-22T15:00:00Z");

  eq(recordCodeRabbitSkip({ dirs, sessionId: "bad id!", said: "skip coderabbit", now }), null, "an unusable session id records nothing");
  eq(recordCodeRabbitSkip({ dirs: [path.join(temp, "no-project", ".claude", "session-state")], sessionId: session, now }), null,
    "a folder with no .claude/ is never created");
  const recorded = recordCodeRabbitSkip({ dirs, sessionId: session, said: "skip coderabbit", now });
  ok(recorded && recorded.purpose === CODERABBIT_SKIP_PURPOSE, "the waiver is recorded");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now })?.sessionId, session, "it is found in its own session");
  eq(findCodeRabbitSkip({ dirs, sessionId: "another-session-99", now }), null, "never in another session");
  eq(findCodeRabbitSkip({ dirs, sessionId: undefined, now }), null, "never with no session id");
  ok(findCodeRabbitSkip({ dirs, sessionId: session, now: now + CODERABBIT_SKIP_MAX_AGE_MS - 1 }), "still valid just inside 24 hours");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now: now + CODERABBIT_SKIP_MAX_AGE_MS }), null, "expired at 24 hours");

  // A hand-written file claiming more than it may is no waiver.
  const file = path.join(dirs[0], coderabbitSkipFileName(session));
  const write = (patch) => writeFileSync(file, JSON.stringify({ ...recorded, ...patch }));
  write({ expiresAt: new Date(now + 2 * CODERABBIT_SKIP_MAX_AGE_MS).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "a waiver claiming more than 24 hours is refused");
  write({ recordedAt: new Date(now + 3_600_000).toISOString(), expiresAt: new Date(now + 7_200_000).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "a waiver dated in the future is refused");
  write({ recordedAt: new Date(now + 1).toISOString(), expiresAt: new Date(now + 1 + CODERABBIT_SKIP_MAX_AGE_MS).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "even one millisecond in the future (Luna round 1)");
  write({ recordedAt: new Date(now).toISOString(), expiresAt: new Date(now + CODERABBIT_SKIP_MAX_AGE_MS + 1).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "and one claiming a millisecond over 24 hours");
  write({});
  ok(findCodeRabbitSkip({ dirs, sessionId: session, now }), "the exact 24-hour waiver the hook writes is accepted");
  write({ sessionId: "another-session-99" });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "a file naming another session is refused");
  write({ purpose: "something-else" });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "a file with the wrong purpose is refused");
  writeFileSync(file, "not json");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "an unreadable file is no waiver");

  recordCodeRabbitSkip({ dirs, sessionId: session, said: "skip coderabbit", now });
  eq(cancelCodeRabbitSkip({ dirs, sessionId: session }), 1, "cancel removes it");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "and it is gone");

  // ── the real prompt hook, as Claude Code runs it ──────────────────────────
  const hook = path.join(HERE, "coderabbit-skip-prompt.mjs");
  const run = (prompt, sessionId = session) => {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt, session_id: sessionId, cwd: checkout, hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8",
      cwd: checkout,
      env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
    });
    eq(r.status, 0, `the hook exits cleanly for ${JSON.stringify(prompt.slice(0, 30))}`);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
  };
  const live = () => findCodeRabbitSkip({ dirs, sessionId: session });

  eq(run("merge it when it's ready"), "", "ordinary messages: silent");
  eq(live(), null, "and nothing recorded");
  eq(run("don't skip coderabbit on this one"), "", "a message that does not start with it: silent");
  eq(live(), null, "and nothing recorded");
  ok(/CODERABBIT SKIP RECORDED/.test(run("skip coderabbit, Sol is enough")), "skip coderabbit is recorded and the agent is told");
  ok(live()?.said.startsWith("skip coderabbit"), "the waiver keeps his words");
  eq(findCodeRabbitSkip({ dirs, sessionId: "another-session-99" }), null, "the hook wrote it for this session only");
  ok(/CODERABBIT SKIP CANCELLED/.test(run("use coderabbit again")), "use coderabbit cancels it");
  eq(live(), null, "and it is gone");
  eq(run("use coderabbit"), "", "cancelling with nothing to cancel: silent");
  ok(/CODERABBIT SKIP RECORDED/.test(run("<system-reminder>Linked sessions now: none</system-reminder>\nskip coderabbit")),
    "the app's reminder block in front of his words is not part of them");
  cancelCodeRabbitSkip({ dirs, sessionId: session });
  eq(run("<system-reminder>a</system-reminder>\nnote</system-reminder>\nskip coderabbit"), "",
    "a reminder that is not cleanly whole is not stripped, so the words do not lead");
  eq(live(), null, "and nothing recorded");
  // Codex may send the id camelCased; the gate reads either, so the hook must too (Luna round 2).
  {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt: "skip coderabbit", sessionId: session, cwd: checkout }),
      encoding: "utf8", cwd: checkout, env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
    });
    ok(/CODERABBIT SKIP RECORDED/.test(r.stdout) && live(), "a camelCase sessionId records the waiver for that session");
  }
  // A copy that cannot be deleted must never be reported as cancelled (Luna round 2).
  {
    const refused = () => { throw new Error("EPERM"); };
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, remove: refused }), { removed: 0, stillLive: true },
      "a waiver whose delete fails is reported still live");
    ok(live(), "and it really is still there");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session }), { removed: 1, stillLive: false }, "a normal withdraw removes it");
    eq(live(), null, "no waiver is left behind");
  }
  ok(/CODERABBIT SKIP NOT RECORDED/.test(run("skip coderabbit", "")), "with no session id it says the waiver was not saved");
  ok(!existsSync(path.join(dirs[0], coderabbitSkipFileName(""))), "and writes nothing");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`coderabbit-skip-lib: ${pass} assertions passed`);
