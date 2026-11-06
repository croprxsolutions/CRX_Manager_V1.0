#!/usr/bin/env node
// Run: node scripts/lib/migration-restamp-hint.test.mjs
import assert from "node:assert/strict";
import { withRestampHint } from "./migration-restamp-hint.mjs";

const refusal = 'LIVE MIGRATION ORDERING GUARD: refusing to apply "20261112120000_x".\n' +
  "Its filename timestamp is 20261112120000, but 20261113110000 has ALREADY BEEN APPLIED — this is an OLDER migration.";
const hinted = withRestampHint(refusal);
assert.ok(hinted.startsWith(refusal), "the original refusal is kept first");
assert.match(hinted, /npm run next-migration-stamp -- --live 20261113110000/, "names the stamp helper with the newest live stamp");
assert.match(hinted, /--carry-restamp/, "names the restamp proof carry");
assert.match(hinted, /ask Mason again/, "says the approval does not carry");
const other = "MIGRATION ORDERING GUARD: no applied-migration snapshot at x";
assert.equal(withRestampHint(other), other, "a snapshot problem gets no restamp advice");
assert.equal(withRestampHint("PROOF missing"), "PROOF missing", "other refusals are unchanged");
console.log("migration-restamp-hint: 6 assertions passed");
