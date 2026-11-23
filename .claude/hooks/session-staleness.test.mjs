#!/usr/bin/env node
// Tests for session-staleness.mjs's schema-registry staleness check (FIX 1 + FIX 2,
// 2026-07-13). Each case gets its own scratch CLAUDE_PROJECT_DIR (schema-registry.json
// + supabase/migrations/) so nothing in the real repo is touched.
// Run: node .claude/hooks/session-staleness.test.mjs

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tempDir } from "../../scripts/lib/test-temp-dir.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }
const isolatedGitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
);

function runHook(projectDir, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(__dirname, "session-staleness.mjs")], {
    input: "",
    encoding: "utf8",
    // CRX_OFFSITE_BACKUP_DISABLE keeps the legacy marker-only cases offline and
    // deterministic; the OFFSITE cases below re-enable the check with a seeded
    // cache file and a bogus gh binary so no test ever touches the network.
    env: { ...isolatedGitEnv, CLAUDE_PROJECT_DIR: projectDir, CRX_OFFSITE_BACKUP_DISABLE: "1", ...extraEnv },
  });
}

function additionalContextOf(result) {
  if (!result.stdout.trim()) return "";
  const parsed = JSON.parse(result.stdout);
  return parsed?.hookSpecificOutput?.additionalContext || "";
}

function scaffold(dir, registry, migrationFiles) {
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  mkdirSync(path.join(dir, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(dir, ".claude", "schema-registry.json"), JSON.stringify(registry, null, 2));
  for (const [name, sql] of Object.entries(migrationFiles || {})) {
    writeFileSync(path.join(dir, "supabase", "migrations", name), sql);
  }
}

const REGISTRY_RELEVANT_SQL = "CREATE TABLE widgets (id int);";
const NON_RELEVANT_SQL = "-- data-only migration\nUPDATE widgets SET x = 1;";

const tmpRoot = tempDir("session-staleness-test-");

try {
  // ── FIX 1 (a): applied name present -> NOT flagged, even though the disk
  // stamp is numerically newer than migrations_high_water (the exact bug —
  // an MCP-applied migration got a server version LOWER than its filename) ──
  const dirA = path.join(tmpRoot, "a");
  scaffold(dirA, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: ["20260102000000_new_thing"] },
  }, { "20260102000000_new_thing.sql": REGISTRY_RELEVANT_SQL });
  let r = runHook(dirA);
  eq(r.status, 0, "FIX1(a): exits 0");
  ok(!additionalContextOf(r).includes("BEHIND"), "FIX1(a): applied name present in the list -> NOT flagged as behind");

  // ── FIX 1 (b): applied name ABSENT -> flagged (genuinely unapplied) ──────
  const dirB = path.join(tmpRoot, "b");
  scaffold(dirB, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: ["20260101000000_old_thing"] },
  }, { "20260102000000_new_thing.sql": REGISTRY_RELEVANT_SQL });
  r = runHook(dirB);
  ok(additionalContextOf(r).includes("BEHIND"), "FIX1(b): applied name absent -> flagged as behind");
  ok(additionalContextOf(r).includes("20260102000000_new_thing.sql"), "FIX1(b): names the specific missing file");

  // ── FIX 1: name match also accepts the `.sql`-suffixed live name shape ───
  const dirC = path.join(tmpRoot, "c");
  scaffold(dirC, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: ["20260102000000_new_thing.sql"] },
  }, { "20260102000000_new_thing.sql": REGISTRY_RELEVANT_SQL });
  r = runHook(dirC);
  ok(!additionalContextOf(r).includes("BEHIND"), "FIX1: applied name with .sql suffix still matches");

  // ── FIX 1: schema-neutral migration (no registry-relevant DDL) never flags,
  // even when its name is absent from the applied list ─────────────────────
  const dirD = path.join(tmpRoot, "d");
  scaffold(dirD, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: [] },
  }, { "20260102000000_data_only.sql": NON_RELEVANT_SQL });
  r = runHook(dirD);
  ok(!additionalContextOf(r).includes("BEHIND"), "FIX1: schema-neutral migration not flagged regardless of name-list membership");

  // ── #749: the keyword pre-filter must see CREATE OR REPLACE FUNCTION (the
  // repo's usual function form) and triggers. Before the fix, these three
  // real pending files were dropped from the warning (8 pending, 5 shown). ──
  const dirOrReplace = path.join(tmpRoot, "or-replace");
  const orReplaceFiles = {
    "20260914100100_next_invoice_number_year_chicago.sql": "CREATE OR REPLACE FUNCTION public.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$;",
    "20260914100300_refuse_stale_commission_payment.sql": "create   or\n  replace function public.g() returns void language sql as $$ $$;",
    "20260914100900_repair_commission_history_label.sql": "CREATE OR REPLACE FUNCTION public.h() RETURNS void LANGUAGE sql AS $$ $$;",
    "20260914101000_create_trigger_only.sql": "CREATE TRIGGER t AFTER INSERT ON widgets FOR EACH ROW EXECUTE FUNCTION public.f();",
    "20260914101100_drop_trigger_only.sql": "DROP TRIGGER IF EXISTS invoice_guard ON invoices;",
  };
  scaffold(dirOrReplace, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: [] },
  }, orReplaceFiles);
  r = runHook(dirOrReplace);
  for (const name of Object.keys(orReplaceFiles)) {
    ok(additionalContextOf(r).includes(name), `#749: ${name} is listed as pending`);
  }

  // ── FIX 1: migrations at/under the high-water mark are never candidates,
  // even if genuinely absent from the applied-name list (old pre-existing
  // drift is out of scope — see code comment) ─────────────────────────────
  const dirE = path.join(tmpRoot, "e");
  scaffold(dirE, {
    _meta: { migrations_high_water: "20260103000000", applied_migration_names: [] },
  }, { "20260102000000_old_and_unnamed.sql": REGISTRY_RELEVANT_SQL });
  r = runHook(dirE);
  ok(!additionalContextOf(r).includes("BEHIND"), "FIX1: migration older than high-water is never a candidate, even if absent from the name list");

  // ── FIX 2: a server-assigned version AHEAD of every authored stamp must not
  // swallow written-but-unapplied migrations authored in between. The 2026-08-24
  // barrier apply recorded version 20260824185408 against name 20260816110000_*;
  // with the window boundary read from max(version), the unapplied
  // 20260819232000_* fell below the boundary and the BEHIND warning went silent.
  // The boundary must come from the max AUTHORED (name-prefix) stamp instead. ──
  const dirVersionAhead = path.join(tmpRoot, "version-ahead");
  scaffold(dirVersionAhead, {
    _meta: {
      migrations_high_water: "20260824185408", // apply-time version, days ahead
      applied_migration_names: ["20260816110000_cutover_barrier"],
    },
  }, {
    "20260816110000_cutover_barrier.sql": REGISTRY_RELEVANT_SQL,   // applied
    "20260819232000_bind_receipts.sql": REGISTRY_RELEVANT_SQL,     // written, NOT applied
  });
  r = runHook(dirVersionAhead);
  ok(additionalContextOf(r).includes("BEHIND"), "FIX2: version ahead of authored stamps still flags the in-between unapplied migration");
  ok(additionalContextOf(r).includes("20260819232000_bind_receipts.sql"), "FIX2: names the swallowed migration");
  ok(!additionalContextOf(r).includes("20260816110000_cutover_barrier.sql"), "FIX2: the applied migration itself is not flagged");

  // ── FIX 1: no applied_migration_names key at all -> falls back to the
  // original numeric-only compare (pre-FIX-1 registry shape) ──────────────
  const dirF = path.join(tmpRoot, "f");
  scaffold(dirF, {
    _meta: { migrations_high_water: "20260101000000" },
  }, { "20260102000000_new_thing.sql": REGISTRY_RELEVANT_SQL });
  r = runHook(dirF);
  ok(additionalContextOf(r).includes("BEHIND"), "FIX1: no applied_migration_names -> numeric fallback still flags a newer-stamped file");
  ok(additionalContextOf(r).includes("Supabase MCP"), "FIX1: numeric-fallback warning carries the new false-positive caveat");

  // ── FIX 2: registry present but unparseable JSON -> loud warning, not silent ──
  const dirG = path.join(tmpRoot, "g");
  mkdirSync(path.join(dirG, ".claude"), { recursive: true });
  mkdirSync(path.join(dirG, "supabase", "migrations"), { recursive: true });
  writeFileSync(path.join(dirG, ".claude", "schema-registry.json"), "{ not valid json ");
  r = runHook(dirG);
  eq(r.status, 0, "FIX2: unparseable registry still exits 0 (fail-open)");
  const ctxG = additionalContextOf(r);
  ok(ctxG.includes("session-staleness"), "FIX2: warning names the hook");
  ok(ctxG.includes("unreadable/unparseable"), "FIX2: warning text matches the SKIPPED-check pattern");
  ok(ctxG.includes("/regen-schema-registry") || ctxG.includes("regen-schema-registry"), "FIX2: warning points at the fix");

  // ── FIX 3: linked worktrees see the canonical checkout's gitignored backup
  // marker instead of falsely claiming that no backup exists. ──────────────
  const backupRepo = path.join(tmpRoot, "backup-repo");
  scaffold(backupRepo, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: [] },
  }, {});
  execFileSync("git", ["init", "-b", "main", backupRepo], { env: isolatedGitEnv, stdio: "ignore" });
  execFileSync("git", ["-C", backupRepo, "config", "user.email", "session-staleness@example.com"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", backupRepo, "config", "user.name", "Session Staleness Test"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", backupRepo, "add", ".claude", "supabase"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", backupRepo, "commit", "-m", "fixture"], { env: isolatedGitEnv, stdio: "ignore" });
  mkdirSync(path.join(backupRepo, "backups"), { recursive: true });
  writeFileSync(path.join(backupRepo, "backups", "LATEST-OK.json"), JSON.stringify({
    completed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    tables: 1,
    total_rows: 1,
  }));
  const linkedWorktree = path.join(tmpRoot, "backup-linked");
  execFileSync("git", ["-C", backupRepo, "worktree", "add", "--detach", linkedWorktree], { env: isolatedGitEnv, stdio: "ignore" });
  r = runHook(linkedWorktree);
  eq(r.status, 0, "FIX3: linked-worktree backup check exits 0");
  const linkedBackupContext = additionalContextOf(r);
  ok(linkedBackupContext.includes("Last DB backup is 8 days old"), "FIX3: linked worktree reads canonical marker and computes backup age");
  ok(!linkedBackupContext.includes("No database backup exists yet"), "FIX3: canonical backup marker prevents false missing-backup warning");

  // NEWEST-WINS (2026-08-10, replaces canonical-always-wins). /backup-db stamps
  // backups/LATEST-OK.json relative to the checkout it ran in, so a backup taken
  // from a worktree lives only in that worktree. Preferring the canonical marker
  // unconditionally made that real, recent backup invisible and warned "stale" at
  // every later session — which trains Mason to ignore the one warning that says
  // his only copy of production data died. Both halves are asserted below: the
  // fresher marker wins wherever it lives, and the protection the old rule
  // existed for (a stale local marker masking shared truth) still holds.
  mkdirSync(path.join(linkedWorktree, "backups"), { recursive: true });
  writeFileSync(path.join(linkedWorktree, "backups", "LATEST-OK.json"), JSON.stringify({
    completed_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    tables: 99,
    total_rows: 99,
  }));
  r = runHook(linkedWorktree);
  eq(r.status, 0, "FIX3: linked-worktree backup check with a local marker exits 0");
  const freshLocalContext = additionalContextOf(r);
  ok(!freshLocalContext.includes("Last DB backup is 8 days old"), "FIX3: a fresher worktree-local backup is not masked by the older canonical marker");
  ok(!freshLocalContext.includes("💾"), "FIX3: a 2-day-old backup taken from a worktree raises no backup warning at all");

  // Inverse: a STALE worktree-local marker must not mask a fresh canonical one.
  writeFileSync(path.join(linkedWorktree, "backups", "LATEST-OK.json"), JSON.stringify({
    completed_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    tables: 1,
    total_rows: 1,
  }));
  writeFileSync(path.join(backupRepo, "backups", "LATEST-OK.json"), JSON.stringify({
    completed_at: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
    tables: 1,
    total_rows: 1,
  }));
  r = runHook(linkedWorktree);
  const staleLocalContext = additionalContextOf(r);
  ok(!staleLocalContext.includes("💾"), "FIX3: a stale worktree-local marker cannot fake a stale backup when the canonical one is fresh");

  // ── FIX 3 (layout): an unsupported repository layout is REJECTED, never guessed
  // at. Under `--separate-git-dir` the Git directory sits outside the checkout, so
  // `path.dirname(<git-common-dir>)` lands on whatever happens to be the Git
  // directory's parent — here the shared temp root, standing in for a folder that
  // could easily hold some other project's backups/LATEST-OK.json. Reading that
  // would report a backup of a completely different database as this project's.
  // The decoy below is planted at exactly that wrong path and must go unread. ────
  mkdirSync(path.join(tmpRoot, "backups"), { recursive: true });
  writeFileSync(path.join(tmpRoot, "backups", "LATEST-OK.json"), JSON.stringify({
    completed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    tables: 1,
    total_rows: 1,
  }));
  const sepGitDir = path.join(tmpRoot, "sep-gitdir");
  const sepMain = path.join(tmpRoot, "sep-main");
  scaffold(sepMain, {
    _meta: { migrations_high_water: "20260101000000", applied_migration_names: [] },
  }, {});
  execFileSync("git", ["init", "-b", "main", `--separate-git-dir=${sepGitDir}`, sepMain], { env: isolatedGitEnv, stdio: "ignore" });
  execFileSync("git", ["-C", sepMain, "config", "user.email", "session-staleness@example.com"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", sepMain, "config", "user.name", "Session Staleness Test"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", sepMain, "add", ".claude", "supabase"], { env: isolatedGitEnv });
  execFileSync("git", ["-C", sepMain, "commit", "-m", "fixture"], { env: isolatedGitEnv, stdio: "ignore" });
  mkdirSync(path.join(sepMain, "backups"), { recursive: true });
  writeFileSync(path.join(sepMain, "backups", "LATEST-OK.json"), JSON.stringify({
    completed_at: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    tables: 1,
    total_rows: 1,
  }));
  const sepLinked = path.join(tmpRoot, "sep-linked");
  execFileSync("git", ["-C", sepMain, "worktree", "add", "--detach", sepLinked], { env: isolatedGitEnv, stdio: "ignore" });
  r = runHook(sepLinked);
  eq(r.status, 0, "FIX3: separate-git-dir linked worktree exits 0");
  const sepContext = additionalContextOf(r);
  ok(!sepContext.includes("Last DB backup is 8 days old"), "FIX3: an unsupported layout never reports a backup marker found beside the Git directory");
  ok(sepContext.includes("No database backup exists yet"), "FIX3: an unsupported layout says no backup rather than claiming an unrelated one");

  // ── OFFSITE (2026-08-18): the marker is per-checkout but the SCHEDULED backup
  // runs as the "Off-site DB backup" workflow in masonwells1/CRX_Backups, so a
  // fresh worktree's stale marker used to fire a false "backup died" alarm.
  // Real evidence (gh, cached) must veto it. Every case here seeds the cache and
  // points CRX_OFFSITE_BACKUP_GH at a nonexistent binary: a hit on the network,
  // or a broken TTL that triggers a refetch, fails the test instead of passing
  // it by accident. ─────────────────────────────────────────────────────────
  const daysAgoIso = (d) => new Date(Date.now() - d * 24 * 60 * 60 * 1000).toISOString();
  const seedCache = (file, entry, fetchedAt = new Date().toISOString()) =>
    writeFileSync(file, JSON.stringify({ fetched_at: fetchedAt, ...entry }));
  const offsiteEnv = (cacheFile) => ({
    CRX_OFFSITE_BACKUP_DISABLE: "",
    CRX_OFFSITE_BACKUP_CACHE: cacheFile,
    CRX_OFFSITE_BACKUP_GH: "crx-no-such-gh-binary",
  });
  const REGISTRY_OK = { _meta: { migrations_high_water: "20260101000000", applied_migration_names: [] } };
  function scaffoldWithMarker(dir, markerAgeDays) {
    scaffold(dir, REGISTRY_OK, {});
    if (markerAgeDays !== null) {
      mkdirSync(path.join(dir, "backups"), { recursive: true });
      writeFileSync(path.join(dir, "backups", "LATEST-OK.json"), JSON.stringify({
        completed_at: daysAgoIso(markerAgeDays), tables: 1, total_rows: 1,
      }));
    }
  }

  // OFFSITE (a): the exact 2026-08-18 false alarm — stale local marker, but the
  // off-site workflow succeeded 2 days ago → NO backup warning at all.
  const dirH = path.join(tmpRoot, "h");
  scaffoldWithMarker(dirH, 9);
  const cacheH = path.join(tmpRoot, "cache-h.json");
  seedCache(cacheH, { ok: true, completed_at: daysAgoIso(2) });
  r = runHook(dirH, offsiteEnv(cacheH));
  eq(r.status, 0, "OFFSITE(a): exits 0");
  ok(!additionalContextOf(r).includes("💾"), "OFFSITE(a): a fresh off-site run vetoes the stale-marker false alarm");

  // OFFSITE (b): no local marker at all (fresh worktree), fresh off-site run →
  // no "No database backup exists yet" false alarm either.
  const dirI = path.join(tmpRoot, "i");
  scaffoldWithMarker(dirI, null);
  const cacheI = path.join(tmpRoot, "cache-i.json");
  seedCache(cacheI, { ok: true, completed_at: daysAgoIso(2) });
  r = runHook(dirI, offsiteEnv(cacheI));
  ok(!additionalContextOf(r).includes("💾"), "OFFSITE(b): a fresh off-site run vetoes the missing-marker false alarm");

  // OFFSITE (c): BOTH sources stale → the alarm is real; newest evidence (the
  // 9-day marker) sets the age and the off-site staleness is cited as proof.
  const dirJ = path.join(tmpRoot, "j");
  scaffoldWithMarker(dirJ, 9);
  const cacheJ = path.join(tmpRoot, "cache-j.json");
  seedCache(cacheJ, { ok: true, completed_at: daysAgoIso(20) });
  r = runHook(dirJ, offsiteEnv(cacheJ));
  const ctxJ = additionalContextOf(r);
  ok(ctxJ.includes("Last DB backup is 9 days old"), "OFFSITE(c): both sources stale -> warns with the NEWEST evidence's age");
  ok(ctxJ.includes("CRX_Backups") && ctxJ.includes("20 days ago"), "OFFSITE(c): warning cites the off-site workflow as verification");

  // OFFSITE (d): gh previously failed (fresh failure cache) → fall back to the
  // marker-only verdict, explicitly labeled unverified. The failure cache must
  // be honored within its TTL: the file's content must NOT be rewritten.
  const dirK = path.join(tmpRoot, "k");
  scaffoldWithMarker(dirK, 9);
  const cacheK = path.join(tmpRoot, "cache-k.json");
  seedCache(cacheK, { ok: false });
  const cacheKBefore = readFileSync(cacheK, "utf8");
  r = runHook(dirK, offsiteEnv(cacheK));
  const ctxK = additionalContextOf(r);
  ok(ctxK.includes("Last DB backup is 9 days old"), "OFFSITE(d): gh unavailable -> marker-only warning still fires");
  ok(ctxK.includes("could not verify") || ctxK.includes("gh unavailable"), "OFFSITE(d): fallback warning is labeled unverified");
  eq(readFileSync(cacheK, "utf8"), cacheKBefore, "OFFSITE(d): a failure cache inside its TTL is honored, not refetched");

  // OFFSITE (e): cache EXPIRED → refetch is attempted; with gh unavailable the
  // failure is cached (so the next session start doesn't stall) and the verdict
  // falls back to the marker.
  const dirL = path.join(tmpRoot, "l");
  scaffoldWithMarker(dirL, 9);
  const cacheL = path.join(tmpRoot, "cache-l.json");
  seedCache(cacheL, { ok: true, completed_at: daysAgoIso(2) }, new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString());
  r = runHook(dirL, offsiteEnv(cacheL));
  const ctxL = additionalContextOf(r);
  ok(ctxL.includes("Last DB backup is 9 days old"), "OFFSITE(e): expired cache + failed refetch -> marker fallback fires");
  const cacheLAfter = JSON.parse(readFileSync(cacheL, "utf8"));
  eq(cacheLAfter.ok, false, "OFFSITE(e): the failed refetch is cached as a failure");

  // OFFSITE (f): a cached answer with NO success date is re-checked rather than
  // trusted (2026-10-02). With gh unavailable and no marker it must still warn
  // loudly, but labeled unverified — an empty sample is not proof that the
  // workflow never succeeded (CodeRabbit, PR #874).
  const dirM = path.join(tmpRoot, "m");
  scaffoldWithMarker(dirM, null);
  const cacheM = path.join(tmpRoot, "cache-m.json");
  seedCache(cacheM, { ok: true, completed_at: null });
  r = runHook(dirM, offsiteEnv(cacheM));
  const ctxM = additionalContextOf(r);
  ok(ctxM.includes("💾") && ctxM.includes("No database backup exists yet"), "OFFSITE(f): no marker + no dated off-site success -> no-backup warning");
  ok(ctxM.includes("Could not verify") && !ctxM.includes("never succeeded"), "OFFSITE(f): the warning is labeled unverified, not 'never succeeded'");

  // OFFSITE (g): gh ANSWERS, with 20 runs and none successful. An older success
  // may sit beyond the sample, so the warning is unverified, not "never
  // succeeded" (CodeRabbit, PR #874). The fake gh is a shell script, which
  // execFileSync cannot launch on Windows, so this case runs on POSIX (CI) only.
  if (process.platform !== "win32") {
    const dirN = path.join(tmpRoot, "n");
    scaffoldWithMarker(dirN, null);
    const fakeGh = path.join(tmpRoot, "fake-gh-no-success.sh");
    const runs = Array.from({ length: 20 }, (_, i) => ({ conclusion: "failure", updatedAt: daysAgoIso(i + 1) }));
    writeFileSync(fakeGh, `#!/bin/sh\necho '${JSON.stringify(runs)}'\n`, { mode: 0o755 });
    const cacheN = path.join(tmpRoot, "cache-n.json");
    r = runHook(dirN, { ...offsiteEnv(cacheN), CRX_OFFSITE_BACKUP_GH: fakeGh });
    const ctxN = additionalContextOf(r);
    ok(ctxN.includes("Could not verify") && !ctxN.includes("never succeeded"),
      "OFFSITE(g): 20 runs with no success -> unverified, not 'never succeeded'");
    eq(JSON.parse(readFileSync(cacheN, "utf8")).ok, false, "OFFSITE(g): the no-success sample is cached as unverified");
  }

  // ── HOOKSPATH (2026-11-01): a worktree whose core.hooksPath points at another
  // checkout silently runs that checkout's older guards. ─────────────────────
  {
    const hooksRepo = path.join(tmpRoot, "hooks-repo");
    const foreign = path.join(tmpRoot, "other-checkout", ".husky");
    for (const dir of [path.join(hooksRepo, ".husky"), foreign]) {
      mkdirSync(dir, { recursive: true });
      for (const hook of ["pre-commit", "pre-push"]) writeFileSync(path.join(dir, hook), "#!/bin/sh\n", { mode: 0o755 });
    }
    execFileSync("git", ["init", "-b", "main", hooksRepo], { env: isolatedGitEnv, stdio: "ignore" });

    execFileSync("git", ["-C", hooksRepo, "config", "core.hooksPath", foreign], { env: isolatedGitEnv });
    r = runHook(hooksRepo);
    eq(r.status, 0, "HOOKSPATH: foreign hooksPath still exits 0");
    const ctxForeign = additionalContextOf(r);
    ok(ctxForeign.includes("guards are NOT this checkout's"), "HOOKSPATH: foreign hooksPath is warned about");
    ok(ctxForeign.includes("--worktree --unset core.hooksPath"), "HOOKSPATH: warning names the fix");

    execFileSync("git", ["-C", hooksRepo, "config", "core.hooksPath", ".husky"], { env: isolatedGitEnv });
    r = runHook(hooksRepo);
    ok(!additionalContextOf(r).includes("guards are NOT"), "HOOKSPATH: own .husky gives no warning");

    r = runHook(path.join(tmpRoot, "a"));
    ok(!additionalContextOf(r).includes("guards are NOT"), "HOOKSPATH: a folder outside git gives no warning");
  }

  // ── MAIN-BEHIND (2026-11-21): the main checkout, where hooks and merge gates
  // run, lagged origin/main by 509 commits and refused valid Sol proofs. ──────
  {
    const mainRepo = path.join(tmpRoot, "behind-main");
    const linked = path.join(tmpRoot, "behind-linked");
    const git = (...args) => execFileSync("git", ["-C", mainRepo, ...args], { env: isolatedGitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    execFileSync("git", ["init", "-b", "main", mainRepo], { env: isolatedGitEnv, stdio: "ignore" });
    git("config", "user.email", "session-staleness@example.com");
    git("config", "user.name", "Session Staleness Test");
    git("commit", "--allow-empty", "-m", "base");
    // 51 commits on a fake origin/main, without moving the checkout's HEAD.
    let tip = git("rev-parse", "HEAD");
    for (let i = 0; i < 51; i++) tip = git("commit-tree", "HEAD^{tree}", "-p", tip, "-m", `upstream ${i}`);
    git("update-ref", "refs/remotes/origin/main", tip);
    git("worktree", "add", "--detach", linked);

    r = runHook(linked);
    eq(r.status, 0, "MAIN-BEHIND: exits 0");
    const ctxBehind = additionalContextOf(r);
    ok(ctxBehind.includes("51 commits behind origin/main"), "MAIN-BEHIND: a linked worktree warns that the main checkout is 51 behind");
    ok(ctxBehind.includes("merge --ff-only origin/main"), "MAIN-BEHIND: warning names the fix");
    ok(ctxBehind.includes("gpt-6.2-sol"), "MAIN-BEHIND: warning names the symptom");

    git("merge", "--ff-only", "origin/main");
    r = runHook(linked);
    ok(!additionalContextOf(r).includes("behind origin/main"), "MAIN-BEHIND: an up-to-date main checkout gives no warning");

    git("update-ref", "-d", "refs/remotes/origin/main");
    r = runHook(linked);
    eq(r.status, 0, "MAIN-BEHIND: no origin/main still exits 0");
    ok(!additionalContextOf(r).includes("behind origin/main"), "MAIN-BEHIND: no origin/main stays silent");
  }

  // ── MAIN-ON-STAGING (2026-11-22): the main checkout tracks staging; session
  // start fetches it and tells the session to catch up, never changing the folder. ──
  {
    const mainRepo = path.join(tmpRoot, "staging-main");
    const linked = path.join(tmpRoot, "staging-linked");
    const git = (...args) => execFileSync("git", ["-C", mainRepo, ...args], { env: isolatedGitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    execFileSync("git", ["init", "-b", "staging", mainRepo], { env: isolatedGitEnv, stdio: "ignore" });
    git("config", "user.email", "session-staleness@example.com");
    git("config", "user.name", "Session Staleness Test");
    writeFileSync(path.join(mainRepo, "a.txt"), "one\n");
    writeFileSync(path.join(mainRepo, ".gitignore"), "local.json\n");
    git("add", "a.txt", ".gitignore");
    git("commit", "-m", "base");
    // Upstream staging: two commits ahead; the first starts tracking a locally ignored
    // file, the second changes a.txt.
    git("switch", "-c", "upstream");
    writeFileSync(path.join(mainRepo, "local.json"), "upstream\n");
    git("add", "-f", "local.json");
    git("commit", "-m", "upstream 1");
    writeFileSync(path.join(mainRepo, "a.txt"), "two\n");
    git("commit", "-am", "upstream 2");
    // A real bare origin; the hook must fetch it (no local origin/staging is seeded),
    // even under a narrowed fetch refspec that never names staging (Luna MED/LOW).
    const originRepo = path.join(tmpRoot, "staging-origin.git");
    execFileSync("git", ["init", "--bare", originRepo], { env: isolatedGitEnv, stdio: "ignore" });
    git("remote", "add", "origin", originRepo);
    git("config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
    git("push", "-q", "origin", "upstream:refs/heads/staging");
    git("switch", "staging");
    git("worktree", "add", "--detach", linked);

    // A decoy local tag named origin/staging must not stand in for the remote ref (Sol MED).
    git("tag", "origin/staging", "HEAD");
    // Behind: fetched, the session is told to catch up first, the folder is never touched.
    writeFileSync(path.join(mainRepo, "a.txt"), "local edit\n");
    const before = git("rev-parse", "HEAD");
    r = runHook(linked);
    eq(r.status, 0, "MAIN-ON-STAGING: exits 0");
    let ctx = additionalContextOf(r);
    ok(ctx.includes("ACTION FIRST") && ctx.includes("2 commit(s) behind origin/staging"), "MAIN-ON-STAGING: even a small lag tells the session to catch up first");
    const tip = git("rev-parse", "refs/remotes/origin/staging");
    ok(ctx.includes(`merge --ff-only --no-overwrite-ignore ${tip}`), "MAIN-ON-STAGING: the update names the exact fetched commit and keeps ignored files");
    ok(ctx.includes("symbolic-ref HEAD still prints refs/heads/staging") && ctx.includes("never delete a lock"), "MAIN-ON-STAGING: the steps re-check the branch and never delete a lock");
    eq(git("rev-parse", "HEAD"), before, "MAIN-ON-STAGING: the hook never moves the folder");
    eq(readFileSync(path.join(mainRepo, "a.txt"), "utf8"), "local edit\n", "MAIN-ON-STAGING: the hook never touches local edits");

    // Following the warning's own command with a locally ignored file in the way: refused, file kept.
    git("checkout", "--", "a.txt");
    writeFileSync(path.join(mainRepo, "local.json"), "mine\n");
    const cmd = ctx.match(/merge --ff-only --no-overwrite-ignore \S+/)[0].split(" ");
    assert.throws(() => git(...cmd), undefined, "MAIN-ON-STAGING: the prescribed merge refuses to overwrite an ignored file"); pass++;
    eq(readFileSync(path.join(mainRepo, "local.json"), "utf8"), "mine\n", "MAIN-ON-STAGING: the ignored file survives");

    // Caught up: silent.
    rmSync(path.join(mainRepo, "local.json"));
    git(...cmd);
    r = runHook(linked);
    ok(!additionalContextOf(r).includes("origin/staging"), "MAIN-ON-STAGING: an up-to-date folder stays silent");

    // Its own local commit: never "catch up"; ask Mason.
    git("commit", "--allow-empty", "-m", "local only");
    r = runHook(linked);
    ctx = additionalContextOf(r);
    ok(ctx.includes("1 local commit(s) that are not on origin/staging") && ctx.includes("NEEDS MASON"), "MAIN-ON-STAGING: local commits are flagged for Mason, not merged");
    ok(!ctx.includes("ACTION FIRST"), "MAIN-ON-STAGING: local commits never get the catch-up instruction");
  }

  console.log(`session-staleness: ${pass} assertions passed`);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}
