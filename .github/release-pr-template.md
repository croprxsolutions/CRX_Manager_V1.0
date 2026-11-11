## 🚀 Release Pull Request

## 📦 Release Version: <!-- bot:version -->vX.Y.Z<!-- /bot:version -->
**Target Environment:** Production
**Scheduled Release Date:** <!-- bot:date -->YYYY-MM-DD<!-- /bot:date -->

_The bot fills the parts between its markers each time staging or a label changes; everything else is yours and is kept. To change the version, edit the PR title (`release: vX.Y.Z`). Merge with **"Create a merge commit"**, never squash._

### 📝 Summary
<!-- bot:summary --><!-- /bot:summary -->

### 🔄 Type of Release
- [ ] Major (Breaking changes, significant new features)
- [ ] Minor (Backward-compatible feature additions)
- [ ] Patch (Bug fixes, security updates, performance tweaks)
- [ ] Hotfix (Emergency fix deployed directly)

---

### 🗂️ Changelog
<!-- bot:changelog --><!-- /bot:changelog -->

### ✅ Included PRs and their staging status
<!-- bot:status --><!-- /bot:status -->

### 👀 What users see
<!-- bot:users --><!-- /bot:users -->

---

### ⚠️ Deployment & Infrastructure Notes
*   **Environment Variable Changes:** [Yes/No - List any new or modified keys]
*   **Database Migrations:** <!-- bot:migrations -->None<!-- /bot:migrations --> [Detail any specific manual execution steps needed]
*   **Breaking Changes / Downtime Expected:** [Yes/No - Detail if a maintenance window is required]
*   **Third-Party Dependencies:** [List any new services, APIs, or major library updates]

---

### 🧪 Validation & Testing Checklist (before merging)
- [ ] Staging/Pre-production verification has passed (the `release-gate` check is green: every PR above is verified on staging or held off).
- [ ] All automated CI/CD pipeline tests are green.
- [ ] Database backup plans and rollback procedures are confirmed (today's backup exists).
- [ ] Monitoring and alerting tools (Sentry, #crx-alerts) are verified active.

### 🚦 Post-deploy production checklist (after merging)
- [ ] The live database job finished and its hash check passed (or the release has no migrations).
- [ ] The production deploy is Ready on Vercel; https://croprxsolutions.app loads and sign-in works.
- [ ] The headline changes above work on production.
- [ ] No new Sentry errors in the 30 minutes after the deploy.
- [ ] The back-merge PR (main → staging) is merged with a merge commit.
- [ ] The release tag and GitHub Release exist.

---

### 🕒 Rollback Plan
In case of a critical failure post-deployment (details: `docs/operations/production-runbook.md` §3):
1. **App:** Vercel → Deployments → the production deployment before this release → "Promote to Production" (~30 seconds).
2. **Database:** no down scripts. Ship a forward-fix migration as a `hotfix/<name>` PR; restore the backup only for data corruption.
3. **Edge functions:** redeploy the previous version's source (needs approval).
4. Then fix properly through a hotfix PR and the same-day back-merge into staging.
