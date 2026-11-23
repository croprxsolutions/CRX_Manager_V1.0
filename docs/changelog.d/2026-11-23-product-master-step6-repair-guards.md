## 2026-11-23 - Product Master repair step 6 finished (KI-164, To-Do 0.17)

- New `src/lib/productMasterRepairGuards.test.ts`: fails if a later migration undoes the KI-156, KI-158, KI-160, KI-161 or KI-162 fix (re-emits the function without it, or drops its trigger or index), or if the stock sweep and the browser stock check stop reading history types the same way (KI-159, `returned` is signed). Each case was shown failing with its fix undone locally, then passing. KI-157 is still open (Taha's lane), so it has none.
- The KI-159 stock-vs-history sweep (`stock-matches-history.sql`, PR #1897) ran read-only on production through `run-live.mjs`: PASS, 0 rows.
- Records: `20270119130000`, `20270121110000`, `20270125100000`, `20270126100000` and `20270126110000` are marked applied live (2026-11-21 with release #1990; live ledger re-read 2026-11-23). To-Do 0.17 and 2.10 updated; 2.10 lists 2 active products with a blank SKU for Mason (no data changed).
- `CURRENT_STATE.md` and `KNOWN_ISSUES.md` stamps moved to 2026-11-23 after re-reading the live ledger: latest row still `20261121061349`; the three `20261123*` migrations went live 2026-11-06.
