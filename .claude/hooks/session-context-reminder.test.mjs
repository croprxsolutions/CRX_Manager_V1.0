#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scratchHookEnvironment } from "./git-test-env.mjs";

const hookPath = fileURLToPath(new URL("./session-context-reminder.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const adapterPath = fileURLToPath(new URL("../../.codex/hooks/codex-hook-adapter.mjs", import.meta.url));

function runRaw(input) {
  const result = spawnSync(process.execPath, [hookPath], {
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "", "session reminder must not emit hidden errors");
  return result.stdout;
}

function run(source) {
  const output = runRaw(JSON.stringify({ source }));
  return JSON.parse(output).hookSpecificOutput.additionalContext;
}

const startup = run("startup");
assert.match(startup, /do not re-read AGENTS\.md or CLAUDE\.md/);
assert.doesNotMatch(startup, /Silently read AGENTS\.md/);
assert.match(startup, /Load only the workflow and reference documents/);
assert.match(startup, /Mason cannot read code or safely review a diff/);
assert.match(startup, /Post a short plan, then continue routine implementation without waiting for approval or repeated pauses/);
assert.doesNotMatch(startup, /get his approval after a short plan/);
assert.match(startup, /Every hard-gated live action listed in AGENTS\.md/);
assert.match(startup, /each destructive migration.*current approval immediately beforehand/);
// Mason's autonomous-landing rule (2026-09-26) — the conditions travel with it.
assert.match(startup, /NON-destructive migration and the merge need no ask once the exact-SHA Sol proof is clean and checks are green/);
assert.match(startup, /CodeRabbit is advisory/);
// The documentation-only exception (Mason, 2026-10-07) travels with it.
assert.match(startup, /A change touching no file on docs\/reference\/sol-required-paths\.md needs no Sol proof/);
assert.doesNotMatch(startup, /armed hands-free migration path waives/);
// Keep the full rulebook task-routed instead of injecting it into every session.
assert.doesNotMatch(startup, /SAFE_DEVELOPMENT_RULES/);
// Leave room for precise gate wording while keeping procedures out of startup context.
assert.ok(startup.length < 1_200, `startup reminder grew to ${startup.length} characters`);
assert.equal(run("resume"), startup);
assert.equal(run("clear"), startup);
assert.equal(run(), startup);

const compact = run("compact");
assert.match(compact, /POST-COMPACT RULE RE-ANCHOR/);
assert.match(compact, /money = exact whole cents/);
assert.match(compact, /parseDollarsToCents\(\) REFUSES more than two decimals/);
assert.match(compact, /never coerce null to 0 on a saved or authoritative path/);
assert.match(compact, /Mason cannot read code or safely review a diff/);

assert.equal(runRaw("{"), "");

// Codex path: the real manifest entry, through the real adapter, from the repo root.
const codexHooks = JSON.parse(readFileSync(new URL("../../.codex/hooks.json", import.meta.url), "utf8")).hooks;
const startGroup = codexHooks.SessionStart.find((group) => JSON.stringify(group).includes("session-context-reminder.mjs"));
assert.ok(startGroup, "Codex SessionStart must wire the reminder");
// A matcher here would filter on source, and compact is the reason this hook is wired.
assert.equal(startGroup.matcher, undefined, "the reminder must fire for every SessionStart source");

function runCodexRaw(input) {
  const result = spawnSync(process.execPath, [adapterPath, ".claude/hooks/session-context-reminder.mjs"], {
    cwd: repoRoot,
    env: scratchHookEnvironment(repoRoot),
    input,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "", "session reminder must not emit hidden errors through the adapter");
  return result.stdout;
}

function runCodex(source) {
  const parsed = JSON.parse(runCodexRaw(JSON.stringify({ source })));
  assert.equal(parsed.hookSpecificOutput.hookEventName, "SessionStart");
  return parsed.hookSpecificOutput.additionalContext;
}

const codexStartup = runCodex("startup");
assert.match(codexStartup, /AGENTS\.md \(the shared contract\) is already in context/);
assert.doesNotMatch(codexStartup, /CLAUDE\.md/, "Codex does not load CLAUDE.md");
assert.match(codexStartup, /Load only the workflow and reference documents/);
assert.match(codexStartup, /Every hard-gated live action listed in AGENTS\.md/);
assert.ok(codexStartup.length < 1_200, `Codex startup reminder grew to ${codexStartup.length} characters`);
assert.equal(runCodex("resume"), codexStartup);
assert.equal(runCodex("fork"), codexStartup);
assert.equal(runCodex("compact"), compact, "both harnesses get the same re-anchor");
assert.equal(runCodexRaw("{"), "", "malformed input stays silent through the adapter");

console.log("session-context-reminder: startup routing and compact re-anchor passed on Claude and Codex");
