## 2026-10-29 - Tighten agent startup contracts

- Shortened the shared project contract while retaining task routes, database hard rules, approval boundaries, review requirements and observed-behavior verification.
- Removed repeated proof-renewal and review-sequencing detail from startup; the existing shipping workflow retains those procedures under main's October 29 policy: Sol before the PR; CodeRabbit optional unless labelled.
- Kept the guidance checker and all enforcement hooks unchanged. Global Codex preferences are maintained separately on the workstation and are not published in this repository.
- Rollback: revert this documentation change through the protected PR path; no application or database rollback is required.
