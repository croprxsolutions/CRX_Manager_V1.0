#!/usr/bin/env node
// Tests for the live migration prerequisite (#2193): the modes-of-action load is
// refused until the live EPA batch fill has run.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOA_MIN_MATCHED, checkLivePrerequisite, mcpPrerequisiteRefusal, moaMatchCountQuery, prerequisiteFor,
} from "./migration-prerequisite-lib.mjs";
import { evaluateMigrationApply } from "./migration-apply-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOAD = "20270205150000_ingredient_modes_of_action_load";
const SQL = readFileSync(path.join(ROOT, "supabase", "migrations", `${LOAD}.sql`), "utf8");
const fakeFetch = (body, ok = true) => async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
const check = (fetchImpl, name = LOAD, sql = SQL) =>
  checkLivePrerequisite({ fetchImpl, projectId: "p", token: "t", name, sql });

// Which migrations carry a prerequisite: the load, under any stamp; nothing else.
assert.ok(prerequisiteFor(LOAD));
assert.ok(prerequisiteFor(`supabase/migrations/20270301000000_ingredient_modes_of_action_load.sql`), "restamped copy");
assert.equal(prerequisiteFor("20270205140000_ingredient_modes_of_action"), null);
assert.equal(mcpPrerequisiteRefusal("20270208100000_something_else"), null);
// The load's SQL under another name is still caught (Luna MED), at both doors.
assert.ok(prerequisiteFor("20270208100000_something_else", SQL));
assert.match(mcpPrerequisiteRefusal("20270208100000_something_else", SQL), /MIGRATION PREREQUISITE/);
const renamed = evaluateMigrationApply({ name: "20270208100000_something_else", query: SQL, projectId: "rhyzpcqhnizqbxphqdkr", projectDir: ROOT, cwd: ROOT });
assert.match(renamed.reason, /MIGRATION PREREQUISITE \(#2193\)/);

// The count query carries all 123 list rows from the migration itself.
const q = moaMatchCountQuery(SQL);
assert.equal((q.match(/MOA-1 list v2, approved by Mason 2026-11-18'\)/g) || []).length, 123);
assert.match(q, /FROM public\.active_ingredients a WHERE a\.status = 'active'/);
assert.throws(() => moaMatchCountQuery("SELECT 1;"), /could not find the load's list/);

// Sol MED/LOW round 1: lowercase VALUES, a comment naming the list, inherited names.
assert.equal((moaMatchCountQuery(SQL.replace(/(INSERT INTO moa1_list\s*\([^)]*\)\s*)VALUES/i, "$1values")).match(/MOA-1 list v2, approved by Mason 2026-11-18'\)/g) || []).length, 123);
assert.equal(prerequisiteFor("20270208100000_other", "-- see moa1_list in the load\nSELECT 1;"), null);
assert.equal(prerequisiteFor("20270208100000_constructor"), null);
assert.equal(prerequisiteFor("20270208100000___proto__"), null);
// Impossible or non-numeric counts fail closed.
assert.match((await check(fakeFetch([{ listed: 123, matched: 124 }]))).reason, /unreadable/);
assert.match((await check(fakeFetch([{ listed: 123, matched: [95] }]))).reason, /unreadable/);
assert.match((await check(fakeFetch([{ listed: "123", matched: "95" }]))).reason, /unreadable/);

// Refused below the threshold, with the count shown.
let r = await check(fakeFetch([{ listed: 123, matched: 12 }]));
assert.equal(r.ok, false);
assert.match(r.reason, /only 12 of the load's 123 list rows match an active ingredient/);
assert.match(r.reason, new RegExp(`at least ${MOA_MIN_MATCHED}`));
r = await check(fakeFetch([{ listed: 123, matched: MOA_MIN_MATCHED - 1 }]));
assert.equal(r.ok, false, "one short of the threshold is refused");

// Allowed at and above the threshold.
assert.deepEqual(await check(fakeFetch([{ listed: 123, matched: MOA_MIN_MATCHED }])), { ok: true, matched: MOA_MIN_MATCHED, listed: 123 });
assert.equal((await check(fakeFetch([{ listed: 123, matched: 99 }]))).ok, true);

// Fails closed: HTTP error, network error, odd shape, wrong list size, missing list.
assert.match((await check(fakeFetch([], false))).reason, /CHECK FAILED.*HTTP 500/);
assert.match((await check(async () => { throw new Error("offline"); })).reason, /CHECK FAILED.*offline/);
assert.match((await check(fakeFetch([{}]))).reason, /unreadable/);
assert.match((await check(fakeFetch([{ listed: 120, matched: 120 }]))).reason, /expected 123 list rows/);
assert.match((await check(fakeFetch([]), LOAD, "SELECT 1;")).reason, /CHECK FAILED/);

// Any other migration is not touched (and nothing is read).
let called = false;
assert.deepEqual(await check(async () => { called = true; }, "20270208100000_other", "ALTER TABLE x ADD COLUMN y int;"), { ok: true, skipped: true });
assert.equal(called, false);

// MCP door: refused outright, before any other gate, pointing at the script door.
const mcp = evaluateMigrationApply({ name: LOAD, query: SQL, projectId: "rhyzpcqhnizqbxphqdkr", projectDir: ROOT, cwd: ROOT });
assert.equal(mcp.decision, "block");
assert.match(mcp.reason, /MIGRATION PREREQUISITE \(#2193\).*apply-migration-file\.mjs/);

// An owner-approval caller without the live re-check is refused too (Luna BLOCKER).
const owner = evaluateMigrationApply({ name: LOAD, query: SQL, projectId: "rhyzpcqhnizqbxphqdkr", projectDir: ROOT, cwd: ROOT, ownerApprovalDoor: true });
assert.equal(owner.decision, "block");
assert.match(owner.reason, /MIGRATION PREREQUISITE \(#2193\)/);
// Only with the live re-check flag does this gate step aside (later gates still run).
const script = evaluateMigrationApply({ name: LOAD, query: SQL, projectId: "rhyzpcqhnizqbxphqdkr", projectDir: ROOT, cwd: ROOT, ownerApprovalDoor: true, livePrerequisiteRecheck: true });
assert.doesNotMatch(String(script.reason || ""), /MIGRATION PREREQUISITE \(#2193\)/);

// The one caller that sets the flag reads the live count and dies on a refusal
// before the transaction it transmits is built.
const applySrc = readFileSync(path.join(ROOT, "scripts", "apply-migration-file.mjs"), "utf8");
const preAt = applySrc.indexOf("await checkLivePrerequisite(");
assert.ok(preAt > 0, "apply-migration-file.mjs reads the live prerequisite");
assert.match(applySrc.slice(preAt, preAt + 200), /if \(!pre\.ok\) die\(2, pre\.reason\)/);
assert.ok(preAt < applySrc.indexOf("const wrapped ="), "checked before the transaction is built");
assert.ok(preAt > applySrc.indexOf("if (!confirm)"), "checked on the --confirm path");

console.log("MIGRATION_PREREQUISITE_LIB_TESTS_PASS");
