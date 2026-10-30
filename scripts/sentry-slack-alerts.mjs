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
const LIMIT = 25;
// Sentry can list an issue slightly after it was first seen. Reading a window that
// ends 10 minutes ago, starting where the last one ended, avoids gaps and repeats.
const LAG_MS = 10 * 60_000;
const DEFAULT_WINDOW_MS = 30 * 60_000;

export function issueWindow({ now, lastRunAt, lookbackHours }) {
  const until = now - LAG_MS;
  const since = lookbackHours ? until - lookbackHours * 3600_000
    : lastRunAt ? Date.parse(lastRunAt) - LAG_MS
    : until - DEFAULT_WINDOW_MS;
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString() };
}

export function issueQuery({ since, until }) {
  return `is:unresolved issue.priority:high firstSeen:>=${since} firstSeen:<${until}`;
}

export function slackText(issues) {
  const count = issues.length;
  const lines = issues.map((issue) => {
    const link = `${ISSUES_PAGE}${encodeURIComponent(issue.shortId)}`;
    const users = Number(issue.userCount) || 0;
    return `<${link}|${plainText(issue.shortId)}> ${plainText(issue.title)} (${users} ${users === 1 ? "user" : "users"})`;
  });
  const more = count >= LIMIT ? `\n<${ISSUES_PAGE}|There may be more in Sentry>` : "";
  return `:rotating_light: *${count} new Sentry ${count === 1 ? "error" : "errors"}*\n${lines.join("\n")}${more}`;
}

function lastSuccessfulRun(repo) {
  const runs = JSON.parse(execFileSync("gh", ["run", "list", "--repo", repo, "--workflow", "sentry-slack-alerts.yml",
    "--status", "success", "--limit", "1", "--json", "createdAt"], { encoding: "utf8" }));
  return runs[0]?.createdAt ?? null;
}

async function main() {
  const { SENTRY_TOKEN: token, SLACK_WEBHOOK_URL: webhook, GITHUB_REPOSITORY: repo, LOOKBACK_HOURS: hours } = process.env;
  if (!token) {
    process.stdout.write("SENTRY_TOKEN is not set; nothing to check.\n");
    return;
  }
  const lookbackHours = Number(hours) || 0;
  const window = issueWindow({ now: Date.now(), lastRunAt: lookbackHours ? null : lastSuccessfulRun(repo), lookbackHours });
  const url = `https://us.sentry.io/api/0/organizations/${ORG}/issues/?${new URLSearchParams({
    project: PROJECT_ID, query: issueQuery(window), limit: String(LIMIT),
  })}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Sentry read failed: HTTP ${response.status}`);
  const issues = await response.json();
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
