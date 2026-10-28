#!/usr/bin/env bash
# Vercel "Ignored Build Step" (wired up by `ignoreCommand` in vercel.json).
# Exit 0 = skip this build; exit 1 = build. Vercel bills every build by CPU minute,
# and most pushes only change notes the app never reads, so those builds are skipped.
#
# Fail-safe: whenever this script cannot prove the push is notes-only, it builds.

set -u

previous="${VERCEL_GIT_PREVIOUS_SHA:-}"
current="${VERCEL_GIT_COMMIT_SHA:-HEAD}"

# No earlier successful deployment on this branch (e.g. its first push): build.
if [ -z "$previous" ]; then
  echo "Build: no previous deployment to compare against."
  exit 1
fi

# The previous commit may be missing from Vercel's shallow clone, or gone after a force-push.
# --no-renames lists both sides of a move, so a site file moved into docs/ still counts.
if ! changed="$(git diff --no-renames --name-only "$previous" "$current" 2>/dev/null)"; then
  echo "Build: could not compare with the previous deployment ($previous)."
  exit 1
fi

if [ -z "$changed" ]; then
  echo "Build: no file differences found, building to be safe."
  exit 1
fi

# Paths the Vite build never reads. Markdown under src/ or public/ is excluded,
# because files there can end up in the built site.
app_files="$(printf '%s\n' "$changed" | grep -vE '^(docs/|\.claude/|\.agents/|\.codex/)' | grep -vE '^[^/]+\.md$|^(supabase|scripts)/.*\.md$')"

if [ -z "$app_files" ]; then
  echo "Skip: only notes and docs changed since $previous."
  exit 0
fi

echo "Build: app files changed, e.g. $(printf '%s\n' "$app_files" | head -1)"
exit 1
