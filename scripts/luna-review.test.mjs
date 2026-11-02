#!/usr/bin/env node
// Tests for the advisory Luna review (scripts/luna-review.mjs): model routing and void detection.
// Run: node scripts/luna-review.test.mjs
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";

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
  parseArgs,
  runLunaReview,
} from "./luna-review.mjs";

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

// End to end on this checkout: the real void exits "did not run" and says so.
const printed = [];
const realLog = console.log;
console.log = (line = "") => printed.push(line);
const voidExit = main(["--commit", "HEAD"], {
  resolveCodex: () => "codex-stub",
  spawn: () => ({ status: 1, stdout: "", stderr: banner(LUNA_MODEL) + realVoidTail }),
});
console.log = realLog;
assert.equal(voidExit, EXIT_DID_NOT_RUN);
assert.match(printed.join("\n"), /DID NOT RUN.*NOT A REVIEW AND NOT A CLEAN RESULT/);
assert.match(printed.join("\n"), /max_output_tokens/);

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

console.log("luna-review tests passed");
