## 2026-11-14 - Chemical sales gauntlet test repair

Added an isolated local chemical-sales profile with current-schema replay, local auth/storage, nine rolled-back SQL checks and two browser journeys. Repaired two historical proof runners without treating their historical results as current-schema proof. The default local stack and field-application scope are preserved. No application business code, production data or migration changed.

Observed fresh rebuild, SQL chains, browser quote/delivery/invoice lifecycle, stale and duplicate submissions, stock movement and downloaded PDF contents. Details and retained findings: `docs/audits/gauntlet/2026-11-14-chemical-sales-quoting-invoicing.md`; LOW follow-ups: #1881; known issues: KI-99 and KI-03. Rollback: revert this test-tool PR; stop only `crx-sales-gauntlet` locally.
