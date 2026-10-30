#!/usr/bin/env node
// Tests for the Sentry alert's pure parts. The Sentry and Slack calls are proven by a real run.
import assert from "node:assert/strict";
import { issueQuery, issueWindow, readLookback, safeTitle, slackText } from "./sentry-slack-alerts.mjs";

// ── windows join up, so an issue is neither missed nor posted twice ─────────
const runAt = "2026-10-30T12:40:00Z";
const first = issueWindow({ runAt, lastRunAt: "2026-10-30T12:10:00Z" });
assert.deepEqual(first, { since: "2026-10-30T12:00:00.000Z", until: "2026-10-30T12:30:00.000Z" });
const next = issueWindow({ runAt: "2026-10-30T13:10:00Z", lastRunAt: runAt });
assert.equal(next.since, first.until, "the next window starts where this one ended");
const late = issueWindow({ runAt, lastRunAt: "2026-10-30T08:00:00Z" });
assert.equal(late.since, "2026-10-30T07:50:00.000Z", "a failed or skipped run widens the window instead of losing issues");
assert.equal(issueWindow({ runAt, lastRunAt: null }).since, "2026-10-30T12:00:00.000Z", "first ever run reads 30 minutes");
assert.equal(issueWindow({ runAt, lastRunAt: "2026-10-30T12:10:00Z", lookbackHours: 2 }).since, "2026-10-30T10:30:00.000Z",
  "a manual look-back wins over the last run");

// ── a bad look-back stops the run rather than moving the starting point ────
assert.equal(readLookback(""), 0);
assert.equal(readLookback(undefined), 0);
assert.equal(readLookback("6"), 6);
for (const bad of ["-1", "abc", "9999"]) assert.throws(() => readLookback(bad), /lookback_hours/);

// ── the search keeps both ends of the window ───────────────────────────────
const query = issueQuery({ since: "A", until: "B" });
assert.ok(query.includes("issue.priority:high") && query.includes("firstSeen:>=A") && query.includes("firstSeen:<B"));

// ── error text is data, never Slack markup or customer contact details ─────
const one = slackText([{ shortId: "CRX-MANAGER-1H", title: "boom <!channel> | *x*\nsecond line", userCount: 1 }]);
assert.ok(one.startsWith(":rotating_light: *1 new Sentry error*\n"));
assert.ok(one.includes("<https://crop-rx-solutions.sentry.io/issues/CRX-MANAGER-1H|CRX-MANAGER-1H>"));
assert.ok(one.includes("(1 user)"));
assert.ok(!one.includes("<!channel>"), "an error title cannot ping the channel");
assert.equal(one.split("\n").length, 2, "an error title cannot add lines");
assert.equal(safeTitle("x &lt;!channel&gt;"), "x &amp;lt;!channel&amp;gt;", "an encoded ping stays plain text");
assert.equal(safeTitle("no user pat.smith+a@example.com found"), "no user (email) found");
assert.equal(safeTitle("bad phone +1 (555) 010-1234 given"), "bad phone (number) given");
assert.equal(safeTitle("call 555-1234 now"), "call (number) now", "a local phone number is covered");
assert.equal(safeTitle("Error 500 at step 12"), "Error 500 at step 12", "short numbers stay readable");

const many = slackText(Array.from({ length: 25 }, (_, index) => ({ shortId: `X-${index}`, title: "e", userCount: "2" })));
assert.ok(many.includes("*25 new Sentry errors*") && many.includes("(2 users)"));
assert.ok(many.includes("There may be more in Sentry"), "a full page says there may be more");

console.log("sentry-slack-alerts tests passed");
