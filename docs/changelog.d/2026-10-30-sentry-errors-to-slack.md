## 2026-10-30 — new Sentry errors reach #crx-alerts without a paid plan

Mason chose a free workaround over Sentry's Team plan, which Sentry's Slack
connection requires. `.github/workflows/sentry-slack-alerts.yml` runs every 30
minutes, and `scripts/sentry-slack-alerts.mjs` posts new high-priority issues to
#crx-alerts, so an alert can arrive up to about 40 minutes after the error.

It needs a `SENTRY_ALERTS_TOKEN` repository secret: a read-only Sentry internal
integration token. Old issues that escalate or come back are not posted; Sentry's
email rule still covers those.
