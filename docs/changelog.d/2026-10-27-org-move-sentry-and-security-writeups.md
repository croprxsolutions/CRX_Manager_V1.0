## 2026-10-27 — Org-move checklist covers Sentry; security fixes are written up without exploit detail

- `docs/operations/github-org-move.md`: step 3 installs Sentry's GitHub integration on the `croprxsolutions` organization (it links errors to suspect commits and is installed per account), and step 7 checks that Vercel deploys and Sentry lists the repo after the move. Raised by Taha K.
- `AGENTS.md` › Safety and Protected Delivery: until a security fix is live, its PR, commits, changelog entry and docs say what changes, not how to use the hole; the full explanation goes in after it is applied (the repository is public). Agreed with Taha K. after #1103 described an open hole for several days.
