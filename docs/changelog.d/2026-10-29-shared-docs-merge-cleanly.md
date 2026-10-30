## 2026-10-29 — Shared logs merge themselves; manual-doc stamps are one short line

- `.gitattributes`: `docs/reference/migration-history.md` and `docs/manual/DECISION_LOG.md` merge
  with git's built-in union driver, so two PRs adding rows, live captures or decisions at the same
  spot no longer conflict. Replayed against the 73 real conflicted main merges of these files since
  2026-10-20 (63 history, 10 decision log): all merge cleanly keeping both sides. A two-branch
  `git merge` proof both ways keeps both rows, captures and decisions; without the attribute it conflicts.
- `migration-history.md`: the title drops "(latest entry N)"; the top note says captures may be in
  any order (compare UTC timestamps) and to cite migrations by version, not row number.
- `check:docs` (`scripts/check-doc-drift.mjs`): the title-count check is replaced by "one table row
  per migration since 2026-09-15" (fails a missing row even when capture prose still names the
  migration, and two rows for one migration, e.g. a union merge that kept a candidate and an applied
  version). New: each manual doc has one "Last verified" line of at most 200 characters. The
  KNOWN_ISSUES/CURRENT_STATE freshness FAIL is unchanged.
- The long evidence paragraphs on the CURRENT_STATE, KNOWN_ISSUES and DECISION_LOG stamp lines
  moved word for word to `docs/manual/archive/verification-notes-2026-10.md`; the stamps keep their
  date and scope. Evidence for future re-checks goes in each PR's changelog note.
- `update-docs` skill, `/ship`, `agent-guardrails.md` and a DECISION_LOG entry describe the rules.
  Design reviewed by Sol (go with changes); its five MED safeguards are built in.
