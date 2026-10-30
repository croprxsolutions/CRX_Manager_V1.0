#!/usr/bin/env node
// Tests for the Sentry alert's pure parts. The Sentry and Slack calls are proven by a real run.
import assert from "node:assert/strict";
import { issueQuery, issueWindow, slackText } from "./sentry-slack-alerts.mjs";

const now = Date.parse("2026-10-30T12:40:00.000Z");

// ── windows join up, so an issue is neither missed nor posted twice ─────────
const first = issueWindow({ now, lastRunAt: "2026-10-30T12:10:00Z" });
assert.deepEqual(first, { since: "2026-10-30T12:00:00.000Z", until: "2026-10-30T12:30:00.000Z" });
const next = issueWindow({ now: now + 1800_000, lastRunAt: new Date(now).toISOString() });
assert.equal(next.since, first.until, "the next window starts where this one ended");
const late = issueWindow({ now, lastRunAt: "2026-10-30T08:00:00Z" });
assert.equal(late.since, "2026-10-30T07:50:00.000Z", "a skipped run widens the window instead of losing issues");
assert.equal(issueWindow({ now, lastRunAt: null }).since, "2026-10-30T12:00:00.000Z", "first ever run reads 30 minutes");
assert.equal(issueWindow({ now, lastRunAt: "2026-10-30T12:10:00Z", lookbackHours: 2 }).since, "2026-10-30T10:30:00.000Z",
  "a manual look-back wins over the last run");

// ── the search keeps both ends of the window ───────────────────────────────
const query = issueQuery({ since: "A", until: "B" });
assert.ok(query.includes("issue.priority:high") && query.includes("firstSeen:>=A") && query.includes("firstSeen:<B"));

// ── error text is data, never Slack markup ─────────────────────────────────
const one = slackText([{ shortId: "CRX-MANAGER-1H", title: "boom <!channel> | *x*\nsecond line", userCount: 1 }]);
assert.ok(one.startsWith(":rotating_light: *1 new Sentry error*\n"));
assert.ok(one.includes("<https://crop-rx-solutions.sentry.io/issues/CRX-MANAGER-1H|CRX-MANAGER-1H>"));
assert.ok(one.includes("(1 user)"));
assert.ok(!one.includes("<!channel>"), "an error title cannot ping the channel");
assert.equal(one.split("\n").length, 2, "an error title cannot add lines");

const many = slackText(Array.from({ length: 25 }, (_, index) => ({ shortId: `X-${index}`, title: "e", userCount: "2" })));
assert.ok(many.includes("*25 new Sentry errors*") && many.includes("(2 users)"));
assert.ok(many.includes("There may be more in Sentry"), "a full page says there may be more");

console.log("sentry-slack-alerts tests passed");
