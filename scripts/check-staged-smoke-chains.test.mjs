#!/usr/bin/env node
// The pre-commit smoke-chain check refuses a staged live chain the live-SQL guard
// would not read as rollback-only (PR #1989's shape), passes the real
// purchasing-plan chain, and skips container-only chains. Runs the real script
// against the STAGED blob in a throwaway repo.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scratchHookEnvironment } from "../.claude/hooks/git-test-env.mjs";
import { tempDir } from "./lib/test-temp-dir.mjs";
import { liveChainPaths, smokeChainProblem } from "./check-staged-smoke-chains.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repoRoot, "scripts", "check-staged-smoke-chains.mjs");
const realChain = readFileSync(path.join(repoRoot, "scripts", "smoke", "smoke-purchasing-plan.sql"), "utf8");

const chain = (body) => `DO $$
DECLARE v_i int;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '', true);
${body}  RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK fixture';
END $$;
`;
// Two CASE expressions in one statement: `END, 'c', CASE` reads as END CASE.
const looped = chain(`  FOR v_i IN 1..2 LOOP
    PERFORM jsonb_build_object('n', CASE v_i WHEN 1 THEN 1 ELSE 2 END, 'c', CASE v_i WHEN 1 THEN 'a' ELSE 'b' END);
  END LOOP;
`);
const unrolled = chain(`  PERFORM jsonb_build_object('n', 1, 'c', 'a');
  PERFORM jsonb_build_object('n', 2, 'c', 'b');
`);

assert.ok(smokeChainProblem(looped), "looped CASE chain is refused");
assert.equal(smokeChainProblem(unrolled), null, "unrolled chain passes");
assert.equal(smokeChainProblem(realChain), null, "real purchasing-plan chain passes");
assert.deepEqual(
  [...liveChainPaths(JSON.stringify({ specs: { a: { chain: "a.sql" }, b: { chain: "b.sql", container_only: true }, c: { chain: "c.sql", psql_only: true } } }))],
  ["scripts/smoke/a.sql"],
  "container_only and psql_only specs are skipped",
);

const scratch = tempDir("crx-smoke-chain-");
const env = scratchHookEnvironment(scratch);
const git = (...args) => {
  const res = spawnSync("git", args, { cwd: scratch, env, encoding: "utf8" });
  assert.equal(res.status, 0, `git ${args.join(" ")}:\n${res.stderr}`);
};
const check = () => spawnSync(process.execPath, [script], { cwd: scratch, env, encoding: "utf8" });
try {
  mkdirSync(path.join(scratch, "scripts", "smoke"), { recursive: true });
  const smoke = (name) => path.join(scratch, "scripts", "smoke", name);
  writeFileSync(smoke("smoke-specs.json"), JSON.stringify({ specs: {
    live: { chain: "smoke-live.sql" },
    boxed: { chain: "smoke-boxed.sql", container_only: true },
  } }));
  copyFileSync(path.join(repoRoot, "scripts", "smoke", "smoke-purchasing-plan.sql"), smoke("smoke-live.sql"));
  writeFileSync(smoke("smoke-boxed.sql"), looped);
  git("init", "-q");
  git("add", "-A");

  let res = check();
  assert.equal(res.status, 0, `real chain + container-only looped chain pass:\n${res.stderr}`);

  writeFileSync(smoke("smoke-live.sql"), looped);
  git("add", "-A");
  res = check();
  assert.equal(res.status, 1, "a staged looped live chain is refused");
  assert.match(res.stderr, /scripts\/smoke\/smoke-live\.sql/);
  assert.match(res.stderr, /unroll loops\/CASE in the DO body/);

  // The STAGED blob is judged, not the working tree.
  writeFileSync(smoke("smoke-live.sql"), unrolled);
  assert.equal(check().status, 1, "unstaged fix does not pass the commit");
  git("add", "-A");
  assert.equal(check().status, 0, "staged unrolled chain passes");

  console.log("check-staged-smoke-chains: OK");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
