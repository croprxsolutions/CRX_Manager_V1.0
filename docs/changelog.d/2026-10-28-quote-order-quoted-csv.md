## 2026-10-28 - Quote and order CSV quoted fields (To-Do 1.10)

Built on branch `codex/quote-order-quoted-fields`; parked for Mason's requested no-merge batch.
Not merged, deployed, or verified in production. No migration or production writes required.

- Both import dialogs share a focused CSV record parser. Quoted names retain commas and
  doubled double quotes; quoted multiline notes and LF, CRLF, and CR line endings are supported.
- Existing column aliases and domain validation remain in place. Blank records are skipped,
  UTF-8 BOM headers work, apostrophes remain literal, and validation uses physical source lines.
- Unclosed quotes, misplaced quotes, and mismatched column counts reject the entire parse
  with a source line and correction guidance. A failed re-parse clears its previous preview.
- Formats remain CSV, or PDF/image through the existing OCR path; this does not add XLSX support.
- Focused parser/import tests cover successful payload mapping and malformed input. Both new
  quoted-import regressions were observed failing against the original importer source.
- Local synthetic browser proof exercises both real dialogs as admin and sales rep. It uses
  dependency stubs and makes no production requests; it does not prove database execution.
- Observed proof: 50 focused tests pass; both quoted-import tests fail on original source;
  eight browser success/failure checks pass with zero external requests and zero page errors.
  Lint, TypeScript, production build, code-health, and agent-guidance checks pass.

Rollback: revert this isolated parser/import change before release; no data rollback is needed.
Before release: finish applicable independent reviews and protected PR checks, and verify the
release candidate against current main. Shared to-do/status documents are intentionally left
for the coordinator to update after the parallel batch is reconciled.
