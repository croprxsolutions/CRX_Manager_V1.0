## 2026-10-30 — #crx-alerts also gets failed checks on ready PRs and failed preview deploys

`.github/workflows/slack-alerts.yml` now covers the rest of Mason's list for #crx-alerts:
a failed CI run on a pull request that is ready for review, and a failed Vercel preview
deploy of a ready pull request. Draft pull requests never post. Production and `main`
alerts are unchanged apart from saying "Production" or "Preview" in the message.
