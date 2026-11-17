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

## 2026-11-17 - RT-3: Mason's first rate review saved on live

Mason decided by rule in chat (2026-11-17): approve today's per-acre rate as the default where it matches
the label text or there is no per-acre text (303); treat loose notes such as "1-2pt" or "1qt-2qt" as per
acre and approve today's rate (about 55); seed treatments get no per-acre default ("most are pure unit i
think no defaults"); per-ton and per-gallon products wait for label data; fix two unit errors (Piksi Dust
Plus 18 mg → 18 g, Smart Choice 15G 1.8 dry oz → 1.8 lb).

Saved through `commit_rate_review` from Mason's admin login (key `rt3-review-2026-11-17-batch1`) after a
clean `preview_rate_review` (684 rate rows and 382 outcomes, no problems; every label check `not_checked`,
because no label maximum is loaded for these products yet). Result on live:
- 670 rates approved, 30 still drafts; 14 seed-treatment per-acre drafts deleted (logged with the reason).
- Outcomes on active parents: `approved_default` 361, `no_per_acre_default` 14, `needs_label_data` 7,
  undecided 14.
- Unchanged: `products` and `product_parents` md5 as before; quotes and invoices untouched.

Held for Mason (undecided, drafts kept): Authority Maxx, Authority XL, Capture LFR and its two generics,
Gen Harmony SG, Gen Paraquat, Revulin Q and Vector (today's rate differs from the label text); Verdict
(beans and corn rates in one note); PeKacid (4 oz against "1-5lb"); Piksi Dust Infurrow ("1.5 gram per G");
Autumn Super 51 WDG and Cimarron Plus (label text only, no house rate). Quotes still read the old product
rate columns until RT-4.
