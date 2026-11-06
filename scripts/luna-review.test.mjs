#!/usr/bin/env node
// Tests for the advisory Luna review (scripts/luna-review.mjs): model routing and void detection.
// Run: node scripts/luna-review.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  EXIT_CLEAN,
  EXIT_DID_NOT_RUN,
  EXIT_FINDINGS,
  LUNA_EFFORT,
  LUNA_MODEL,
  buildLunaExecArgs,
  classifyLunaRun,
  exitCodeFor,
  main,
  nextStepHint,
  scopeHint,
  parseArgs,
  runLunaReview,
} from "./luna-review.mjs";
import { fixedGitExecutable } from "./write-codex-push-proof.mjs";
import { tempDir } from "./lib/test-temp-dir.mjs";

const canary = "CRXDIFF-TEST";
const banner = (model) => `OpenAI Codex v0.166\n--------\nmodel: ${model}\nreasoning effort: xhigh\n--------\nuser\n`;
const good = {
  status: 0,
  stdout: "",
  stderr: `${banner(LUNA_MODEL)}codex\nok\ntokens used\n20,549\n`,
  canary,
  finalText: `No defects.\n${canary}-END\nLUNA_REVIEW: CLEAN\n`,
};
// The exact tail of the 2026-10-29 void on PR #1248's 960-line diff.
const realVoidTail = "ERROR: Incomplete response returned, reason: max_output_tokens\n".repeat(2) + "tokens used\n157,594\n";

// Model routing: Luna 6 at xhigh, pinned on the command line, read-only and connector-free.
assert.equal(LUNA_MODEL, "gpt-6-luna");
assert.equal(LUNA_EFFORT, "xhigh");
const args = buildLunaExecArgs({ workDir: "W", finalPath: "F" });
assert.equal(args[args.indexOf("-m") + 1], LUNA_MODEL);
assert.ok(args.includes(`model_reasoning_effort="${LUNA_EFFORT}"`));
for (const flag of ["--ignore-user-config", "--ephemeral"]) assert.ok(args.includes(flag));
assert.equal(args[args.indexOf("--sandbox") + 1], "read-only");

// A valid run reaches a verdict, and each verdict has its own exit code.
assert.equal(classifyLunaRun(good).outcome, "clean");
assert.equal(exitCodeFor(classifyLunaRun(good)), EXIT_CLEAN);
const findings = classifyLunaRun({ ...good, finalText: `HIGH a.ts:1 bad\n${canary}-END\nLUNA_REVIEW: FINDINGS 2\n` });
assert.deepEqual([findings.outcome, findings.count], ["findings", 2]);
assert.equal(exitCodeFor(findings), EXIT_FINDINGS);
assert.deepEqual(new Set([EXIT_CLEAN, EXIT_FINDINGS, EXIT_DID_NOT_RUN]).size, 3);

// The real void is reported as a void, even when a perfect CLEAN final message sits beside it.
for (const status of [1, 0]) {
  const run = classifyLunaRun({ ...good, status, stderr: banner(LUNA_MODEL) + realVoidTail });
  assert.deepEqual([run.outcome, run.kind], ["void", "output-limit"], `status ${status}`);
  assert.equal(exitCodeFor(run), EXIT_DID_NOT_RUN);
}
// A void's stray partial text is never read as a verdict.
assert.equal(classifyLunaRun({ ...good, status: 1, stderr: banner(LUNA_MODEL), finalText: `LUNA_REVIEW: CLEAN` }).outcome, "void");

// A diff that merely mentions the error, echoed in the transcript, is not a void.
const echoed = `${banner(LUNA_MODEL)}+ERROR: Incomplete response returned, reason: max_output_tokens\n tokens used\ntokens used\n1\n`;
assert.equal(classifyLunaRun({ ...good, stderr: echoed }).outcome, "clean");

// Never a silent fallback: a refused or substituted model is a loud did-not-run.
const refused = `${banner(LUNA_MODEL)}ERROR: The '${LUNA_MODEL}' model is not supported when using Codex with a ChatGPT account.\n`;
const refusal = classifyLunaRun({ ...good, status: 1, stderr: refused });
assert.equal(refusal.kind, "model-refused");
assert.match(refusal.reason, /no other model was tried/);
const swapped = classifyLunaRun({ ...good, stderr: `${banner("gpt-6-sol")}tokens used\n1\n` });
assert.deepEqual([swapped.outcome, swapped.kind], ["void", "wrong-model"]);
assert.equal(classifyLunaRun({ ...good, stderr: "tokens used\n1\n" }).kind, "wrong-model");

// One failing run means one call: the refusal is not retried on anything else.
const calls = [];
const stubbed = runLunaReview({
  diff: "diff --git a/a b/a\n",
  resolveCodex: () => "codex-stub",
  spawn: (bin, spawnArgs, options) => {
    calls.push({ model: spawnArgs[spawnArgs.indexOf("-m") + 1], options });
    return { status: 1, stdout: "", stderr: refused };
  },
});
assert.equal(stubbed.kind, "model-refused");
assert.deepEqual(calls.map((call) => call.model), [LUNA_MODEL]);
assert.match(calls[0].options.input, /Never read, print or use credentials/);
assert.match(calls[0].options.input, /diff --git a\/a b\/a/);
assert.equal(calls[0].options.env.SUPABASE_ACCESS_TOKEN, undefined);

// The stub writes the final message where -o says, as Codex does.
const clean = runLunaReview({
  diff: "diff --git a/a b/a\n",
  resolveCodex: () => "codex-stub",
  spawn: (bin, spawnArgs, options) => {
    const tailCanary = /tail canary: (CRXDIFF-[^)\s]+)\) =====\s*$/.exec(options.input)[1];
    writeFileSync(spawnArgs[spawnArgs.indexOf("-o") + 1], `${tailCanary}\nLUNA_REVIEW: CLEAN\n`);
    return { status: 0, stdout: "", stderr: `${banner(LUNA_MODEL)}tokens used\n1\n` };
  },
});
assert.equal(clean.outcome, "clean");

// End to end in a throwaway repo (CI's own HEAD is a merge commit with no diff): the real void
// exits "did not run" and says so.
const repo = tempDir("crx-luna-test-");
const gitIn = (...gitArgs) => execFileSync(fixedGitExecutable(), ["-c", "user.name=t", "-c", "user.email=t@example.com", ...gitArgs], { cwd: repo });
gitIn("init", "-q");
writeFileSync(path.join(repo, "a.txt"), "one\n");
gitIn("add", "a.txt");
gitIn("commit", "-q", "-m", "one");
const printed = [];
const realLog = console.log;
const realCwd = process.cwd();
console.log = (line = "") => printed.push(line);
process.chdir(repo);
const voidExit = main(["--commit", "HEAD"], {
  resolveCodex: () => "codex-stub",
  spawn: () => ({ status: 1, stdout: "", stderr: banner(LUNA_MODEL) + realVoidTail }),
});
process.chdir(realCwd);
console.log = realLog;
rmSync(repo, { recursive: true, force: true });
assert.equal(voidExit, EXIT_DID_NOT_RUN);
assert.match(printed.join("\n"), /DID NOT RUN.*NOT A REVIEW AND NOT A CLEAN RESULT/);
assert.match(printed.join("\n"), /max_output_tokens/);

// Guard-change round cap: the third Luna round on a branch whose diff touches a hook is a STOP,
// exits as findings and never reaches Codex. Other branches run as often as asked.
function lunaRoundsOn(file, counter, runs = ["luna", "luna", "luna"]) {
  const dir = tempDir("crx-luna-cap-");
  const git = (...gitArgs) => execFileSync(fixedGitExecutable(), ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...gitArgs], { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  writeFileSync(path.join(dir, "base.txt"), "base\n");
  git("add", "base.txt");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "-b", "feature");
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), "change\n");
  git("add", file);
  git("commit", "-q", "-m", "change");
  if (counter !== undefined) writeFileSync(path.join(dir, ".git", "crx-luna-guard-rounds.json"), counter);
  const out = [];
  let spawned = 0;
  const savedLog = console.log;
  const savedErr = console.error;
  console.log = (line = "") => out.push(line);
  console.error = () => {};
  process.chdir(dir);
  const exits = [];
  try {
    for (const run of runs) {
      exits.push(main(run === "sol" ? ["--base", base, "--sol", "--reason", "test"] : ["--base", base], {
        resolveCodex: () => "codex-stub",
        spawn: (bin, spawnArgs, options) => {
          spawned += 1;
          const tailCanary = /tail canary: (CRXDIFF-[^)\s]+)\) =====\s*$/.exec(options.input)[1];
          writeFileSync(spawnArgs[spawnArgs.indexOf("-o") + 1], `MED x\n${tailCanary}\nLUNA_REVIEW: FINDINGS 1\n`);
          return { status: 0, stdout: "", stderr: `${banner(spawnArgs[spawnArgs.indexOf("-m") + 1])}tokens used\n1\n` };
        },
      }));
    }
  } finally {
    process.chdir(realCwd);
    console.log = savedLog;
    console.error = savedErr;
    rmSync(dir, { recursive: true, force: true });
  }
  return { exits, spawned, printed: out.join("\n") };
}
for (const hook of [".claude/hooks/x.mjs", ".codex/hooks/y.mjs"]) {
  const capped = lunaRoundsOn(hook);
  assert.equal(capped.spawned, 2, hook);
  assert.deepEqual(capped.exits, [EXIT_FINDINGS, EXIT_FINDINGS, EXIT_FINDINGS], hook);
  assert.match(capped.printed, /STOP: third review round on a guard change/);
}
const uncapped = lunaRoundsOn("src/a.ts");
assert.equal(uncapped.spawned, 3);
assert.doesNotMatch(uncapped.printed, /STOP:/);
// The cap is for Luna only: an advisory Sol escalation is never stopped and uses up no Luna round.
for (const runs of [["luna", "luna", "sol"], ["sol", "luna", "luna"]]) {
  const mixed = lunaRoundsOn(".claude/hooks/x.mjs", undefined, runs);
  assert.equal(mixed.spawned, 3, runs.join(","));
  assert.doesNotMatch(mixed.printed, /STOP:/, runs.join(","));
}
// A damaged counter fails closed instead of starting the count over.
for (const counter of ["{\"feature\": 2", "null", "{\"feature\": \"bad\"}"]) {
  const damaged = lunaRoundsOn(".claude/hooks/x.mjs", counter);
  assert.equal(damaged.spawned, 0, counter);
  assert.deepEqual(damaged.exits, [EXIT_DID_NOT_RUN, EXIT_DID_NOT_RUN, EXIT_DID_NOT_RUN], counter);
}

// A merge stopped on a conflict is refused before Codex is called, in every scope.
{
  const dir = tempDir("crx-luna-conflict-");
  const git = (...gitArgs) => execFileSync(fixedGitExecutable(), ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=false", ...gitArgs], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "f.txt"), "base\n");
  git("add", "f.txt");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD").trim();
  git("checkout", "-q", "-b", "feature");
  writeFileSync(path.join(dir, "f.txt"), "feature\n");
  git("commit", "-q", "-am", "feature");
  git("checkout", "-q", "main");
  writeFileSync(path.join(dir, "f.txt"), "main\n");
  git("commit", "-q", "-am", "main");
  git("checkout", "-q", "feature");
  assert.throws(() => git("merge", "main"));
  const out = [];
  let spawned = 0;
  const savedLog = console.log;
  console.log = (line = "") => out.push(line);
  process.chdir(dir);
  try {
    for (const args of [["--base", base], ["--uncommitted"], ["--commit", "HEAD"]]) {
      const exit = main(args, { resolveCodex: () => "codex-stub", spawn: () => { spawned += 1; return { status: 1 }; } });
      assert.equal(exit, EXIT_DID_NOT_RUN, args.join(" "));
    }
  } finally {
    process.chdir(realCwd);
    console.log = savedLog;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(spawned, 0);
  assert.match(out.join("\n"), /Unfinished merge: 1 file\(s\) still have conflicts:\n {2}f\.txt/);
}

// Other broken runs stay broken.
for (const [finalText, kind] of [
  ["", "no-final"],
  ["LUNA_REVIEW: NO_DIFF\n", "no-diff"],
  ["LUNA_REVIEW: CLEAN\n", "canary"],
  [`I saw ${canary}-END early.\nLUNA_REVIEW: CLEAN\n`, "canary"],
  [`${canary}-END\nLUNA_REVIEW: CLEAN\nLUNA_REVIEW: FINDINGS 1\n`, "verdict"],
  [`${canary}-END\nLUNA_REVIEW: CLEAN\nthanks\n`, "verdict"],
  [`${canary}-END\nLUNA_REVIEW: FINDINGS 0\n`, "verdict"],
]) {
  assert.equal(classifyLunaRun({ ...good, finalText }).kind, kind, JSON.stringify(finalText));
}
assert.equal(classifyLunaRun({ ...good, stderr: banner(LUNA_MODEL) }).kind, "no-tokens");
assert.equal(classifyLunaRun({ ...good, error: { code: "ETIMEDOUT" } }).kind, "timeout");

// Arguments: one scope, an explained Sol escalation, nothing that git could read as an option.
assert.deepEqual(parseArgs(["--commit", "abc"]).commit, "abc");
for (const bad of [
  ["--base", "x", "--commit", "y"],
  ["--sol"],
  ["--sol", "--reason", "--commit"],
  ["--base", "--output=/tmp/x"],
  ["--reason", "why"],
  ["--nope"],
]) {
  assert.throws(() => parseArgs(bad), Error, bad.join(" "));
}

// Only MED/LOW findings point at Sol; any BLOCKER or HIGH keeps the Luna loop going.
assert.match(nextStepHint("- **MED — a.ts:1** — footer\n- LOW — b.ts:2 — nit\nLUNA_REVIEW: FINDINGS 2\n"), /whole-branch round once more/);
assert.equal(nextStepHint("- **HIGH — a.ts:1** — wrong total\nLUNA_REVIEW: FINDINGS 1\n"), null);
assert.match(scopeHint("commit abc123"), /whole-branch round/);
assert.match(scopeHint("uncommitted changes"), /whole-branch round/);
assert.equal(scopeHint("branch against origin/main (abc) at head def"), null);
assert.match(scopeHint("branch against origin/release (abc) at head def"), /whole-branch round/);
assert.equal(nextStepHint("- **High — a.ts:1** — wrong total\nLUNA_REVIEW: FINDINGS 1\n"), null);
assert.equal(nextStepHint("- BLOCKER: a.sql:3 — grants anon\n- MED: b.ts:2\nLUNA_REVIEW: FINDINGS 2\n"), null);

console.log("luna-review tests passed");
