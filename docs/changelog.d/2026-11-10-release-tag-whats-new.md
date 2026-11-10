## 2026-11-10 - Release tags, GitHub Releases and an in-app "What's new"

Last part of the staging-first release flow's automation (Taha, 2026-11-10).

- **`.github/workflows/release-tag.yml`**: when `release/next` or a `hotfix/<name>` PR merges into
  `main`, it tags the merge commit and publishes a GitHub Release. A release uses the version in
  `package.json` and its `CHANGELOG.md` section; a hotfix gets the next patch version and its PR
  title and summary: the next free patch above every tag and its own `package.json` version, so two
  hotfixes merged together get different numbers. A release tag that exists on another commit stops it
  with an error instead of moving the tag; a re-run finishes a release whose tag already points at the
  merge commit. A hotfix doesn't bump `package.json`, so the app keeps showing the release version.
- **`src/components/ui/WhatsNewDialog.tsx`**, mounted in `AppLayout`: after a release, each signed-in
  user sees the release's "What users see" lines once (remembered per user in this browser, so a
  second device shows it once more). No lines, no dialog. `src/releaseNotes.ts` is written by the
  release bot; it starts empty.

Tests: `src/components/ui/WhatsNewDialog.test.tsx` (once per version per user, new version, other
user, nothing to show, storage blocked) and `changelogSection` in `.github/scripts/release-flow.test.mjs`.
Inert until `RELEASE_FLOW` is `on`.
