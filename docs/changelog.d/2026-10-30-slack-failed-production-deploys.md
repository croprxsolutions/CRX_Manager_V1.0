## 2026-10-30 — #crx-alerts gets failed production deploys

`.github/workflows/slack-alerts.yml` now also posts to #crx-alerts when Vercel
reports a failed deploy of a commit on `main`, read from the commit status Vercel
already sends GitHub. Vercel's Slack marketplace app was not used: it is now an
interactive agent, not a deploy notifier.
