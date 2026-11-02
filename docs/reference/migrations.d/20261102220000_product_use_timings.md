**LOCAL CANDIDATE — NOT APPLIED.** `20261102220000_product_use_timings.sql` (LF SQL sha256: `126590933406efffb4a7955c4b6b6e3dff5b1d6d6bc4dddaeedcd78c624ce0f2`). Mason-gated: this adds column grants to the existing products table. It adds option codes and a list of product use timings, backfills existing labels, and keeps the old text column synchronized for legacy readers and the pricing workbook.

Rollback drops the synchronization trigger and function, the list column, and the options table. The old text column retains its last joined labels.
