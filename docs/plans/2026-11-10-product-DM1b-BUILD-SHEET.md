# DM-1b build sheet: Ingredients and Weights tabs on the setup workbook

Source: Stage 2 sheet §7.5 (`docs/plans/2026-11-04-product-stage2-BUILD-SHEET.md`), grand plan §5 and §6 DM-1b. This sheet fixes the details §7.5 leaves open and records where it narrows §7.5, with the reason. Checked against current `main` (`69774ac6e`) and the live database (read-only, 2026-11-10).

## 1. What exists (live)

| Piece | Where | DM-1b uses it as |
|---|---|---|
| `_save_parent_density_draft`, `_save_size_net_weight_draft` | DM-2 `20261207100000` | the only Weights-tab writers. They check form, range, unit, trust order (lower trust needs reason + evidence) and the version **under lock**, and save a `draft` |
| `_lock_parent_chemistry`, `_apply_parent_chemistry` | DM-1 `20261209100000`, `20261211100000` | the only chemistry writer, called at promotion. It runs the EPA gate (`_parent_chemistry_epa_refusal`) for `set` and `correct` |
| `_parent_chemistry_epa_refusal` | DM-1 | the D-Z gate. DM-4 re-issues it to excuse a number whose lookup failed (DM-4 sheet §4.F). DM-1b only calls it, so DM-4's re-issue gives DM-1b the reviewed manual path with no DM-1b change |
| `preview_parent_chemistry_correction` | DM-1 | the pattern for an exact preview: rehearse the real write in a subtransaction that is always rolled back |
| `_product_parent_require_admin`, `_product_parent_replay`, `save_idempotency` | PAR-1 | admin check and retry key |
| `get_product_setup_workbook`, `ProductSetupWorkbookModal` | WP-PM-11a-2 | the workbook the two tabs join |

DM-4's tables (`epa_lookups`, `epa_lookup_failures`, `epa_chemistry_proposals`) do not exist yet. DM-1b does not depend on them.

## 2. Database PR: `20270103100000_setup_workbook_chemistry_tabs.sql`

**Table `chemistry_change_proposals`** (RLS on; SELECT for admins only; no write grant). One row per parent per upload: `parent_id`, `items` (the change list, in `_apply_parent_chemistry`'s shape, each with its source and source note), `has_delete`, `base_chemistry_version`, `proposal_version`, `status` (`proposed`, `applied`, `rejected`), `created_by/at`, `decided_by/at`, `applied_chemistry_version`.

**Functions** (all admin; `SECURITY DEFINER`, `search_path = public, pg_temp`; writers take a retry key):

- `get_setup_workbook_chemistry()`: the download. Weights: every active liquid parent (version, approved and draft lb/gal with source) and every active dry size stocked in a count unit (version, approved and draft net lb). Ingredients: every active parent with its `chemistry_version`, its EPA refusal (if any) and its active ingredient rows.
- `preview_weights_tab(p_rows)` / `commit_weights_tab(p_rows, p_idempotency_key)`. A row is `{kind: density|net_weight, subject_id, expected_version, value, unit (density), source, source_note, reason, evidence}`. Preview says per row `unchanged`, `change`, `stale`, `invalid` (with DM-2's own refusal, from a rolled-back rehearsal) or `not_found`. Commit is all-or-nothing: any stale or invalid row refuses the whole save by name; each change saves through the DM-2 draft helper; returns the saved rows. A missing source is refused (DM-2's `PRODUCT_WEIGHT_BAD_SOURCE`).
- `preview_ingredients_tab(p_rows)` / `commit_ingredients_tab(p_rows, p_idempotency_key)`. A row is `{parent_id, expected_chemistry_version, row_id|null, delete, name, cas, strength_value, strength_unit, strength_basis, source, source_note}`. Per parent: blank `row_id` = add; a `row_id` with `delete` = retire (the `__delete` marker); a `row_id` whose values differ = change; equal = nothing. Absent rows change nothing (D-D). Each parent is `unchanged`, `proposal` (with its items), `stale` (its version moved, D-E), `refused` (EPA gate by name, D-Z) or `invalid` (the exact refusal from a rolled-back rehearsal of the apply). Commit refuses the whole upload if any parent is stale, refused or invalid; otherwise inserts one proposal per changed parent. **Nothing live changes at commit.**
- `promote_chemistry_proposal(p_proposal_id, p_expected_proposal_version, p_decision, p_idempotency_key)`: `apply`, `apply_delete` or `reject`. `apply_delete` is required for a proposal containing a delete and refused for any other. Refuses a moved proposal version, a decided proposal, and a base `chemistry_version` that is no longer current (`CHEMISTRY_STALE`). Apply goes through private `_apply_chemistry_proposal`: `_lock_parent_chemistry(parent, base)`, then `_apply_parent_chemistry` in `correct` mode for changes and retirements (reason names the proposal, evidence lists its cited sources), then `set` mode for adds. The EPA gate runs again inside `_apply_parent_chemistry`. A retirement keeps the row with its history.

## 3. Where this narrows §7.5, and why

1. **One proposal per parent per upload, not per row.** Every chemistry write moves the parent's `chemistry_version`, so with one proposal per row, promoting the first of Halex GT's three rows would make the other two stale. `apply_delete` is required for any proposal that contains a delete, which keeps §7.5's rule (a delete never applies without the explicit choice).
2. **No row fingerprint.** The parent's `chemistry_version` (and DM-2's density and net-weight versions) move on every write to any row, so the version alone proves the download is current. A second fingerprint would check the same thing.
3. **No EPA-number snapshot on the proposal.** The gate is re-run at promotion, under the parent lock, by the same helper DM-4 re-issues; a snapshot taken at upload would never decide anything.
4. **Ingredient rows only.** Modes of action and fertilizer analysis stay on the product page (DM-1's screens). The Done-when list names only ingredient rows.
5. **A source note (the document) is required on every added or changed ingredient row** ("each value citing its source document"). Weights keep DM-2's rule: source required, note optional.

## 4. Screen PR

Two new tabs on the setup workbook download, `Weights` and `Ingredients`, each previewed and confirmed on its own like the existing tabs. A third panel lists open proposals with Apply / Apply delete / Reject. The download's manifest version moves to `crx-product-setup-v3`; a v2 file still loads its Setup, Rates and Parent Rates tabs (the new tabs are optional in an upload).

## 5. Done when (grand plan §6 DM-1b), each a named case in `scripts/smoke/prove-setup-workbook-chemistry-tabs-real-schema.mjs`

Halex GT (invented, no EPA number) takes three rows; a Weights upload of 20 liquids and 5 dry bags saves as drafts after the preview, each with its source, and a missing source is refused; an Ingredients upload lands as proposals citing their sources; an absent row changes nothing and a `__delete` row creates a delete proposal that applies only with `apply_delete`; a stale row and a stale proposal are refused; a product with a usable EPA number has its workbook chemistry refused by name; one retry key writes once; a non-admin is refused everywhere.

## 6. Gates

Sol list: yes (`supabase/`). Mason-gated: the live apply (non-destructive: one new table, new functions, grants only on new objects), and review of uploaded values before they are approved or promoted.

## 7. NEEDS MASON - DECISION (defaults chosen; reversible)

- Should a reject need a written reason? Default: no (one admin, low volume).
- Should a new upload for a parent that already has an open proposal replace the old one? Default: no; both stay open, and promoting one makes the other stale, which is then rejected.
