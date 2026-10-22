#!/usr/bin/env node
// Mason's "skip coderabbit #<PR>" (coderabbit-skip-lib.mjs, 2026-10-22, per PR):
// the words that count, the waiver's binding to one PR and one session, its
// lifetime, cancelling, and the real prompt hook run end to end the way Claude
// Code runs it.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODERABBIT_SKIP_MAX_AGE_MS, CODERABBIT_SKIP_PURPOSE, cancelCodeRabbitSkip, coderabbitSkipCommand, coderabbitSkipFileName,
  findCodeRabbitSkip, mayExist, recordCodeRabbitSkip, withdrawCodeRabbitSkip,
} from "./coderabbit-skip-lib.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const ok = (value, message) => { assert.ok(value, message); pass++; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); pass++; };
const skip = (...pullRequests) => ({ kind: "skip", pullRequests });
const UNNAMED = { kind: "skip-unnamed" };

// ── which words count, and which PRs they name ──────────────────────────────
eq(coderabbitSkipCommand("skip coderabbit #1018"), skip(1018), "the plain command names one PR");
eq(coderabbitSkipCommand("  Skip CodeRabbit #1018, Sol is enough"), skip(1018), "any case, with words after it");
eq(coderabbitSkipCommand("skip code rabbit 1018"), skip(1018), "two words and a bare number");
eq(coderabbitSkipCommand("skip coderabbit on PR 1018"), skip(1018), "\"on PR\"");
eq(coderabbitSkipCommand("skip coderabbit for pull request #1018"), skip(1018), "\"for pull request\"");
eq(coderabbitSkipCommand("skip coderabbit: #1018"), skip(1018), "a colon after the words");
eq(coderabbitSkipCommand("skip coderabbit #1018 #1020"), skip(1018, 1020), "a short list names each PR");
eq(coderabbitSkipCommand("skip coderabbit #1018, #1020 and #1026"), skip(1018, 1020, 1026), "commas and \"and\"");
eq(coderabbitSkipCommand("skip coderabbit #1018 #1018"), skip(1018), "a repeated number counts once");
// Luna round 4: a run-together or over-long number is never split into two PRs.
eq(coderabbitSkipCommand("skip coderabbit 99999991018"), UNNAMED, "an 11-digit number is not two PRs");
eq(coderabbitSkipCommand("skip coderabbit #12345678"), UNNAMED, "an 8-digit number is not a PR");
eq(coderabbitSkipCommand("skip coderabbit #1018#1020"), UNNAMED, "two numbers with no separator are refused, not guessed");
eq(coderabbitSkipCommand("skip coderabbit #1018 99999991020"), UNNAMED, "a list ending in a malformed number is refused whole");
eq(coderabbitSkipCommand("skip coderabbit #1018 #1020#1030"), UNNAMED, "so is one with a glued pair at the end");
eq(coderabbitSkipCommand("skip coderabbit #1018 pr"), skip(1018), "a trailing word with no number is just a word");
eq(coderabbitSkipCommand("skip coderabbit #1018,#1020"), skip(1018, 1020), "a comma with no space still separates");
eq(coderabbitSkipCommand("skip coderabbit #1018\nand merge it"), skip(1018), "a second line after it");
eq(coderabbitSkipCommand("skip coderabbit"), UNNAMED, "no PR named: nothing to waive");
eq(coderabbitSkipCommand("skip coderabbit on this one"), UNNAMED, "\"this one\" is not a PR number");
eq(coderabbitSkipCommand("skip coderabbit, it's fine for #1018"), UNNAMED, "the number must come straight after the words");
eq(coderabbitSkipCommand("skip coderabbit #0"), UNNAMED, "#0 is not a PR");
eq(coderabbitSkipCommand("skip coderabbit #1 #2 #3 #4 #5 #6"), UNNAMED, "more than five numbers is not a deliberate list");
eq(coderabbitSkipCommand("don't skip coderabbit #1018"), null, "a message that does not START with it is not one");
eq(coderabbitSkipCommand("please skip coderabbit #1018"), null, "not even a polite one: it must lead");
eq(coderabbitSkipCommand("skip coderabbitx #1018"), null, "a longer word is not the command");
eq(coderabbitSkipCommand("[Message from session local_abc] skip coderabbit #1018"), null, "a relayed peer message does not count");
eq(coderabbitSkipCommand("Mason said: skip coderabbit #1018"), null, "a quoted relay does not count");
eq(coderabbitSkipCommand("use coderabbit"), { kind: "cancel" }, "use coderabbit cancels");
eq(coderabbitSkipCommand("Require CodeRabbit again"), { kind: "cancel" }, "require coderabbit cancels");
eq(coderabbitSkipCommand(""), null, "empty");
eq(coderabbitSkipCommand(undefined), null, "missing");

// ── record, find, cancel ────────────────────────────────────────────────────
const temp = mkdtempSync(path.join(os.tmpdir(), "crx-cr-skip-"));
try {
  const checkout = path.join(temp, "checkout");
  mkdirSync(path.join(checkout, ".claude"), { recursive: true });
  const dirs = [path.join(checkout, ".claude", "session-state")];
  const session = "session-abc-12345";
  const PR = 1018;
  const now = Date.parse("2026-10-22T15:00:00Z");

  eq(recordCodeRabbitSkip({ dirs, sessionId: "bad id!", pullRequest: PR, said: "skip coderabbit #1018", now }), null,
    "an unusable session id records nothing");
  eq(recordCodeRabbitSkip({ dirs, sessionId: session, said: "skip coderabbit", now }), null, "no PR records nothing");
  eq(recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: 0, now }), null, "PR 0 records nothing");
  eq(recordCodeRabbitSkip({ dirs: [path.join(temp, "no-project", ".claude", "session-state")], sessionId: session, pullRequest: PR, now }), null,
    "a folder with no .claude/ is never created");
  const recorded = recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, said: "skip coderabbit #1018", now });
  ok(recorded && recorded.purpose === CODERABBIT_SKIP_PURPOSE && recorded.pullRequest === PR, "the waiver is recorded for that PR");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now })?.pullRequest, PR, "it is found for its own PR in its own session");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: 1020, now }), null, "NEVER for another PR in the same session");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, now }), null, "never when the gate cannot name the PR");
  eq(findCodeRabbitSkip({ dirs, sessionId: "another-session-99", pullRequest: PR, now }), null, "never in another session");
  eq(findCodeRabbitSkip({ dirs, sessionId: undefined, pullRequest: PR, now }), null, "never with no session id");
  ok(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now: now + CODERABBIT_SKIP_MAX_AGE_MS - 1 }), "still valid just inside 24 hours");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now: now + CODERABBIT_SKIP_MAX_AGE_MS }), null, "expired at 24 hours");

  // A hand-written file claiming more than it may is no waiver.
  const file = path.join(dirs[0], coderabbitSkipFileName(session, PR));
  const write = (patch) => writeFileSync(file, JSON.stringify({ ...recorded, ...patch }));
  write({ expiresAt: new Date(now + 2 * CODERABBIT_SKIP_MAX_AGE_MS).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a waiver claiming more than 24 hours is refused");
  write({ recordedAt: new Date(now + 3_600_000).toISOString(), expiresAt: new Date(now + 7_200_000).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a waiver dated in the future is refused");
  write({ recordedAt: new Date(now + 1).toISOString(), expiresAt: new Date(now + 1 + CODERABBIT_SKIP_MAX_AGE_MS).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "even one millisecond in the future (Luna round 1)");
  write({ recordedAt: new Date(now).toISOString(), expiresAt: new Date(now + CODERABBIT_SKIP_MAX_AGE_MS + 1).toISOString() });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "and one claiming a millisecond over 24 hours");
  write({ sessionId: "another-session-99" });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a file naming another session is refused");
  write({ pullRequest: 1020 });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a file whose contents name another PR is refused");
  write({ purpose: "crx-coderabbit-skip-v1" });
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "a session-wide v1 waiver is refused");
  write({});
  ok(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), "the exact 24-hour waiver the hook writes is accepted");
  writeFileSync(file, "not json");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, now }), null, "an unreadable file is no waiver");

  // Cancel removes every PR's waiver for this session, and only this session's.
  recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: PR, said: "skip coderabbit #1018", now });
  recordCodeRabbitSkip({ dirs, sessionId: session, pullRequest: 1020, said: "skip coderabbit #1020", now });
  recordCodeRabbitSkip({ dirs, sessionId: "another-session-99", pullRequest: PR, said: "skip coderabbit #1018", now });
  eq(cancelCodeRabbitSkip({ dirs, sessionId: session }), 2, "cancel removes both of this session's waivers");
  eq(findCodeRabbitSkip({ dirs, sessionId: session, pullRequest: 1020, now }), null, "and they are gone");
  ok(findCodeRabbitSkip({ dirs, sessionId: "another-session-99", pullRequest: PR, now }), "another session's waiver is untouched");
  cancelCodeRabbitSkip({ dirs, sessionId: "another-session-99" });

  // ── the real prompt hook, as Claude Code runs it ──────────────────────────
  const hook = path.join(HERE, "coderabbit-skip-prompt.mjs");
  const run = (prompt, sessionId = session, key = "session_id") => {
    const r = spawnSync(process.execPath, [hook], {
      input: JSON.stringify({ prompt, [key]: sessionId, cwd: checkout, hook_event_name: "UserPromptSubmit" }),
      encoding: "utf8",
      cwd: checkout,
      env: { ...process.env, CLAUDE_PROJECT_DIR: checkout },
    });
    eq(r.status, 0, `the hook exits cleanly for ${JSON.stringify(prompt.slice(0, 30))}`);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
  };
  const live = (pullRequest = PR) => findCodeRabbitSkip({ dirs, sessionId: session, pullRequest });
  const files = () => readdirSync(dirs[0]).filter((n) => n.startsWith("coderabbit-skip-"));

  eq(run("merge it when it's ready"), "", "ordinary messages: silent");
  eq(files(), [], "and nothing recorded");
  eq(run("don't skip coderabbit on #1018"), "", "a message that does not start with it: silent");
  eq(files(), [], "and nothing recorded");
  ok(/CODERABBIT SKIP NOT RECORDED[\s\S]*did not name a pull request[\s\S]*skip coderabbit #<number>/.test(run("skip coderabbit")),
    "skip coderabbit with no PR is refused out loud, and the agent is told to ask which PR");
  eq(files(), [], "and nothing at all is waived");
  const said = run("skip coderabbit #1018, Sol is enough");
  ok(/CODERABBIT SKIP RECORDED[\s\S]*#1018 ONLY/.test(said), "skip coderabbit #1018 is recorded for that PR only, and the agent is told");
  ok(live()?.said.startsWith("skip coderabbit #1018"), "the waiver keeps his words");
  eq(live(1020), null, "it does not reach any other PR");
  eq(findCodeRabbitSkip({ dirs, sessionId: "another-session-99", pullRequest: PR }), null, "the hook wrote it for this session only");
  ok(/CODERABBIT SKIP RECORDED[\s\S]*#1020, #1026 ONLY/.test(run("skip coderabbit #1020 and #1026")), "a short list records each named PR");
  ok(live(1020) && live(1026), "both named PRs are waived");
  ok(/CODERABBIT SKIP CANCELLED/.test(run("use coderabbit again")), "use coderabbit cancels them all");
  eq(files(), [], "and every waiver is gone");
  eq(run("use coderabbit"), "", "cancelling with nothing to cancel: silent");
  ok(/CODERABBIT SKIP RECORDED/.test(run("<system-reminder>Linked sessions now: none</system-reminder>\nskip coderabbit #1018")),
    "the app's reminder block in front of his words is not part of them");
  cancelCodeRabbitSkip({ dirs, sessionId: session });
  eq(run("<system-reminder>a</system-reminder>\nnote</system-reminder>\nskip coderabbit #1018"), "",
    "a reminder that is not cleanly whole is not stripped, so the words do not lead");
  eq(files(), [], "and nothing recorded");
  // Codex may send the id camelCased; the gate reads either, so the hook must too (Luna round 2).
  ok(/CODERABBIT SKIP RECORDED/.test(run("skip coderabbit #1018", session, "sessionId")) && live(),
    "a camelCase sessionId records the waiver for that session");
  // A copy that cannot be deleted must never be reported as cancelled (Luna round 2).
  {
    const refused = () => { throw new Error("EPERM"); };
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, remove: refused }), { removed: 0, stillLive: true },
      "a waiver whose delete fails is reported still live");
    ok(live(), "and it really is still there");
    // Luna round 3: a copy that can be neither deleted nor read must still count.
    const waiverFile = path.join(dirs[0], coderabbitSkipFileName(session, PR));
    writeFileSync(waiverFile, "unreadable for now");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, remove: refused }), { removed: 0, stillLive: true },
      "an unreadable, undeletable waiver file is reported still live");
    // Codex App P2 on #1035: a file or folder that cannot be checked counts as still holding it.
    const denied = (code) => () => { const e = new Error(code); e.code = code; throw e; };
    eq(mayExist("x", denied("EACCES")), true, "a permission error counts as still there");
    eq(mayExist("x", denied("EPERM")), true, "so does EPERM");
    eq(mayExist("x", denied("EIO")), true, "and any other error");
    eq(mayExist("x", denied("ENOENT")), false, "only a missing file counts as gone");
    eq(mayExist("x", denied("ENOTDIR")), false, "or a missing folder");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, remove: refused, exists: (f) => mayExist(f, denied("EACCES")) }).stillLive,
      true, "a withdraw that cannot check a file reports the waiver still live");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session, list: denied("EACCES") }).stillLive,
      true, "a withdraw that cannot list a folder reports a waiver still live");
    eq(withdrawCodeRabbitSkip({ dirs: [path.join(temp, "missing", ".claude", "session-state")], sessionId: session }).stillLive,
      false, "a folder that does not exist holds no waiver");
    eq(withdrawCodeRabbitSkip({ dirs, sessionId: session }), { removed: 1, stillLive: false }, "a normal withdraw removes it");
    eq(files(), [], "no waiver is left behind");
  }
  ok(/CODERABBIT SKIP NOT RECORDED/.test(run("skip coderabbit #1018", "")), "with no session id it says the waiver was not saved");
  ok(!existsSync(path.join(dirs[0], coderabbitSkipFileName("", PR))), "and writes nothing");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log(`coderabbit-skip-lib: ${pass} assertions passed`);
