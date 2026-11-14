## 2026-11-11 - Release labels wait for RELEASE_FLOW

`.github/workflows/release-labels.yml` now runs only when the repository variable `RELEASE_FLOW` is
`on`, like the rest of the release flow.

The workflow takes its rules from main's copy of `.github/scripts/release-flow.mjs`. Main has had no
copy, so nothing ran. Once the release-flow files reach main, the jobs would have started straight away:
- adding `on-staging` to merged PRs;
- removing `verified-on-staging` or `held-off` labels that have no proof line, with a comment;
- dispatching a no-op release PR run on every staging PR merge or edit.

That would land on everyone's PRs before the flow is switched on and announced. With the gate, both jobs
are skipped until switch-on. PRs merged into staging before then carry no `on-staging` label.
