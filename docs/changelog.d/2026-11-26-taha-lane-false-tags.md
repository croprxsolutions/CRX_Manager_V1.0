## 2026-11-26 — Fewer false Taha-lane tags

Mason's answers to a survey of PRs the Taha-lane rule tagged since 2026-11-04, as changed by Taha's review of #2639:

- **#2381** (parent EPA): the customer year-end summary functions stay Taha's (they are a money statement); #2381 goes through on Mason's code.
- **#2267** (Piksi grams): a migration named for a product's units that also converts the product's own units in `public.products` may lock tables and UPDATE only the unit columns (`unit_size`, `rate_unit`) of order and quote lines, scoped by a WHERE. A line quantity, a price or any other change to those tables still counts, and so does every other lane table and function. An honest-mistake net, accepted by Mason.
- **#2451** (office menu): a change to one of Taha's screens that only edits words people read no longer counts. Words are JSX text, comments, label-like JSX attributes (`label="…"`) and the labels of menu and tab entries (a `path`, `to`, `href` or `key` on the same line); any other `label: '…'` in an object is code, since the app may save it. Money screens and customer documents (`src/components/invoices/`, `src/lib/invoice*`, `src/lib/statement*`, `*Pdf.ts`, `*Email.ts`) get no words-only pass. Its A/R tab move and redirect are code, so that PR would still be tagged.
- **Delivery completion** stays Taha's.
- **The `taha-ready` bot** no longer labels or pings Taha for a PR whose only lane files are the lane block's launchers and settings; a change to `taha-lane-lib.mjs` (what his lane is) still goes to him, and back-merges of `main` are judged like any PR. Mason's code is still needed to merge them.
- The PR file list now carries patches only for app code files, and the Codex merge gate reads `gh` output up to 16 MiB, so a large PR is not refused as unreadable.
