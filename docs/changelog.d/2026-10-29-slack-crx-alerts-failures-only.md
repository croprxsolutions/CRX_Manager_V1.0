## 2026-10-29 — #crx-alerts gets failures, security warnings and one daily summary

Mason asked that #crx-alerts carry only failures and serious issues. The GitHub
Slack app was unsubscribed from every event type in that channel (it cannot filter
to failures). In its place:

- `.github/workflows/slack-alerts.yml` posts to Slack only when CI or the daily
  landing summary fails (or times out) on `main`.
- The daily landing summary is also posted to Slack, with the count of open
  Dependabot and code-scanning warnings.

Both need the `SLACK_ALERTS_WEBHOOK_URL` repository secret (a Slack incoming
webhook for #crx-alerts). Without it the failure alert itself fails, and the daily
summary still posts to its GitHub issue but skips Slack.
