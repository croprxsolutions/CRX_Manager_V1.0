// Mason's release pass (Mason, 2026-11-20): `ship the release` / `go live #n` / `stop the release`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  RELEASE_PASS_MAX_AGE_MS, findReleasePass, recordReleasePass, releasePassCommand, releasePassCovers, releasePassFileName, unappliedMigrationsProblem, withdrawReleasePass,
} from "./release-pass-lib.mjs";

const SID = "sess-mason-chat-0001";

test("only the start of his message counts", () => {
  assert.deepEqual(releasePassCommand("ship the release").release, true);
  assert.equal(releasePassCommand("Ship release tonight").release, true);
  assert.deepEqual(releasePassCommand("go live #2105 and #2106").pullRequests, [2105, 2106]);
  assert.equal(releasePassCommand("go live").kind, "unnamed");
  assert.equal(releasePassCommand("go live after checking item 42").kind, "unnamed", "a number needs its #");
  assert.equal(releasePassCommand("stop the release").kind, "cancel");
  assert.equal(releasePassCommand("hold the release").kind, "cancel");
  for (const no of ["should we ship the release?", "I approve", "yes", "merge 2101", "don't go live #5", ""]) assert.equal(releasePassCommand(no), null, no);
});

test("record, find, widen, cover and withdraw a pass", () => {
  const root = mkdtempSync(path.join(tmpdir(), "release-pass-"));
  const dirs = [path.join(root, ".claude", "session-state")];
  try {
    // no .claude/ folder → nothing is written
    assert.equal(recordReleasePass({ dirs, sessionId: SID, release: true, pullRequests: [] }), null);
    mkdirSync(path.join(root, ".claude"));
    const now = Date.parse("2026-11-20T20:00:00Z");
    assert.ok(recordReleasePass({ dirs, sessionId: SID, release: false, pullRequests: [2105], now }));
    assert.ok(recordReleasePass({ dirs, sessionId: SID, release: true, pullRequests: [], now: now + 1000 }));
    const pass = findReleasePass({ dirs, sessionId: SID, now: now + 2000 });
    assert.equal(pass.release, true, "widened, not replaced");
    assert.deepEqual(pass.pullRequests, [2105]);
    assert.equal(findReleasePass({ dirs, sessionId: "sess-other-chat-0002", now }), null, "another session has no pass");
    assert.equal(findReleasePass({ dirs, sessionId: SID, now: now + 1000 + RELEASE_PASS_MAX_AGE_MS }), null, "expires after 24 hours");

    assert.equal(releasePassCovers(pass, { base: "main", headRef: "release/next", number: 77 }), true);
    assert.equal(releasePassCovers(pass, { base: "main", headRef: "hotfix/cents", number: 2105 }), true);
    assert.equal(releasePassCovers(pass, { base: "main", headRef: "hotfix/cents", number: 2106 }), false, "an unnamed hotfix");
    assert.equal(releasePassCovers(pass, { base: "staging", headRef: "main", number: 80 }), true, "the back-merge");
    assert.equal(releasePassCovers(pass, { base: "main", headRef: "claude/x", number: 2105 }), false, "feature branches never go to main");
    assert.equal(releasePassCovers({ ...pass, release: false }, { base: "main", headRef: "release/next", number: 77 }), false, "go live #n doesn't cover the release");
    assert.equal(releasePassCovers(null, { base: "main", headRef: "release/next", number: 77 }), false);

    // a tampered pass claiming more than 24 hours is no pass
    const file = path.join(dirs[0], releasePassFileName(SID));
    writeFileSync(file, JSON.stringify({ ...pass, expiresAt: new Date(Date.parse(pass.recordedAt) + RELEASE_PASS_MAX_AGE_MS + 1).toISOString() }));
    assert.equal(findReleasePass({ dirs, sessionId: SID, now: now + 2000 }), null);

    // a file that can't be deleted is overwritten so the gates see no pass
    recordReleasePass({ dirs, sessionId: SID, release: true, pullRequests: [], now });
    assert.deepEqual(withdrawReleasePass({ dirs, sessionId: SID, remove: () => { throw new Error("EBUSY"); } }), { stillLive: false });
    assert.equal(findReleasePass({ dirs, sessionId: SID, now: now + 2000 }), null, "a stuck file is neutralised");
    rmSync(file, { force: true });
    recordReleasePass({ dirs, sessionId: SID, release: true, pullRequests: [], now });
    assert.deepEqual(withdrawReleasePass({ dirs, sessionId: SID, remove: () => {}, write: () => { throw new Error("EACCES"); } }), { stillLive: true }, "neither delete nor overwrite: can't confirm");

    assert.deepEqual(withdrawReleasePass({ dirs, sessionId: SID }), { stillLive: false });
    assert.equal(findReleasePass({ dirs, sessionId: SID, now: now + 2000 }), null);
    assert.deepEqual(withdrawReleasePass({ dirs: [], sessionId: SID }), { stillLive: true }, "no folder can't confirm");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a pass-backed merge into main needs its migrations live first (Codex P1, PR #2098)", () => {
  const files = [["added", "supabase/migrations/20261120120000_a.sql"], ["modified", "src/x.ts"], ["removed", "supabase/migrations/20200101000000_old.sql"]];
  assert.equal(unappliedMigrationsProblem({ files: [["modified", "src/x.ts"]], snapshot: null }), null, "no migrations: nothing to check");
  assert.match(unappliedMigrationsProblem({ files, snapshot: null }), /no applied-migration snapshot/);
  assert.match(unappliedMigrationsProblem({ files, snapshot: { applied: [{ version: "20261101000000", name: "b" }] } }), /20261120120000_a are not live/);
  assert.equal(unappliedMigrationsProblem({ files, snapshot: { applied: [{ version: "20261120120000", name: "a" }] } }), null);
  assert.equal(unappliedMigrationsProblem({ files, snapshot: [{ name: "20261120120000_a" }] }), null, "a bare-array snapshot works too");
});
