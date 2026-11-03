#!/usr/bin/env node
// Self-test for next-migration-stamp's choice logic with fixture stamp lists.
// Run: node scripts/next-migration-stamp.test.mjs
import assert from "node:assert/strict";
import { nextStamp, stampOf } from "./next-migration-stamp.mjs";

const NOW = new Date("2026-11-02T12:00:30Z");
const fixture = [
  { stamp: "20261101090000", source: "origin/main" },
  { stamp: "20261102180000", source: "open PR #1313" },
  { stamp: "20261102170000", source: "worktree C:/x" },
];

// Above the max (an open PR's) by at least the gap, and never equal to any listed stamp.
const a = nextStamp(fixture, { now: NOW });
assert.equal(a.stamp, "20261102190000");
assert.equal(a.top.source, "open PR #1313");
assert.ok(fixture.every((s) => a.stamp > s.stamp));

// Gap is configurable.
assert.equal(nextStamp(fixture, { gapMinutes: 5, now: NOW }).stamp, "20261102180500");

// Live high-water above everything on disk wins.
assert.equal(nextStamp([...fixture, { stamp: "20261103000000", source: "live" }], { now: NOW }).stamp, "20261103010000");

// When everything is old, use now rounded up to the next whole minute.
assert.equal(nextStamp([{ stamp: "20260101000000", source: "origin/main" }], { now: NOW }).stamp, "20261102120100");
assert.equal(nextStamp([], { now: NOW }).stamp, "20261102120100");

// A stamp with out-of-range digits still yields a strictly higher stamp.
const odd = nextStamp([{ stamp: "20261102235999", source: "origin/main" }], { gapMinutes: 0, now: NOW });
assert.ok(odd.stamp > "20261102235999", odd.stamp);

assert.equal(stampOf("supabase/migrations/20261102180000_x.sql"), "20261102180000");
assert.equal(stampOf("supabase/migrations/README.md"), null);
assert.equal(stampOf("20261102180000_x.sql"), "20261102180000");

console.log("next-migration-stamp tests passed");
