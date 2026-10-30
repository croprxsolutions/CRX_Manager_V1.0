## 2026-10-29 — The workflow map keeps its date when nothing changed

- `scripts/generate-workflow-map.mjs` no longer rewrites `docs/app-workflow-map.html` just to
  bump its "Updated" date: an unchanged map is left as it is, and the date moves only when
  the map's content changes. 12 of the 15 commits that touched the map since 2026-10-15
  changed only its summary line, mostly the date, and that line collided between PRs.
- Proof: a run with no source change leaves the file untouched; a run after adding a
  navigate call updates the map and the date; CI's freshness check still passes.
