## 2026-11-17 - RT-1: draft product rates derived on live

Mason approved the run in its own session (chat, 2026-11-17: "Yes, run it"). It is a data step, not a
migration: `derive_draft_product_rates` (migration `20261229110000_product_rates_draft`, already live) was
called once from Mason's admin login in the app, for all 413 active product parents, idempotency key
`rt1-derive-2026-11-17-batch1`, about 17:46 UTC. The live-data guard refuses the RPC through `execute_sql`,
so there was no rolled-back dry run; a read-only input count came first.

Result (RPC totals): 413 parents, 396 derived, 17 nothing to derive (no rate), 0 skipped (no sizes disagree,
none had rows), 714 draft rows, 181 notes.

| Rows | Count |
|---|---|
| House rate, per acre, proposed quoting default | 314 |
| House rate, per acre, not default (basis doubt, `basis_confirmed = false`) | 80 |
| Label text, per acre | 293 |
| Label text, per 100 gal | 20 |
| Label text, per seed unit | 7 |

Notes: `basis_suspect` 80, `text_unparsed` 69, `no_rate` 17, `unit_not_for_form` 8, `basis_from_text` 7.
The build sheet guessed 15 to 20 non-default house rows; it is 80, because any suggested-rate text that does
not read as per acre or per 100 gal (for example Atrazine 4L's "32 fl") marks the house row as a doubt.
Mason sees each one in the rate review workbook.

Before/after check (read-only SQL): `product_rates` 0 → 714 (all `draft`), events 0 → 895, every event
by Mason's profile. Unchanged: md5 of every `products`, `product_parents` and `product_parent_members` row;
quotes (7) and invoices (19) with the same latest update times. Spot checks match the source values and the
build sheet's worked examples: MSO XL, Ilevo Seed Treatment (both forms), Dual Magnum, Roundup 5.4# (both).

KI-114 as predicted: `Piksi Dust Plus` has an `18 mg` per-acre house draft proposed as the default beside an
`18 g` label draft; RT-3 must fix it before approving.

Nothing reads the drafts until RT-4. Undo: `delete_draft_product_rate` per row (logged). This PR targets
`staging` only.
