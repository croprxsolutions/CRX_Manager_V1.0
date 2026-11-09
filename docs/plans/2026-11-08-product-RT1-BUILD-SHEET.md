# Product Master Stage 4: RT-1 build sheet (the `product_rates` table, filled as an unapproved draft)

**Status (2026-11-08):** this is a plan only. No code and no migration have been written. It was written on 2026-11-08 against `main` (`4504e3e6a`) and the live database, using read-only SQL only. For building, this sheet replaces the RT-1 outline in `docs/plans/2026-10-29-product-GRAND-PLAN.md` Stage 4. Where the two differ, this sheet wins, and section 2 lists each difference. A reference like "overlap 11" points to the grand plan's section 4.

**Why this package is careful.** Stage 4 is the highest-risk stage: a wrong rate puts a wrong quantity on a customer's quote, job or applicator sheet. RT-1 is the safe first step. It builds the new rate table and fills it with **drafts** that nothing in the app reads. **It changes no reader and no old rate column.** Every quote, job, field-app screen and PDF keeps reading `products.rate_per_acre` and `products.rate_unit` exactly as today. Drafts become live only in RT-4, after Mason's review (RT-3).

**Cannot run its data step yet.** The RT-1 database PR can be built now. Filling the drafts needs parent records, and live has **0** (PAR-2's grouping is a Mason-gated data step that has not run). Section 9 has the full order.

**Words used here.**
- **Parent:** a `product_parents` row: one formulation, with each size as a member (`product_parent_members`). House rates belong to the parent (overlap 13), so every rate row belongs to a parent, never to a size.
- **Rate row:** one `product_rates` row: a basis, a source, low / recommended / high values and one unit.
- **Basis:** what the rate is measured against: per acre, per 100 gallons of spray, per each, per hundredweight (cwt) of seed, or per seed unit.
- **Source:** `label` (what the product label says) or `house_standard` (what Crop RX quotes by default).
- **Draft:** a row Mason has not approved. Drafts are used nowhere. RT-3 adds approval; RT-4 makes approved rows live.
- **Quoting default:** the one per-acre row a new quote line auto-fills from, after RT-4. RT-1 only stores and guards the flag.
- **Derivation:** the one-off step that turns today's parent values into draft rows (section 5).
- **Kind:** volume, weight or each. Every rate unit has exactly one kind.

---

## 1. Facts this plan is built on (checked 2026-11-08)

**Live data (counts only; products are rows, not parents):**

| Fact | Value |
|---|---|
| Products (active / all) | 596 / 604 |
| Active forms | liquid 505, dry 83, each 8, seed 0 |
| Active products with `rate_per_acre` set | 569; every one has a non-blank `rate_unit`, and every unit is listed in `unit_conversions` |
| Active rate units by form | liquid `oz` 482, liquid `qt` 1, dry `Dry oz` 74, dry `MG` 2, dry `oz` 2, dry `LB` 1, each `Unit` 6, each `Ea` 1 |
| Rows with `rate_per_acre = 0` | 0 |
| Active products with `suggested_rate` text | 567 |
| …of which mention "100 gal" | 34 (the grand plan's August figure was 37) |
| Active products with `max_label_rate` set | 0 |
| `product_parents` / `product_parent_members` | 0 / 0 (PAR-1 and PAR-2 database parts are live; no group approved yet) |
| `product_parent_proposals` / groups | 0 / 0 |
| `epa_registrations` rows | 0 (REG-1 step 1 live, not seeded) |
| `product_rate_lock.is_locked` | false (WP-PM-11a-1 live, lock off) |
| `product_rate_events` rows | 0 |
| `product_rates` table | does not exist |
| Latest live migration | `20261217100000_job_access_ends_with_the_job` (re-checked 2026-11-09; this repo's migration stamps run ahead of the calendar by convention; the stamp orders files, it is not the apply date) |

**MSO XL today:** two sizes, `MSO XL - 2.5 Gal` and `MSO XL - Bulk`, both liquid, stock unit `Gal`, `rate_per_acre = 9.6`, `rate_unit = 'oz'`, `suggested_rate = '2 qt/100 Gal'`, no label maximum. Note 2 qt/100 gal at a 15 gal/acre spray volume is exactly 9.6 fl oz/acre (64 × 15 / 100).

**Shapes of today's `suggested_rate` text (active rows):**

| Shape | Liquid | Dry | Each | Example |
|---|---|---|---|---|
| One number per acre | 191 | 36 | 0 | `0.5 oz/acre`, `1 lb/acre` |
| Range per acre | 140 | 11 | 0 | `1-2 pt/acre` |
| Per 100 gal | 28 | 6 | 0 | `1 Gal/100 Gal`, `17 lb/100 Gal` |
| Per seed unit (`/unit`) | 9 | 0 | 6 | `1.18 oz/unit` (all Seed Treatment) |
| Other range (no "/acre") | 61 | 14 | 0 | `.25-1gpa`, `1-3lb` |
| Other single | 48 | 11 | 2 | `1.5 qt/ton`, `0.64 oz/gal`, `0.3 oz-0.5 oz/acre` |
| Free text | 4 | 0 | 0 | `Beans 5 oz/acre -- Corn 14oz/acre` |

**Data problems found (RT-1 copies them faithfully and reports them; it fixes none):**
- **Seed treatments:** for the 9 liquid seed treatments with `/unit` text, `rate_per_acre` holds the per-seed-unit number (Ilevo 2.5 Gal: `1.18 oz` "per acre", text `1.18 oz/unit`). Today a quote multiplies it by acres.
- **Liquid unit on a dry product:** `Autumn Super 51 WDG` and `Cimarron Plus - 10 oz` are dry with `rate_unit = 'oz'` (a liquid unit in `unit_conversions`).
- **Milligrams:** the two `Piksi Dust` products store `MG` while their text says grams (`18 grams per Acre`, `rate_per_acre = 18`, unit `MG`).
- **Per ton / per gallon:** `BW-NLockDown` (`1.5 qt/ton`), `NanoCote Core` (`2-3 qt/ton`), `Tempo SC Ultra` (`0.5 oz/gal`, each form) have no RT-1 basis.

**Code and live functions RT-1 relies on (checked with `pg_get_functiondef` and source):**

| Thing | Where | What RT-1 relies on |
|---|---|---|
| The factor-1 fallback (the reason for the unit rules) | `src/lib/quoteCalc.ts:77-86` `getConversionFactor`; live `_save_quote_below_cost_impl_20260810` (`COALESCE(rate_conv.factor_oz, 1)`); live `product_price_per_acre` (`… LIMIT 1`) | A blank or unlisted unit silently becomes 1 oz. RT-1 never calls these and never changes them. Its own unit table has no fallback. |
| `unit_conversions` | live, 14 rows | Factors RT-1's unit table must match (postflight check, section 4.G; weight units match after dividing RT-1's milligram factor by 28349.523125 and rounding to the `unit_conversions` factor's own decimals): `fl oz`, `oz`, `Oz` = 1; `Pt` = 16; `qt`, `Qt` = 32; `Gal` = 128; `Dry oz` = 1; `Lb`, `LB` = 16; `g` = 0.03527396; `MG` = 0.00003527396; `Ea`, `Unit` = 1. |
| `_unit_factor_oz(unit, unit_type)` | live | Returns null for an unknown or ambiguous unit (no fallback). RT-1 does not use it, because its own table is the authority, but it is the model. |
| `normalize_rate_unit(text)` | live (`20260630170000`) | Strips a per-acre denominator (`/ac`, `/acre`, `/acres`, `/a`, ` per acre`; `20260630170000` lines 58-61); maps spellings to `oz`, `pt`, `qt`, `gal`, `lb`, `g`, `kg`, `l`, `ml`, `ton`; keeps any other `/…` string whole. RT-1's label-maximum parser uses it only to name the base unit after RT-1 has split off the denominator itself (section 3.5). |
| Rate readers | `src/` | `rate_per_acre` appears in 122 files; 53 outside tests and `src/types/`. (The grand plan's "93 / 42" was the 2026-10-29 count.) `rate_unit` appears in 118 files. RT-1 touches none of them. |
| Rate lock | `20261107060000_product_rate_lock.sql`; triggers `trg_a_share_product_rate_lock`, `trigger_zzz_guard_product_rate_lock`; `set_product_rate_lock`, `correct_product_rates` | Locks **live** rates only (the `products` columns, and after PAR-1 the parent columns). Drafts are outside it (overlap 11). |
| Parent rate columns | `product_parents.rate_per_acre`, `rate_unit`, `suggested_rate`; written only by `_apply_parent_rates` (through `set_parent_rates` / `correct_parent_rates`), which copies them to every member size | The derivation reads the **parent's** columns and checks the sizes agree (section 5). |
| Parent helpers | `_product_parent_require_admin()`, `_product_parent_replay(key, scope, fp)`, `save_idempotency` | The admin check and replay pattern every RT-1 RPC uses. |
| REG-1 lock pair | `20261210100000`: `pg_advisory_xact_lock(20261210, hashtext('crx_epa_registration'))` | RT-1 takes it **shared** before reading label maximums. |
| Label maximum | `epa_registrations.max_label_rate numeric`, `max_label_rate_unit text` (≤ 40 characters, both or neither) | Free-text unit; 0 rows today. After REG-1 step 2, size copies of `products.max_label_rate` are mirrors of the registration. |
| Parent number places | `_parent_chemistry_epa_refusal` (`20261209100000:534`) | The four places a parent's EPA numbers live: parent generic number, member sizes, active parent brands, legacy `product_brands` on member sizes. RT-1's label check reads the same four. |
| Client label check | `src/lib/labelGuardrails.ts:117` `compareToMaxRate` | Treats a bare max unit as per acre and returns `cannot_compare` when units differ. RT-1's database check follows the same reading (section 3.5). |

---

## 2. Where the grand plan's RT-1 outline is wrong or silent against current code

| Grand plan says | Current code / this sheet |
|---|---|
| "93 rate readers" | 122 files mention `rate_per_acre`; 53 outside tests and types. RT-1 changes none, so the number only matters to RT-4, which re-counts. |
| "37 per-100-gal rows" | 34 active rows mention "100 gal" today. RT-3 re-counts at review. |
| Basis list "per acre, per 100 gal, per unit, per cwt of seed, per seed unit" | Kept, as five codes: `per_acre`, `per_100_gal`, `per_unit`, `per_cwt_seed`, `per_seed_unit`. `per_unit` means **per each** (August D-G); seed-treatment text `oz/unit` means `per_seed_unit`. |
| Units checked against `unit_conversions` | RT-1 has **its own unit table** (`product_rate_units`, section 3.2) with one spelling per unit and a fixed kind and factor. It never joins `unit_conversions` at run time, so RT-2's spelling clean-up cannot change what a rate row means, and there is no case-variant ambiguity (`qt`/`Qt`, `Lb`/`LB`). A postflight check proves every factor equals today's `unit_conversions` factor. |
| "Every place the rate is used shows an above-label warning" | That is a **reader** change, so it belongs to RT-4 (when the rows go live). RT-1 stores the reason and supplies the check function (section 3.5) that RT-4's readers will call. |
| Derive draft rows "from today's values" | Today's values are copied onto the parent by PAR-2 grouping, and the parent is the key. So derivation reads `product_parents` rate columns, and runs only for grouped parents. Live has 0 parents, so the data step waits for PAR-2 grouping (section 9). |
| Silent on what happens to text the parser can't read | Unreadable text makes **no** row (a row needs a unit and a number); the parent gets a derivation note instead, kept in the events table for RT-3 (section 5). |
| Silent on seed treatments | Their `rate_per_acre` holds a per-seed-unit amount. The house draft is copied as it is, but **not** proposed as the quoting default, and is flagged (section 5, question 2). |

---

## 3. Shared design

### 3.1 Tables (all new; one migration)

**`product_rates`**
- `id uuid` PK, default `gen_random_uuid()`.
- `parent_id uuid NOT NULL` FK `product_parents(id)` (no cascade; parents are never deleted).
- `basis text NOT NULL` CHECK in (`per_acre`, `per_100_gal`, `per_unit`, `per_cwt_seed`, `per_seed_unit`).
- `source text NOT NULL` CHECK in (`label`, `house_standard`).
- `low numeric`, `recommended numeric`, `high numeric` (deliberately **unconstrained** `numeric`, because a `numeric(18,6)` column would round a seventh decimal on assignment before any check could see it), each `CHECK (x IS NULL OR (x >= 0 AND x < 1e12 AND x = round(x, 6)))` (WP-PM-8's rate ≥ 0, overlap 4). This is `_product_rate_value_ok`'s rule (12 digits, 6 decimals) enforced by the table itself, so any future writer that sends `1.1234567` is refused, never rounded.
- `unit text NOT NULL` FK `product_rate_units(code)`. So a blank or unknown unit cannot be stored at all.
- `is_quoting_default boolean NOT NULL DEFAULT false`.
- `status text NOT NULL DEFAULT 'draft'` CHECK in (`draft`, `approved`). RT-1 writes only `draft`; `approved` is there so RT-3 needs no constraint change. `approved_by uuid`, `approved_at timestamptz`, with `CHECK ((status = 'draft' AND approved_by IS NULL AND approved_at IS NULL) OR (status = 'approved' AND approved_by IS NOT NULL AND approved_at IS NOT NULL))`, so a draft can carry neither approval field and an approved row must carry both.
- `origin text NOT NULL` CHECK in (`derived_house`, `derived_text`, `manual`).
- `basis_confirmed boolean NOT NULL DEFAULT true`. False only on a derived house row with a basis doubt (section 5, `basis_suspect`). While false the label check never compares (3.5 step 4), so a per-seed-unit number stored as per acre can never read "within". A save through 4.A (an admin choosing the basis) sets it true; RT-3 must not approve a row while it is false.
- `source_text text` (≤ 200 characters): the exact text a derived row came from (`suggested_rate`, or `"<rate_per_acre> <rate_unit>"`), kept for RT-3 (grand plan RT-3: "its source text kept"). Derivation checks the length first: text longer than 200 characters makes no row and is noted `text_unparsed` (the note keeps the first 200 characters), so the limit can never fail a derivation write.
- `over_label_reason text` (≤ 500 characters, trimmed non-empty when present).
- `row_version bigint NOT NULL DEFAULT 1`, `created_by uuid NOT NULL`, `created_at timestamptz NOT NULL DEFAULT now()`, `updated_by uuid NOT NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`.

Constraints and indexes (these **are** the database rules; section 3.4 lists them in plain English):
- `CHECK (low IS NOT NULL OR recommended IS NOT NULL OR high IS NOT NULL)`.
- `CHECK (low IS NULL OR high IS NULL OR low <= high)`.
- `CHECK (recommended IS NULL OR low IS NULL OR low <= recommended)`.
- `CHECK (recommended IS NULL OR high IS NULL OR recommended <= high)`.
- `CHECK (NOT is_quoting_default OR basis = 'per_acre')`.
- `CHECK (NOT is_quoting_default OR recommended IS NOT NULL)` (a quote line needs one number).
- `UNIQUE (parent_id, source, basis)`. One label row and one house row per basis per parent. **Room for crops:** a later optional `crop` column widens this key and the default index to include it; nothing else changes (grand plan, "Per-crop rates stay parked").
- Unique partial index `uq_product_rates_one_default ON (parent_id) WHERE is_quoting_default`. Zero or one default per parent.
- **Unit fits basis and form:** an ordinary row trigger (`BEFORE INSERT OR UPDATE … FOR EACH ROW`, function `_product_rates_check_unit`; not a constraint trigger, because PostgreSQL allows those only `AFTER`) reads the parent's `product_form` and the unit's kind and refuses anything outside the section 3.3 table with `PRODUCT_RATE_UNIT_NOT_FOR_BASIS: <unit> is not allowed for <basis> on a <form> product`. (A CHECK cannot read another table, so this is a trigger; it also covers a direct write by a future definer function.)
- An update trigger sets `updated_at = now()` on every update (the RPCs also set `updated_by` and `row_version + 1`, so the version and the timestamp always move together), refuses changing `parent_id`, `origin` or `created_*`, and refuses any change to an `approved` row except by RT-3's future pass (RT-1 ships no such pass, so an approved row cannot change at all yet).

**`product_rate_units`** (reference data, seeded in the migration, never edited by the app)
- `code text` PK, `kind text NOT NULL` CHECK in (`volume`, `weight`, `each`), `factor numeric NOT NULL CHECK (factor > 0)`: fluid ounces per unit for volume, **milligrams** per unit for weight, 1 for each. Weight uses milligrams because every weight factor is then an exact, finite decimal (the avoirdupois ounce is defined as exactly 28.349523125 g); a grams-to-ounces factor would have to be cut short and could flip a borderline label check.
- `label text NOT NULL` (what screens show), `legacy_spellings text[] NOT NULL` (today's `rate_unit` spellings that mean this unit; used only by the derivation and, later, by RT-4's write-back).

| `code` | kind | factor | label | legacy spellings |
|---|---|---|---|---|
| `fl_oz` | volume | 1 | fl oz | `fl oz`, `oz`, `Oz` |
| `pt` | volume | 16 | pt | `Pt` |
| `qt` | volume | 32 | qt | `qt`, `Qt` |
| `gal` | volume | 128 | gal | `Gal` |
| `dry_oz` | weight | 28349.523125 | dry oz | `Dry oz` |
| `lb` | weight | 453592.37 | lb | `Lb`, `LB` |
| `g` | weight | 1000 | g | `g` |
| `mg` | weight | 1 | mg | `MG` |
| `each` | each | 1 | each | `Ea`, `Unit` |

`oz`/`Oz` map to fluid ounces, because `unit_conversions` lists them as liquid. A dry product whose rate unit is `oz` therefore fails the form check and is reported (section 5), never guessed.

**`product_rate_draft_events`** (append-only history of every draft change)
- `id bigint` identity PK, `parent_id uuid NOT NULL`, `rate_id uuid` (null for a derivation note with no row), `event_type text NOT NULL` CHECK in (`derived`, `derive_note`, `saved`, `deleted`), `before_values jsonb`, `after_values jsonb`, `note_code text` (section 5 codes), `reason text`, `changed_by uuid NOT NULL`, `changed_at timestamptz NOT NULL DEFAULT now()`.
- A trigger refuses `UPDATE` and `DELETE`.

### 3.2 Why a separate unit table

The grand plan's own reason for the unit rule is that the conversion helper treats an unknown unit as factor 1. A rate table that joined `unit_conversions` by spelling would inherit the same failure modes: case variants, duplicates, and RT-2 renaming rows underneath it. A small fixed table with a foreign key makes "blank or unknown unit" impossible to store, gives every unit exactly one kind and factor, and lets RT-1 and RT-2 land in either order (grand plan section 8, item 4). **RT-2 note:** RT-2 renames `products`/`unit_conversions` spellings; if it removes a spelling listed in `legacy_spellings`, it updates that array in the same migration and RT-2's harness proves the derivation map still covers every live `rate_unit`.

### 3.3 Allowed units per basis

The **kind** of unit must match the parent's form; the **basis** decides which forms may use it at all.

| Basis | liquid parent | dry parent | each parent | seed parent |
|---|---|---|---|---|
| `per_acre` | volume | weight | each | each or weight |
| `per_100_gal` (spray) | volume | weight | refused | refused |
| `per_unit` (per each) | volume | weight | each | each or weight |
| `per_cwt_seed` | volume | weight | refused | refused |
| `per_seed_unit` | volume | weight | each | refused |

Refused cells raise `PRODUCT_RATE_UNIT_NOT_FOR_BASIS`. A weight rate on a liquid product (or the reverse) is refused until density exists (DM-2) and a later package decides it.

**Conversion and rounding.**
- RT-1 **stores no converted value.** A row keeps the number and unit it was given.
- Conversions happen only inside the label check (3.5), within one kind: `value × factor` gives fluid ounces (volume) or milligrams (weight). Every factor is exact, so nothing is ever truncated. They are done in exact PostgreSQL `numeric` with no rounding at any step; "equal" is not "above".
- Values are entered with at most 6 decimals (the 3.1 scale CHECK); more decimals are refused (`PRODUCT_RATE_INVALID`, the existing `_product_rate_value_ok` rule), never rounded silently.
- Converting **between** bases (per 100 gal → per acre needs a spray volume; per cwt → per acre needs a seeding rate) is **not** done by RT-1. The examples below that cross a basis are only to show what the numbers mean.
- RT-4 note: when RT-4 fills the old columns from an approved default, it writes the row's own number and the unit's legacy spelling, so no rounding or factor ever enters a quote.

**Hand-worked examples (each becomes a harness case, section 6):**

| Basis | Example | Working | Result |
|---|---|---|---|
| `per_acre`, volume | 1.5 pt/acre against a label max of `24 oz/acre` | 1.5 × 16 = 24 fl oz; max 24 × 1 = 24 fl oz; 24 is not above 24 | within label |
| `per_acre`, volume | 1.6 pt/acre against the same max | 1.6 × 16 = 25.6 fl oz > 24 | above label: needs a reason |
| `per_acre`, volume | 0.25 gal/acre | 0.25 × 128 | 32 fl oz/acre |
| `per_acre`, weight | 18 g/acre | 18 × 1000 | 18000 mg/acre (about 0.635 dry oz) |
| `per_acre`, weight | 1 g/acre against a label max of `0.035273961 oz/acre` (dry) | 1 × 1000 = 1000 mg; max 0.035273961 × 28349.523125 = 999.999973079848125 mg; 1000 > 999.99997… | above label (a truncated g→oz factor would wrongly say within) |
| `per_acre`, weight | 6 mg/acre | 6 × 1 | 6 mg/acre (about 0.000212 dry oz) |
| `per_acre`, each | 1 each/acre (an each product) | factor 1 | 1 each/acre |
| `per_100_gal`, volume | MSO XL label 2 qt/100 gal | 2 × 32 | 64 fl oz per 100 gal. (Meaning only: at 15 gal/acre that is 64 × 15 / 100 = 9.6 fl oz/acre, MSO XL's house rate.) |
| `per_100_gal`, weight | 17 lb/100 gal | 17 × 453592.37 | 7711070.29 mg per 100 gal (exactly 272 dry oz) |
| `per_unit` | 2 fl oz per each | factor 1 | 2 fl oz per each |
| `per_cwt_seed` | 1.5 fl oz/cwt | factor 1 | 1.5 fl oz per 100 lb of seed. (Meaning only: 2,000 lb of seed is 20 cwt, so 30 fl oz.) |
| `per_seed_unit` | Ilevo label 1.18 fl oz per seed unit | factor 1 | 1.18 fl oz per seed unit. (Meaning only: 40 units take 47.2 fl oz = 0.36875 gal.) |

### 3.4 Database rules (plain English)

| Rule | Enforced by | Refusal |
|---|---|---|
| Zero or one per-acre quoting default per parent | Unique partial index | `PRODUCT_RATE_DEFAULT_EXISTS: <parent> already has a quoting default; clear it first` (the RPC checks first and names the existing row; the index is the backstop) |
| A non-acre default is refused | CHECK | `PRODUCT_RATE_DEFAULT_NOT_PER_ACRE` |
| A default needs a recommended value | CHECK | `PRODUCT_RATE_DEFAULT_NEEDS_RECOMMENDED` |
| A blank or unknown unit is refused | `unit NOT NULL` + FK to `product_rate_units` | `PRODUCT_RATE_UNIT_UNKNOWN: <text> is not a rate unit` (the RPC trims and checks first) |
| A unit that does not fit its basis or the parent's form is refused | `_product_rates_check_unit` trigger | `PRODUCT_RATE_UNIT_NOT_FOR_BASIS` |
| Low ≤ recommended ≤ high, at least one value, none negative | CHECKs | `PRODUCT_RATE_RANGE_INVALID` |
| One label and one house row per basis per parent | UNIQUE | `PRODUCT_RATE_DUPLICATE` |
| A house rate above the label maximum warns, never blocks | RPC (3.5) | Saving it without a reason: `PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED: <value unit> is above the label maximum <max> on EPA <number>; give a reason to save it`. With a reason it saves, and the result carries the warning. |
| Unknown or non-comparable label maximum | Check function (3.5) | Never refused; the row reads `label maximum not checked`, with why |
| Approved rows are not edited by RT-1 | Update trigger and RPCs | `PRODUCT_RATE_APPROVED: send it back to draft first` (RT-3 builds that) |

The named refusals are raised by the RPCs before the constraint would fire, so the screen and workbook (RT-3) get a readable message. The constraints stay, so any future writer is held to the same rules.

### 3.5 The label-maximum check

`_product_rate_label_check(p_rate_id uuid) RETURNS jsonb` (internal, no grant) and the same logic on proposed values inside the save RPC. It applies to `house_standard` rows only; a `label` row returns `{status: 'not_applicable'}`.

1. Take the REG-1 advisory pair **shared**.
2. Collect the parent's EPA numbers from the four places `_parent_chemistry_epa_refusal` reads (trimmed, non-blank, distinct).
3. If none, or REG-1's seed function is missing or reports unseeded (`to_regprocedure('public._epa_registrations_seeded()')` is null, or it returns false), return `{status: 'not_checked', why: 'no_registration' | 'registrations_not_seeded'}`.
4. For each number, read `epa_registrations.max_label_rate` and `max_label_rate_unit`. A maximum is **comparable** only when:
   - `basis_confirmed` is true (otherwise the result is `not_checked`, why `basis_unconfirmed`);
   - the max unit's **denominator**, read with the same strict grammar as section 5 Row 2 (`/acre`, `/acres`, `/ac`, `/a`, `per acre` or no denominator → `per_acre`, a bare unit being read as per acre as `compareToMaxRate` does; `/100 gal` → `per_100_gal`; `/cwt` → `per_cwt_seed`; `/unit` → `per_seed_unit`), gives **the row's own basis**. A different basis is never converted (that would need a spray volume or seeding rate), so `3 qt/100 gal` is compared with a `2 qt/100 gal` maximum but not with a per-acre one;
   - the base unit left after the denominator, named through `normalize_rate_unit`, maps to a `product_rate_units` code of the row's kind (`oz` → `fl_oz` for liquid, `dry_oz` for dry; `pt`, `qt`, `gal`, `lb`, `g`, and `mg` map directly; anything else, such as `kg`, `l`, `ml` or `ton`, is not comparable). `per_unit` rows have no label-maximum form and are always `not_checked` (`why: basis_has_no_label_max`).
5. The highest value on the row is `greatest(low, recommended, high)` (nulls ignored). Compare `highest × row factor` with `max × max factor` in exact numeric.
6. Result:
   - **`above`** if any comparable maximum is exceeded. It lists each exceeded registration with its max. `reason_missing: true` when the row has no `over_label_reason` (possible if a maximum was lowered after the save, or on a derived row, see 4.C; RT-3 must not approve such a row).
   - Else **`not_checked`** if any linked registration has no maximum or a non-comparable one, with which and why.
   - Else **`within`**.

Warn if above **any** linked registration (question 3).

### 3.6 Locking

Every RT-1 function that writes rate rows locks in this order, matching DM-1/DM-4 (parent first) and REG-1 (advisory first):
1. REG-1 advisory pair, shared (only `save_draft_product_rate` and `derive_draft_product_rates`, which run the label check);
2. the parent `FOR UPDATE`;
3. member sizes `FOR SHARE` in ID order (derivation only, to read their rate columns);
4. the parent's `product_rates` rows `FOR UPDATE`;
5. the events insert.

RT-1 never reads or takes `product_rate_lock`: drafts stay editable while the lock is on (overlap 11). It never bumps `product_parents.parent_version`, because a draft does not change the parent and a bump would make open setup workbooks stale for nothing.

### 3.7 RLS, grants and RPC conventions

Tables:
- RLS on all three.
- `product_rates` and `product_rate_draft_events`: one `SELECT` policy for admins, `TO authenticated USING ((SELECT public.is_admin()))`. Drafts are used nowhere, so no one else needs them; RT-4 re-decides read access when rows go live.
- `product_rate_units`: one `SELECT` policy `TO authenticated USING (true)` (reference data, nothing private).
- `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role, metabase_ro`, then `GRANT SELECT … TO authenticated`. No insert, update or delete grant to any client role.

Functions:
- `SECURITY DEFINER`, owned by `postgres`, `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC, anon, authenticated, service_role, metabase_ro`.
- `GRANT EXECUTE … TO authenticated` on the four browser RPCs (section 4); none on the helpers and triggers.
- The first statement of every browser RPC is `v_actor := public._product_parent_require_admin();`. The actor is always `v_actor`, never a parameter.

Every mutating RPC:
- takes `p_idempotency_key text DEFAULT NULL` and refuses a missing key (`IDEMPOTENCY_KEY_REQUIRED`);
- calls `_product_parent_replay(p_idempotency_key, '<rpc name>', v_fp)` before any other lock. The helper itself first takes `pg_advisory_xact_lock(hashtext('crx.product_parent:' || scope || ':' || key))` (`20261108120000_product_parents.sql:499`), so two requests with the same key run one after the other and the second finds the first's receipt; no extra key lock is needed, where `v_fp` is the md5 of a jsonb of every argument plus `actor_id`;
- ends with `save_idempotency(p_idempotency_key, '<rpc name>', jsonb_build_object('actor_id', v_actor, 'request_fingerprint', v_fp, 'response', v_result))` and then `RETURN v_result` (unwrapped). The envelope is required: `_product_parent_replay` compares `actor_id` and `request_fingerprint` and returns `response` (`20261108120000_product_parents.sql:502-506`), and `save_idempotency` stores its argument unchanged. This matches `create_product_with_parent` (same file, lines 797-800). Saving `v_result` bare would make every identical retry fail `IDEMPOTENCY_PAYLOAD_MISMATCH` instead of replaying; R16 proves the replay.

---

## 4. RT-1 DB · The database PR

**File:** `supabase/migrations/<stamp>_product_rates_draft.sql`. The stamp is chosen at build. It must sort after `20261217100000` (latest live on 2026-11-09; re-check `supabase_migrations` at build) and after any stamp claimed in `docs/changelog.d/` or the sibling notes folder.

**Preflight block:** refuse to run unless `product_parents`, `product_parent_members`, `_product_parent_require_admin`, `_product_parent_replay`, `normalize_rate_unit` and `epa_registrations` exist, and every `unit_conversions` factor named in section 1 is as listed.

### 4.A `save_draft_product_rate(p_parent_id uuid, p_rate_id uuid, p_expected_row_version bigint, p_basis text, p_source text, p_low numeric, p_recommended numeric, p_high numeric, p_unit text, p_is_quoting_default boolean, p_over_label_reason text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

Inserts a draft (`p_rate_id` null) or edits one.
1. Admin check, key check, replay (scope `save_draft_product_rate`).
2. Check shapes: basis and source in their lists; each value null or a number ≥ 0, below 1e12, with at most 6 decimals (the 3.1 CHECK's exact rule, tested before any write so the caller gets `PRODUCT_RATE_INVALID`, never a raw constraint error); unit trimmed and present in `product_rate_units` (`PRODUCT_RATE_UNIT_UNKNOWN`); reason trimmed, ≤ 500.
3. Lock (3.6). Parent missing or inactive: `PARENT_NOT_FOUND`.
4. On edit: the row must belong to `p_parent_id` (`PRODUCT_RATE_NOT_FOUND`), be `draft` (`PRODUCT_RATE_APPROVED`) and match `p_expected_row_version` (`PRODUCT_RATE_STALE`).
5. Run the section 3.4 checks in table order and raise the named refusal for the first that fails.
6. Label check on the proposed values (3.5). `above` with no reason: refuse `PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED`. A reason given while not `above` is kept (it does no harm, and a maximum may be added later).
7. Write the row (`row_version + 1` on edit; `origin` stays as it was, `manual` on insert), and one `saved` event with before and after values.
8. Return `{rate_id, row_version, label_check}`.

### 4.B `delete_draft_product_rate(p_rate_id uuid, p_expected_row_version bigint, p_reason text, p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

For a wrongly derived row (wrong basis, wrong source). Admin, key, replay. Reason 1–500 characters (`PRODUCT_RATE_REASON_REQUIRED`). Lock the parent then the row. Refuse `PRODUCT_RATE_APPROVED` and `PRODUCT_RATE_STALE`. Delete the row and write a `deleted` event with its before values. Return `{rate_id, deleted: true}`.

### 4.C `derive_draft_product_rates(p_parent_ids uuid[], p_idempotency_key text DEFAULT NULL) RETURNS jsonb`

Section 5 defines the rules. 1 to 500 distinct parent IDs per call (`PRODUCT_RATE_DERIVE_BATCH`). Parents are processed in ID order, each under the 3.6 locks. Returns, per parent, `{parent_id, outcome: 'derived' | 'skipped_has_rows' | 'skipped_sizes_disagree' | 'nothing_to_derive', rows: [...], notes: [...]}` plus totals. A re-run never changes an existing row: a parent that already has any `product_rates` row is skipped.

**Above label during derivation.** Derivation copies today's numbers and has no reason to give, so the reason rule of 4.A step 5 does not apply to it. A derived house row whose label check is `above` is still written, with `over_label_reason` null; the parent's report and a `derive_note` event carry note `above_label` with the exceeded registrations, and every later read shows `above` with `reason_missing: true`. It cannot become live: RT-3 must not approve it until an admin saves it through 4.A with a reason or a lower rate. Refusing the row instead would hide a real (if wrong) rate the business uses today, and failing the batch would let one product block 499 others.

### 4.D `get_parent_draft_rates(p_parent_id uuid) RETURNS jsonb` (read)

Admin. Returns the parent's rows, each with its unit label, kind, `row_version`, and `label_check` (3.5), plus the parent's derivation notes from the events table. RT-3's Rates tab reads through it. It writes nothing and takes no key.

### 4.E What the migration does **not** touch

- No `products` or `product_parents` column, trigger or function changes.
- No change to `unit_conversions`, `normalize_rate_unit`, `product_price_per_acre`, `save_quote`, the rate lock, or any reader.
- No live rows except the nine `product_rate_units` seed rows.
- The postflight block (4.G) proves each of these by name.

### 4.F Files

The PR checklist (Stage 2 sheet §3 rule 9):
- the migration, with preflight and postflight blocks;
- `docs/changelog.d/<date>-rt1-product-rates-draft.md` and the `migrations.d` ledger record;
- `src/types/index.ts`: `ProductRate`, `ProductRateUnit`, `ProductRateBasis`, `ProductRateSource`, `ProductRateLabelCheck`, and the four RPC result types (types only; no reader imports them yet);
- `docs/reference/rpc-functions.md` entries for the four RPCs;
- `.claude/schema-registry.json` refreshed (status, basis, source, origin and event-type values);
- the db-sweeps allowlist if a sweep flags the new SECURITY DEFINER functions;
- the harness `scripts/smoke/prove-product-rates-draft-real-schema.mjs` (section 6);
- `docs/manual/KNOWN_ISSUES.md`: the four data problems in section 1, each pointed at RT-3 (or RT-2 for spellings), unless they are already listed.

No other `src/` file changes. The PR description lists its file list against this one, so a reviewer can see no reader moved.

### 4.G Postflight checks (inside the migration)

- Every new table has RLS on, the policies named in 3.7, and exactly the grants named there (read from `information_schema.role_table_grants`).
- Every new function is owned by `postgres`, is `SECURITY DEFINER` with the stated `search_path`, and has `EXECUTE` only where 3.7 says.
- For every `product_rate_units` row and each of its `legacy_spellings`, `unit_conversions` has that exact spelling with the same factor (volume and each: equal exactly; weight: `round(factor / 28349.523125, scale(unit_conversions factor))` equals the `unit_conversions` factor, so `g` 1000 → 0.03527396 and `MG` 1 → 0.00003527396 match today's rows, and `Lb` 453592.37 → 16 exactly), and every distinct non-blank `products.rate_unit` spelling (all rows, active or not: today `oz`, `Dry oz`, `qt`, `Unit`, `MG`, `Lb`, `Gal`, `Ea`, `LB`, `Pt`) appears in exactly one `legacy_spellings` array. Blank and null units (5 rows today) are allowed; derivation notes them as `unit_unknown` only when the parent has a rate.
- The md5 of `pg_get_functiondef` for `product_price_per_acre`, `normalize_rate_unit`, `validate_product_units`, `guard_product_rate_lock` and `_apply_parent_rates` is unchanged from the preflight's reading in the same transaction.

### 4.H Risks

| Risk | Handling |
|---|---|
| A reader starts using drafts by accident | Admin-only SELECT; no reader file changes (file list); harness case R12 |
| The derivation guesses wrong | It never guesses a unit or a basis: unreadable text makes a note, not a row; seed treatments are not proposed as defaults; every row is a draft for Mason's review |
| A unit means something different later | Own unit table with fixed factors; postflight proves they equal today's; RT-2 must keep `legacy_spellings` in step |
| Lock inversion with PAR-1 or REG-1 writers | Advisory pair first, then parent, as both use; harness case R11 |
| An over-label rate saved silently | The save RPC needs a reason; the check is re-run on every read, so a later lowered maximum shows as `above` with `reason_missing` |

---

## 5. Deriving drafts from today's values

**Input:** the parent's own `rate_per_acre`, `rate_unit` and `suggested_rate` (PAR-1 copies them to every size). **Safety check first (form-aware):**
- Every member size must carry the parent's `rate_per_acre` (numeric equality) and `suggested_rate` (trimmed text).
- `rate_unit` depends on the form:
  - **liquid and dry parents:** each size's `rate_unit` must equal the parent's (trimmed).
  - **each and seed parents:** PAR-2 stores the parent's `rate_unit` as null (`20261123120000_product_parent_proposals.sql:851`), and `_copy_parent_to_size` gives each size its own `inventory_unit` as its rate unit (`20261108120000_product_parents.sql:653-656`). So each size's `rate_unit` must equal its own `inventory_unit` (trimmed), and the parent's null is expected, not a disagreement.
- A failure is `skipped_sizes_disagree` with no rows. The PAR-1 guard should make this impossible, so it is a bug signal, not a normal path.

**The house row's unit** (`house_unit`):
- **liquid and dry:** the parent's `rate_unit`.
- **each and seed:** the members' common stock unit. When every member's trimmed `inventory_unit` is the same spelling, that spelling is `house_unit`. When members stock in different units (for example `Ea` and `Unit`, or a seed sold in both bags and units), there is no house row. The note is `stock_units_differ`, listing each size and its unit, and the text row (Row 2) is still derived. Different spellings are never merged, even ones that map to the same code, because RT-3 should see the difference.

**Row 1 · the house row** (from `rate_per_acre` and `rate_unit`):
- Only when `rate_per_acre` is not null and `house_unit` was found.
- `source = 'house_standard'`, `basis = 'per_acre'`, `recommended = rate_per_acre`, low and high null, `origin = 'derived_house'`, `source_text = rate_per_acre || ' ' || house_unit`.
- Unit: the `product_rate_units` row whose `legacy_spellings` contains the exact `house_unit` (case-sensitive; trimmed). None: no row, note `unit_unknown`. Wrong kind for the form: no row, note `unit_not_for_form` (today: the two dry `oz` products).
- `is_quoting_default = true` **unless** a basis doubt exists, in which case false with note `basis_suspect`. A doubt exists when the parent's `suggested_rate` text is present and does **not** parse (Row 2) to `per_acre` or `per_100_gal`. That covers the seed treatments (`/unit`), the per-ton and per-gallon products, and any unreadable text. (MSO XL's text parses to `per_100_gal`, so its house row is proposed as the default.)

**Row 2 · the text row** (from `suggested_rate`):
- `source = 'label'` (question 1), `origin = 'derived_text'`, `source_text = suggested_rate` exactly.
- A strict parser, case-insensitive, after trimming and collapsing spaces. It reads only:
  - `NUM [UNIT] - NUM UNIT` or `NUM UNIT` (a range or one number; a unit after the low number must equal the one after the high number); `to` counts as `-`; a leading `.` is allowed (`.25`);
  - followed by a denominator: `/acre`, `/ac`, `/a`, `per acre` → `per_acre`; `/100 gal` → `per_100_gal`; `/cwt` → `per_cwt_seed`; `/unit` → `per_seed_unit` (all 15 such rows are seed treatments; note `basis_from_text`; the 6 each-form ones then fail the unit check below); or the suffix `gpa` with no unit → `gal` per acre.
  - Units: the legacy spellings, plus `fl oz`, `pint(s)`, `quart(s)`, `gallon(s)`, `lb(s)`, `pound(s)`, `gram(s)`, `dry oz`. `oz` means `fl_oz` on a liquid parent and `dry_oz` on a dry one (in text, unlike the stored unit, "oz" on a dry label means dry ounces).
- One number → `recommended`. A range → `low` and `high`, `recommended` null.
- **Value check before any write (both rows):** every number derivation would store must pass the 3.1 value rule (≥ 0, below 1e12, at most 6 decimals). One that fails (for example `1.1234567 oz/acre`) makes no row and is noted `value_invalid` with the text; nothing is rounded and the batch carries on. So no derived write can hit the CHECK.
- Anything else (`1.5 qt/ton`, `1-3lb`, `Beans 5 oz/acre -- Corn 14oz/acre`, `Spray on`, `2 products`): no row, note `text_unparsed` with the text. A unit that fails 3.3 for the parent's form (the each-form seed treatments' `oz/unit`): no row, note `unit_not_for_form`.
- Never a quoting default.

**Notes** are written as `derive_note` events (`note_code`, the text, and what was skipped), so RT-3 has the full list per parent. Note codes: `no_rate`, `unit_unknown`, `unit_not_for_form`, `basis_suspect`, `basis_from_text`, `text_unparsed`, `sizes_disagree`, `stock_units_differ`, `above_label`, `value_invalid`.

**What derivation never does:** change any `products` or `product_parents` value; overwrite or merge into an existing row; set a default other than the house per-acre row; convert between bases; touch the rate lock.

**MSO XL, worked:** parent values `9.6`, `oz`, `2 qt/100 Gal`, liquid.
- Text row: `2 qt/100 Gal` → one number 2, unit `qt`, denominator `/100 gal` → `label`, `per_100_gal`, `recommended 2`, `qt`.
- House row: `9.6 oz` → `oz` is in `fl_oz`'s spellings, volume fits liquid → `house_standard`, `per_acre`, `recommended 9.6`, `fl_oz`; the text parsed to `per_100_gal`, so no doubt → `is_quoting_default = true`.

**Ilevo Seed Treatment, worked:** parent values `1.18`, `oz`, `1.18 oz/unit`, liquid. Text row → `label`, `per_seed_unit`, `recommended 1.18`, `fl_oz`, note `basis_from_text`. House row → `house_standard`, `per_acre`, `1.18 fl_oz`, `is_quoting_default = false`, `basis_confirmed = false`, note `basis_suspect`; its label check is `not_checked` (`basis_unconfirmed`) even against a `1.18 oz/acre` maximum.

**Expected scale** (from the section 1 shapes; re-counted by the harness's dry run against a live snapshot before the real run): about 380 size rows' text parses per acre, 34 per 100 gal, 9 per seed unit (the 9 liquid seed treatments; the other 6 are each-form with `oz/unit`, which 3.3 refuses, so they are noted `unit_not_for_form`); about 140 size rows' text is unparsed or does not fit; roughly 15 to 20 house rows lose the default flag. Parent counts are lower, because sizes share a parent.

**Running it live** is a data change outside a migration, so it needs Mason's explicit yes in the session that runs it (AGENTS.md). It runs after PAR-2 grouping, in batches of at most 500 parents, through the RPC under an admin session, with each batch's returned report saved to the notes folder. A parent grouped later is derived later with the same call.

---

## 6. Done when (harness cases)

The harness is `scripts/smoke/prove-product-rates-draft-real-schema.mjs`, run against a real-schema container with the migration applied, fixture parents and sizes made through PAR-1's own RPCs, and fixture registrations where REG-1 allows. Each case calls the RPCs as an admin role and reads the rows afterwards.

| # | Case | Expect |
|---|---|---|
| R1 | **MSO XL** fixture (two sizes, values as live), derive | Exactly two drafts: `label`/`per_100_gal`/2/`qt`, and `house_standard`/`per_acre`/9.6/`fl_oz` as the default |
| R2 | A second default on the same parent | Refused `PRODUCT_RATE_DEFAULT_EXISTS`; first default unchanged |
| R3 | A default on a `per_100_gal` row | Refused `PRODUCT_RATE_DEFAULT_NOT_PER_ACRE` |
| R4 | Blank unit, `'  '`, `'oz '` with stray spaces trimmed (accepted), `'quartz'`, `'Qt'` (a legacy spelling, not a code) | Blank, spaces-only, `quartz` and `Qt` refused `PRODUCT_RATE_UNIT_UNKNOWN`; a direct insert with a bad unit fails the FK |
| R5 | Unit outside 3.3: `lb` on liquid, `fl_oz` on dry, `each` per 100 gal, `fl_oz` per seed unit on an each parent | Each refused `PRODUCT_RATE_UNIT_NOT_FOR_BASIS` |
| R6 | Ranges: low 2 / rec 1 / high 3; low 3 / high 2; all three null; −1; 1.1234567; 1000000000000; derive a parent whose text is `1.1234567 oz/acre` | Refused `PRODUCT_RATE_RANGE_INVALID` (first four) and `PRODUCT_RATE_INVALID` (next two); the derivation writes no text row, notes `value_invalid`, and finishes the batch; 1 ≤ 1 ≤ 1 accepted |
| R7 | Every hand-worked example in 3.3 | The label check and stored values match the table exactly, including "24 is not above 24" |
| R8 | Over label: house 1.6 pt/acre, registration max `24 oz/acre` | Without a reason refused `PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED`; with a reason saved, result `above`, reason stored |
| R9 | Max unknown, a per-acre row against max `2 qt/100 gal`, max `1 kg/acre`, no registration, REG-1 unseeded, a `per_unit` row | Each saves with no reason; check `not_checked` with the matching `why` |
| R9b | Same-basis maximums: house `3 qt/100 gal` against max `2 qt/100 gal`; house `1.6 pt/acre` against max `24 oz/ac` and `24 oz/a`; direct insert of `1.1234567` as `postgres` | First two refused `PRODUCT_RATE_ABOVE_LABEL_REASON_REQUIRED` without a reason; the insert fails the scale CHECK |
| R9c | Derive a parent whose house rate is above a seeded maximum | Row written with no reason, note `above_label`, read shows `above` + `reason_missing: true`; the rest of the batch derives normally |
| R10 | Lower the registration max after an R8-style save without an over-label row | Read shows `above`, `reason_missing: true` |
| R11 | Two sessions: a draft save and a REG-1 registration write (or `set_parent_rates`) on the same parent | One waits; no deadlock |
| R12 | **No reader changed:** before migration and derivation, snapshot every fixture product's and parent's rate columns, `product_price_per_acre` for every fixture product and tier, a fixture quote's saved lines, and the md5 of the five function bodies in 4.G | All identical after the migration, after derivation, and after every R-case |
| R13 | Rate lock on | Drafts save, edit, delete and derive normally; a live-rate write on the same parent is still refused `PRODUCT_RATES_LOCKED` |
| R14 | Seed treatment, each-form seed treatment, dry `oz` product, `1.5 qt/ton`, free text, sizes that disagree (forced past the guard in the fixture), a PAR-2-grouped each parent (parent `rate_unit` null, both sizes `Ea`), and an each parent whose sizes stock in `Ea` and `Unit` | Rows and notes exactly as section 5 says, including no default, `basis_suspect`, `basis_confirmed = false` and a `not_checked`/`basis_unconfirmed` label check against a per-acre max; a 4.A save of that row sets `basis_confirmed = true`; the grouped each parent derives a house row in `each` (not `skipped_sizes_disagree` or `unit_unknown`); the mixed-stock parent gets no house row, note `stock_units_differ`, and its text row still derives |
| R15 | Re-run derive on a derived parent | `skipped_has_rows`; no row or version changes |
| R16 | Grants and replay | Non-admin refused on all four RPCs; anon has no execute; a non-admin reads 0 rows from `product_rates` and the events table; the same key replays the same result; the same key with other arguments refuses `IDEMPOTENCY_PAYLOAD_MISMATCH` |
| R17 | Stale and approved | Wrong `p_expected_row_version` refused `PRODUCT_RATE_STALE`; a fixture row set to `approved` (as `postgres`) cannot be edited or deleted (`PRODUCT_RATE_APPROVED`) |
| R18 | Events | Every save, delete and derivation note has one event; update and delete on the events table are refused |

**Grand plan "Done when" mapping:** "MSO XL holds two draft rates" is R1. "A second default, a non-acre default, a blank or unknown unit and an inverted range are each refused" are R2, R3, R4 and R6. "Every quote, job and field-app screen shows exactly what it showed before" is R12 in the container, plus the live check below.

**Live check after the apply** (read-only, no data step needed): the three tables, nine unit rows, grants and function owners exist; 0 `product_rates` rows; the md5 of every `products` and `product_parents` rate column set is the same as just before the apply; and, in the browser pane, one existing quote, one job and one field-app chemical screen show the same rates and quantities as screenshots taken just before the apply. After the Mason-approved derivation run, the same md5 and screens are checked again.

---

## 7. PR split, Sol and gates

| # | PR or step | Files | Sol? | Gates |
|---|---|---|---|---|
| 1 | **This sheet** (docs only) | `docs/plans/2026-11-08-product-RT1-BUILD-SHEET.md` | No | Green checks; open 4 hours before merge |
| 2 | **RT-1 DB** | section 4.F | **Yes** (a migration; `docs/reference/sol-required-paths.md`) | Luna until clean, Sol before the PR opens, Taha's 4-hour hold, then the live apply through the migration-apply gate **before** merge |
| 3 | **Derivation run** (no PR) | none; the report goes to the notes folder | n/a | Mason's explicit yes in the running session; after PAR-2 grouping |

There is no RT-1 screens PR. The review screen is RT-3's Rates tab, which reads through `get_parent_draft_rates` and writes through `save_draft_product_rate`.

The DB PR is one migration plus its types, docs and harness. Splitting it would leave tables without their rules or rules without their tables, so it stays one PR. It touches no reader, so it needs no "database first, screens later" split (the memory trap for new RPCs applies only when screens call them in the same PR).

---

## 8. Overlaps settled here

- **Overlap 3 (units vs RT-2):** RT-1's own unit table means RT-1 and RT-2 are independent; RT-2 keeps `legacy_spellings` in step (3.2).
- **Overlap 4 (rate help and checks):** rate ≥ 0 and the 6-decimal rule carry over as CHECKs and the RPC shape check (3.1, 4.A). WP-PM-8's help text is unchanged; it describes the live columns, which RT-1 does not touch.
- **Overlap 6 (rate writers):** RT-1 adds one draft writer (`save_draft_product_rate`) and one draft deleter, and changes no live writer. RT-4's re-audit of every live writer is unaffected.
- **Overlap 11 (setup spreadsheet and lock):** drafts sit outside the lock and stay editable while it is on; RT-1 never reads it (3.6, R13). The setup workbook's Rates tab keeps writing the **live** parent columns through `set_parent_rates` until RT-4; RT-3 adds the draft review path.
- **Overlap 13 (parents):** every row belongs to a parent; one default per parent.

---

## 9. Dependencies, overlap and order (checked read-only 2026-11-08)

| Needs | Why | State |
|---|---|---|
| PAR-1 (`product_parents`, members, `_apply_parent_rates`, helpers) | The key, the helpers and the parent rate columns | Live |
| PAR-2 database part (proposals and grouping) | Grouping creates the parents | Live |
| **PAR-2 grouping data step** (Mason approves groups) | Derivation runs per parent; live has 0 | Not run. Blocks step 3 only. |
| REG-1 step 1 (`epa_registrations`, lock pair) | Label maximums and the lock | Live |
| REG-1 step 2 and seed | Real label maximums | Taha's #1524 has merged; step 2 is being built in another session, and the seed is Mason-gated. Not required: until then every house row reads `label maximum not checked` |
| RT-2 | Either order (grand plan section 8) | Not started |
| Taha's open PRs (#1534, #1576, #1587, #1677) | Checked: none changes rate data, parents, units or rate functions. #1677 restyles screens, including `src/pages/Quotes.tsx`; RT-1 changes no screen, so there is no file overlap | No overlap |

**Order:**
1. This sheet merges.
2. RT-1 DB PR: build, harness, Luna, Sol, open, 4-hour hold.
3. Live apply through the migration-apply gate, then the read-only live check (section 6).
4. Merge the DB PR.
5. PAR-2 grouping (Mason).
6. Derivation run (Mason's yes), then the live check again.
7. RT-3 (Mason's review) uses the drafts.

---

## 10. Steps that need Mason

1. **Apply the RT-1 migration live.** It is non-destructive, creates new tables and functions with routine lock-down grants, and changes no existing object, so it goes through the normal apply gate with Sol proofs. If the gate classifies it otherwise (for example as a permission change), it needs his yes.
2. **Approve PAR-2's groups** (already his step in the Stage 2 sheet).
3. **Say yes to the derivation run** in the session that runs it. It writes only draft rows that nothing reads.
4. **Answer the three questions below** before the derivation run (they change what the drafts say, not the database design).

---

## 11. Questions for Mason

**Answered (Mason, 2026-11-09): all three recommended answers accepted.** The suggested-rate text is filed as the label rate; seed-treatment numbers are copied as flagged, unconfirmed per-acre drafts that are never the quoting default; the warning fires when a rate is above any linked registration's maximum.

1. **Is today's "suggested rate" text the label rate?** The plan files it as the **label** rate in the draft (MSO XL's `2 qt/100 Gal`, as the grand plan says). Recommended: yes, because RT-3 has you confirm every row anyway. The alternative is filing it as "unknown source", which adds a third source value for you to sort later.
2. **Seed treatments:** their "per acre" number is really an amount per seed unit (for example Ilevo, 1.18 oz). The plan copies it as a house per-acre draft but does **not** make it the quoting default, marks its basis unconfirmed (so it is never checked against a per-acre label maximum), and flags it for your review. Recommended. The alternative (file it as a per-seed-unit house rate) is cleaner but means the draft no longer matches what quotes do today, which makes RT-3's comparison harder.
3. **Which label maximum counts** when a product has more than one EPA number (a generic and a brand): the plan warns if the house rate is above **any** of them. Recommended, because it never misses a warning. The alternative (only the parent's own generic number) gives fewer warnings but could miss a brand's lower maximum.

---

## 12. Review record

**Luna round 1** (gpt-6-luna xhigh, head `fa6655015`): 9 findings, all addressed.
- BLOCKER constraint trigger cannot be `BEFORE`: fixed, ordinary `BEFORE … FOR EACH ROW` trigger (3.1).
- HIGH seed-treatment per-acre house row could read "within" against a per-acre max: fixed with `basis_confirmed` (3.1, 3.5 step 4, section 5, R14, question 2).
- MED future-dated "latest live migration": refuted; this repo's stamps run ahead of the calendar by convention (`20261215110000` is live per `supabase_migrations`); note added in section 1.
- MED replay before locks races on the same key: refuted; `_product_parent_replay` takes a per-key advisory lock before reading the receipt (`20261108120000_product_parents.sql:499`); sentence added in 3.7.
- MED approval CHECK let a draft carry one approval field: fixed, both-or-neither per status (3.1).
- MED `updated_at` not moved on edit: fixed, update trigger sets it (3.1).
- MED truncated g/mg factors could flip a borderline check: fixed, weight factors are exact milligrams; boundary example added (3.2 table, 3.3, 4.G).
- LOW seed-unit estimate 15 vs 9: fixed (section 5).
- LOW `source_text` over 200 characters would fail a derivation write: fixed, length checked first and noted (3.1).

**Luna round 2** (head `ee90c1911`): 4 findings, all fixed.
- HIGH non-per-acre house rows were never checked, so `3 qt/100 gal` against a `2 qt/100 gal` max saved with no reason: fixed, a maximum is compared when its denominator gives the row's own basis (3.5 step 4, R9b).
- MED `/ac` and `/a` maximums: `normalize_rate_unit` already strips them (`20260630170000` lines 58-61); section 1 corrected, and RT-1 now reads the denominator with its own grammar (3.5, R9b).
- MED `numeric(18,6)` rounds a seventh decimal before a CHECK sees it: fixed, unconstrained `numeric` with a scale CHECK (3.1, R9b).
- MED derivation had no defined outcome for an above-label house rate: fixed, written with note `above_label` and `reason_missing`, never approvable as-is (4.C, R9c).

**Luna round 3** (head `9b08ad381`): no BLOCKER or HIGH; 2 findings, both fixed.
- MED a parsed value with more than 6 decimals would fail the CHECK mid-batch: fixed, derivation checks every value first and notes `value_invalid` (section 5, R6).
- LOW the save RPC's value check missed the `< 1e12` limit: fixed, it tests the CHECK's exact rule first (4.A step 2, R6).

**Codex GitHub App, PR #1679:** 2 P2 findings, both fixed.
- The idempotency receipt must use the `{actor_id, request_fingerprint, response}` envelope that `_product_parent_replay` reads (3.7).
- Grouped each and seed parents carry a null `rate_unit`, and their sizes use their stock unit. The safety check and house row are now form-aware, with the new note `stock_units_differ` (section 5, R14).
