#!/usr/bin/env node
// Tests for the Sentry alert's pure parts. The Sentry and Slack calls are proven by a real run.
import assert from "node:assert/strict";
import { issueQuery, issueWindow, nextPage, readLookback, slackText } from "./sentry-slack-alerts.mjs";

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

// ── every page is read, so a burst of errors is not lost ──────────────────
const lastPage = '<https://x/?cursor=a>; rel="previous"; results="false", <https://x/?cursor=b>; rel="next"; results="false"';
const morePages = '<https://x/?cursor=a>; rel="previous"; results="false", <https://x/?cursor=b>; rel="next"; results="true"';
assert.equal(nextPage(morePages), "https://x/?cursor=b");
assert.equal(nextPage(lastPage), null);
assert.equal(nextPage(null), null);

// ── a message carries no error text, so no customer details ────────────────
const title = "no user pat.smith@example.com at 12 Elm St <!channel>";
const one = slackText([{ shortId: "CRX-MANAGER-1H", title, metadata: { type: "EvalError", value: title }, userCount: 1 }]);
assert.equal(one, ":rotating_light: *1 new Sentry error*\n<https://crop-rx-solutions.sentry.io/issues/CRX-MANAGER-1H|CRX-MANAGER-1H> EvalError (1 user)");
const sneaky = slackText([{ shortId: "X-1", metadata: { type: "pat.smith@example.com <!channel>" }, userCount: 0 }]);
assert.ok(sneaky.includes("X-1> Error (0 users)"), "a type that is not a plain class name is not shown");
assert.ok(slackText([{ shortId: "X-1", title: "failLoad" }]).includes("X-1> Error (0 users)"), "no type falls back to Error");

const many = slackText(Array.from({ length: 30 }, (_, index) => ({ shortId: `X-${index}`, userCount: "2" })));
assert.ok(many.includes("*30 new Sentry errors*") && many.includes("(2 users)"));
assert.equal(many.split("\n").length, 27, "heading, 25 errors, and a link for the rest");
assert.ok(many.includes("|5 more in Sentry>"));

console.log("sentry-slack-alerts tests passed");
