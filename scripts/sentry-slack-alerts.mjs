#!/usr/bin/env node
// Posts new high-priority Sentry issues to #crx-alerts (Mason, 2026-10-30). Sentry's
// own Slack connection needs a paid plan, so .github/workflows/sentry-slack-alerts.yml
// runs this every 30 minutes instead.
// shortcut: new issues only, not old issues that escalate or come back; the Sentry email rule still covers those.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { plainText } from "./daily-landing-summary.mjs";

const ORG = "crop-rx-solutions";
const PROJECT_ID = "4510932858175488";
const ISSUES_PAGE = `https://${ORG}.sentry.io/issues/`;
const WORKFLOW = "sentry-slack-alerts.yml";
const PAGE_SIZE = 100;
const SHOWN = 25;
// Sentry can list an issue slightly after it was first seen, so each run reads up
// to 10 minutes before it started. Both ends come from run start times, so one
// run's window begins exactly where the last successful run's ended.
const LAG_MS = 10 * 60_000;
const DEFAULT_WINDOW_MS = 30 * 60_000;

export function issueWindow({ runAt, lastRunAt, lookbackHours }) {
  const until = Date.parse(runAt) - LAG_MS;
  const since = lookbackHours ? until - lookbackHours * 3600_000
    : lastRunAt ? Date.parse(lastRunAt) - LAG_MS
    : until - DEFAULT_WINDOW_MS;
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

export function readLookback(value) {
  if (!value) return 0;
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) throw new Error("lookback_hours must be a number of hours up to 336");
  return hours;
}

export function issueQuery({ since, until }) {
  return `is:unresolved issue.priority:high firstSeen:>=${since} firstSeen:<${until}`;
}

// Sentry's next-page link, from its Link header. It always sends one; results="true" says it leads somewhere.
export function nextPage(link) {
  return /<([^>]+)>; rel="next"; results="true"/.exec(link ?? "")?.[1] ?? null;
}

// Error titles can quote the data that caused them, and #crx-alerts must not carry
// customer details, so a message names only the error's type, never its text.
function errorType(issue) {
  const type = issue.metadata?.type;
  return /^[A-Za-z][\w.]{0,60}$/.test(type ?? "") ? type : "Error";
}

export function slackText(issues) {
  const count = issues.length;
  const lines = issues.slice(0, SHOWN).map((issue) => {
    const link = `${ISSUES_PAGE}${encodeURIComponent(issue.shortId)}`;
    const users = Number(issue.userCount) || 0;
    return `<${link}|${plainText(issue.shortId)}> ${errorType(issue)} (${users} ${users === 1 ? "user" : "users"})`;
  });
  const more = count > SHOWN ? `\n<${ISSUES_PAGE}|${count - SHOWN} more in Sentry>` : "";
  return `:rotating_light: *${count} new Sentry ${count === 1 ? "error" : "errors"}*\n${lines.join("\n")}${more}`;
}

function runTimes(repo) {
  const gh = (args) => JSON.parse(execFileSync("gh", ["run", ...args, "--repo", repo, "--json", "createdAt"], { encoding: "utf8" }));
  const runAt = gh(["view", process.env.GITHUB_RUN_ID]).createdAt;
  const lastRunAt = gh(["list", "--workflow", WORKFLOW, "--status", "success", "--limit", "1"])[0]?.createdAt ?? null;
  return { runAt, lastRunAt };
}

async function main() {
  const { SENTRY_TOKEN: token, SLACK_WEBHOOK_URL: webhook, GITHUB_REPOSITORY: repo, LOOKBACK_HOURS: hours } = process.env;
  // Failing here keeps the last good run as the starting point, so no errors are skipped.
  if (!token || !webhook) throw new Error("SENTRY_ALERTS_TOKEN and SLACK_ALERTS_WEBHOOK_URL must both be set");
  const window = issueWindow({ ...runTimes(repo), lookbackHours: readLookback(hours) });
  let url = `https://us.sentry.io/api/0/organizations/${ORG}/issues/?${new URLSearchParams({
    project: PROJECT_ID, query: issueQuery(window), limit: String(PAGE_SIZE),
  })}`;
  const issues = [];
  while (url) {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(`Sentry read failed: HTTP ${response.status}`);
    issues.push(...await response.json());
    url = nextPage(response.headers.get("link"));
  }
  process.stdout.write(`${issues.length} new high-priority issue(s) from ${window.since} to ${window.until}.\n`);
  if (!issues.length) return;

  const posted = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: slackText(issues) }),
  });
  if (!posted.ok) throw new Error(`Slack post failed: HTTP ${posted.status}`);
  process.stdout.write("Posted to Slack.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`sentry-slack-alerts: ${error?.message || error}\n`);
    process.exit(1);
  });
}
