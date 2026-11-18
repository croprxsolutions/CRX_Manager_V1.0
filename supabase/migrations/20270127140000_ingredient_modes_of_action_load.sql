-- idempotency-body-check: exempt
-- (data-only: no function, policy or schema change, so there is no RPC to carry an idempotency key)
-- ============================================================================================================
-- MOA-1 one-time group load (build sheet docs/plans/2026-11-12-product-MOA1-BUILD-SHEET.md, section 3.6).
--
-- Writes the resistance groups (HRAC, FRAC, IRAC) of the MOA-1 list v2 that Mason approved on 2026-11-18
-- ("approve the 125 confirmed groups") onto the matching active ingredients. 125 approved rows: 123 carry a
-- group and are listed below; 2 (Nitrapyrin, a nitrogen stabilizer; Trinexapac-ethyl, a growth regulator) have
-- no resistance group in any scheme, so there is nothing to store for them. The 5 Bacillus needs_check rows are
-- not approved and are not here.
--
-- Groups belong to ingredient rows (active_ingredient_modes_of_action.ingredient_id), so only ingredients that
-- exist when this runs are filled. Match: the same CAS number, or the same name (the active_ingredients.name_key
-- rule: lower case, spaces collapsed). Every list name and CAS was checked against EPA's own record for it.
-- A salt or ester is listed as its own form with its own group (its acid's group: one mode of action), because
-- EPA-committed forms carry no acid link; its note names the acid.
--
-- Rules (sheet 3.6): active ingredients only; an ingredient that already has an active list is never touched;
-- an ingredient that two list rows would give different codes in one scheme is skipped and reported, never
-- guessed; one 'updated' event per filled ingredient (before [], after the new list, attributed to Mason, who
-- approved the list). Safe to re-run: a second run finds every matched list filled and writes nothing.
-- Reports (NOTICE): rows written, ingredients filled, kept, skipped, list rows matching no ingredient, and
-- active ingredients still without a group.
--
-- Rollback: retire the rows this wrote (status 'retired', row_version + 1) through set_active_ingredient_modes
-- per ingredient, or one reviewed migration; events stay (append-only history). Nothing else is written.
-- ORDERING: after 20270108100000_ingredient_modes_of_action and every older migration.
-- ============================================================================================================

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $preflight$
BEGIN
  IF to_regclass('public.active_ingredient_modes_of_action') IS NULL OR to_regclass('public.active_ingredients') IS NULL
     OR to_regclass('public.active_ingredient_events') IS NULL
     OR to_regprocedure('public._ingredient_mode_list(uuid)') IS NULL THEN
    RAISE EXCEPTION 'MOA_LOAD_PREFLIGHT: MOA-1 part 1 (20270108100000) is not applied';
  END IF;
END
$preflight$;

-- No ingredient or group changes while the load reads and writes (the editor and the EPA commit wait a moment).
LOCK TABLE public.active_ingredients, public.active_ingredient_modes_of_action IN SHARE ROW EXCLUSIVE MODE;

DO $load$
DECLARE
  -- Mason's admin profile; he approved this list (2026-11-18). Records who approved it, not a permission check.
  v_actor constant uuid := '22c1fc50-4d2a-4baa-8ff8-341c0c7edd4f';
  v_reason constant text := 'MOA-1 one-time group load: published HRAC/FRAC/IRAC lists, approved by Mason 2026-11-18';
  v_rows int;
  v_filled int;
  v_kept int;
  v_skipped text;
  v_unmatched text;
  v_without int;
BEGIN
  -- Session-only scratch tables (a second run in the same session starts clean).
  DROP TABLE IF EXISTS pg_temp.moa1_list, pg_temp.moa1_match, pg_temp.moa1_conflict, pg_temp.moa1_fill;
  CREATE TEMP TABLE moa1_list (name text NOT NULL, cas text, scheme text NOT NULL, group_code text NOT NULL,
                               source_note text NOT NULL) ON COMMIT DROP;
  INSERT INTO moa1_list (name, cas, scheme, group_code, source_note) VALUES
    ('2,4-D, butoxyethyl ester', '1929-73-3', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of 2,4-D; same mode of action as 2,4-D. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('2,4-D, choline salt', '1048373-72-3', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of 2,4-D; same mode of action as 2,4-D. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('2,4-D, dimethylamine salt', '2008-39-1', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of 2,4-D; same mode of action as 2,4-D. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('2,4-D, triisopropanolamine salt', '32341-80-3', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of 2,4-D; same mode of action as 2,4-D. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Acetochlor', '34256-82-1', 'HRAC', '15', 'HRAC 15: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Afidopyropen', '915972-17-7', 'IRAC', '9D', 'IRAC 9D: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Alpha-cypermethrin', '67375-30-8', 'IRAC', '3A', 'IRAC 3A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Aminopyralid, potassium salt', '566191-87-5', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Aminopyralid; same mode of action as Aminopyralid. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Aminopyralid, triisopropanolamine salt', '566191-89-7', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Aminopyralid; same mode of action as Aminopyralid. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Atrazine', '1912-24-9', 'HRAC', '5', 'HRAC 5: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Azoxystrobin', '131860-33-8', 'FRAC', '11', 'FRAC 11: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Benzovindiflupyr', '1072957-71-1', 'FRAC', '7', 'FRAC 7: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('beta-Cyfluthrin', '68359-37-5', 'IRAC', '3A', 'IRAC 3A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Bicyclopyrone', '352010-68-5', 'HRAC', '27', 'HRAC 27: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Bifenthrin', '82657-04-3', 'IRAC', '3A', 'IRAC 3A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Bixafen', '581809-46-3', 'FRAC', '7', 'FRAC 7: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('boscalid', '188425-85-6', 'FRAC', '7', 'FRAC 7: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Broflanilide', '1207727-04-5', 'IRAC', '30', 'IRAC 30: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Bromoxynil heptanoate', '56634-95-8', 'HRAC', '6', 'HRAC 6: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Bromoxynil; same mode of action as Bromoxynil. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Bromoxynil octanoate', '1689-99-2', 'HRAC', '6', 'HRAC 6: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Bromoxynil; same mode of action as Bromoxynil. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Carfentrazone-ethyl', '128639-02-1', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Chlorantraniliprole', '500008-45-7', 'IRAC', '28', 'IRAC 28: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Chlorethoxyfos', '54593-83-8', 'IRAC', '1B', 'IRAC 1B: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Chlorimuron', '90982-32-4', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Chloroneb', '2675-77-6', 'FRAC', '14', 'FRAC 14: Secondary: older FRAC Code List copies / extension tables (not the current official PDF) (https://www.scribd.com/document/696613793/frac-code-list-2023-final). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Chlorsulfuron', '64902-72-3', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Clethodim', '99129-21-2', 'HRAC', '1', 'HRAC 1: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Clopyralid', '1702-17-6', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Clopyralid, dimethylamine salt', '1096483-37-2', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Clopyralid; same mode of action as Clopyralid. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Clopyralid, monoethanolamine salt', '57754-85-5', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Clopyralid; same mode of action as Clopyralid. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Cloransulam-methyl', '147150-35-4', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Copper, bis(acetato-O)diammine-', '13822-80-5', 'FRAC', 'M01', 'FRAC M01: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Cyclobutrifluram', '1460292-16-3', 'FRAC', '7', 'FRAC 7: Secondary: older FRAC Code List copies / extension tables (not the current official PDF) (https://www.scribd.com/document/696613793/frac-code-list-2023-final). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Cyfluthrin', '68359-37-5', 'IRAC', '3A', 'IRAC 3A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Cyproconazole', '94361-06-5', 'FRAC', '3', 'FRAC 3: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Dicamba, diglycolamine salt', '104040-79-1', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Dicamba; same mode of action as Dicamba. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Dicamba, sodium salt', '1982-69-0', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Dicamba; same mode of action as Dicamba. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Difenoconazole', '119446-68-3', 'FRAC', '3', 'FRAC 3: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Diflufenzopyr-sodium', '109293-98-3', 'HRAC', '19', 'HRAC 19: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Diflufenzopyr; same mode of action as Diflufenzopyr. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('dimethenamid-P', '163515-14-8', 'HRAC', '15', 'HRAC 15: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Diquat dibromide', '85-00-7', 'HRAC', '22', 'HRAC 22: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Diquat; same mode of action as Diquat. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Diuron', '330-54-1', 'HRAC', '5', 'HRAC 5: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Esfenvalerate', '66230-04-4', 'IRAC', '3A', 'IRAC 3A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Florpyrauxifen-benzyl', '1390661-72-9', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Florpyrauxifen; same mode of action as Florpyrauxifen. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Fluazifop-P-butyl', '79241-46-6', 'HRAC', '1', 'HRAC 1: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Fluazifop-P; same mode of action as Fluazifop-P. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Fludioxonil', '131341-86-1', 'FRAC', '12', 'FRAC 12: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Flufenacet', '142459-58-3', 'HRAC', '15', 'HRAC 15: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Fluindapyr', '1383809-87-7', 'FRAC', '7', 'FRAC 7: Secondary: older FRAC Code List copies / extension tables (not the current official PDF) (https://www.scribd.com/document/696613793/frac-code-list-2023-final). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Flumetsulam', '98967-40-9', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Flumiclorac', '87546-18-7', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Flumioxazin', '103361-09-7', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Fluopyram', '658066-35-4', 'FRAC', '7', 'FRAC 7: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Fluoxastrobin', '361377-29-9', 'FRAC', '11', 'FRAC 11: Secondary: older FRAC Code List copies / extension tables (not the current official PDF) (https://www.scribd.com/document/696613793/frac-code-list-2023-final). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Fluroxypyr 1-methylheptyl ester', '81406-37-3', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Fluroxypyr; same mode of action as Fluroxypyr. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Fluthiacet-methyl', '117337-19-6', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Flutriafol', '76674-21-0', 'FRAC', '3', 'FRAC 3: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Fluxapyroxad', '907204-31-3', 'FRAC', '7', 'FRAC 7: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Glufosinate', '77182-82-2', 'HRAC', '10', 'HRAC 10: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('glufosinate-P-ammonium', '73777-50-1', 'HRAC', '10', 'HRAC 10: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Glufosinate-P; same mode of action as Glufosinate-P. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Glyphosate', '1071-83-6', 'HRAC', '9', 'HRAC 9: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Glyphosate, dimethylammonium salt', '34494-04-7', 'HRAC', '9', 'HRAC 9: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Glyphosate; same mode of action as Glyphosate. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Glyphosate, isopropylamine salt', '38641-94-0', 'HRAC', '9', 'HRAC 9: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Glyphosate; same mode of action as Glyphosate. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Halauxifen-methyl', '943831-98-9', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Halauxifen; same mode of action as Halauxifen. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Imazamox, sodium salt', NULL, 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Imazamox; same mode of action as Imazamox. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Imazapyr', '81334-34-1', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Imazaquin', '81335-37-7', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Imazethapyr', '81335-77-5', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Imidacloprid', '138261-41-3', 'IRAC', '4A', 'IRAC 4A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Indaziflam', '950782-86-2', 'HRAC', '29', 'HRAC 29: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Indoxacarb', '173584-44-6', 'IRAC', '22A', 'IRAC 22A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Iodosulfuron-methyl-sodium', '144550-36-7', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Iodosulfuron-methyl; same mode of action as Iodosulfuron-methyl. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Isoxaflutole', '141112-29-0', 'HRAC', '27', 'HRAC 27: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Lactofen', '77501-63-4', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('lambda-Cyhalothrin', '91465-08-6', 'IRAC', '3A', 'IRAC 3A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Malathion (NO INERT USE)', '121-75-5', 'IRAC', '1B', 'IRAC 1B: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Mefentrifluconazole', '1417782-03-6', 'FRAC', '3', 'FRAC 3: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Mesotrione', '104206-82-8', 'HRAC', '27', 'HRAC 27: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Metalaxyl', '57837-19-1', 'FRAC', '4', 'FRAC 4: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Metalaxyl-M', '70630-17-0', 'FRAC', '4', 'FRAC 4: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Metconazole', '125116-23-6', 'FRAC', '3', 'FRAC 3: Secondary: older FRAC Code List copies / extension tables (not the current official PDF) (https://www.scribd.com/document/696613793/frac-code-list-2023-final). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Metribuzin', '21087-64-9', 'HRAC', '5', 'HRAC 5: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Metsulfuron-methyl', '74223-64-6', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Nicosulfuron', '111991-09-4', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Pendimethalin', '40487-42-1', 'HRAC', '3', 'HRAC 3: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Phorate', '298-02-2', 'IRAC', '1B', 'IRAC 1B: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Phostebupirim', '96182-53-5', 'IRAC', '1B', 'IRAC 1B: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Picarbutrazox', '500207-04-5', 'FRAC', 'U17', 'FRAC U17: Secondary: older FRAC Code List copies / extension tables (not the current official PDF) (https://www.scribd.com/document/696613793/frac-code-list-2023-final). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Picloram, potassium salt', '2545-60-0', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Picloram; same mode of action as Picloram. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Picloram, triisopropanolamine salt', '6753-47-5', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Picloram; same mode of action as Picloram. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Picoxystrobin', '117428-22-5', 'FRAC', '11', 'FRAC 11: Secondary: older FRAC Code List copies / extension tables (not the current official PDF) (https://www.scribd.com/document/696613793/frac-code-list-2023-final). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Prometon', '1610-18-0', 'HRAC', '5', 'HRAC 5: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Propiconazole', '60207-90-1', 'FRAC', '3', 'FRAC 3: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Prothioconazole', '178928-70-6', 'FRAC', '3', 'FRAC 3: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Pydiflumetofen', '1228284-64-7', 'FRAC', '7', 'FRAC 7: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Pyraclostrobin', '175013-18-0', 'FRAC', '11', 'FRAC 11: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Pyrasulfotole Technical', '365400-11-9', 'HRAC', '27', 'HRAC 27: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Pyridate', '55512-33-9', 'HRAC', '6', 'HRAC 6: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Pyroxasulfone', '447399-55-5', 'HRAC', '15', 'HRAC 15: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Quinclorac', '84087-01-4', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Quizalofop-p-ethyl', '100646-51-3', 'HRAC', '1', 'HRAC 1: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Quizalofop-P; same mode of action as Quizalofop-P. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Rimsulfuron', '122931-48-0', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('S-Metolachlor', '87392-12-9', 'HRAC', '15', 'HRAC 15: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Saflufenacil', '372137-35-4', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Sedaxane', '874967-67-6', 'FRAC', '7', 'FRAC 7: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Sodium bentazon', '50723-80-3', 'HRAC', '6', 'HRAC 6: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Bentazon; same mode of action as Bentazon. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Sodium salt of fomesafen', '108731-70-0', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Fomesafen; same mode of action as Fomesafen. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Sulfentrazone', '122836-35-5', 'HRAC', '14', 'HRAC 14: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Sulfoxaflor', '946578-00-3', 'IRAC', '4C', 'IRAC 4C: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Tebuconazole', '107534-96-3', 'FRAC', '3', 'FRAC 3: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Tebuthiuron', '34014-18-1', 'HRAC', '5', 'HRAC 5: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Tefluthrin', '79538-32-2', 'IRAC', '3A', 'IRAC 3A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Tembotrione', '335104-84-2', 'HRAC', '27', 'HRAC 27: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Terbufos', '13071-79-9', 'IRAC', '1B', 'IRAC 1B: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Thiamethoxam', '153719-23-4', 'IRAC', '4A', 'IRAC 4A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Thiencarbazone-methyl', '317815-83-1', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Thifensulfuron', '79277-27-3', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Thiophanate-methyl', '23564-05-8', 'FRAC', '1', 'FRAC 1: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Thiram', '137-26-8', 'FRAC', 'M03', 'FRAC M03: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Topramezone', '210631-68-8', 'HRAC', '27', 'HRAC 27: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Tribenuron-methyl', '101200-48-0', 'HRAC', '2', 'HRAC 2: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Triclopyr, butoxyethyl ester', '64700-56-7', 'HRAC', '4', 'HRAC 4: HRAC 2026 Global Herbicide MoA Classification Master List (official xlsx, hracglobal.com) + 2026 poster; HRAC MoA WG Report 2024-25 (no numeric group changes vs 2024) (https://hracglobal.com/tools/2024-hrac-global-herbicide-moa-classification). Salt/ester of Triclopyr; same mode of action as Triclopyr. MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Trifloxystrobin', '141517-21-7', 'FRAC', '11', 'FRAC 11: FRAC Code List via CropLife Australia 2026 Fungicide Activity Group Table (secondary; valid 22 Jul 2026, based on FRAC list) (https://media.croplife.org.au/2026/07/CropLife_2026-FungicideActivityGroupTable.pdf). MOA-1 list v2, approved by Mason 2026-11-18'),
    ('Zeta-Cypermethrin', NULL, 'IRAC', '3A', 'IRAC 3A: IRAC MoA Classification Scheme v11.5, Feb 2026, Appendix alphabetical list (https://irac-online.org/documents/moa-classification). MOA-1 list v2, approved by Mason 2026-11-18');

  IF (SELECT count(*) FROM moa1_list) <> 123 THEN
    RAISE EXCEPTION 'MOA_LOAD_LIST: expected 123 group rows, found %', (SELECT count(*) FROM moa1_list);
  END IF;

  -- Each list row against each active ingredient it names, by CAS or by name.
  CREATE TEMP TABLE moa1_match ON COMMIT DROP AS
  SELECT DISTINCT a.id AS ingredient_id, l.name AS list_name, l.scheme, l.group_code, l.source_note
    FROM moa1_list l
    JOIN public.active_ingredients a
      ON a.status = 'active'
     AND ((l.cas IS NOT NULL AND btrim(a.cas) = l.cas)
          OR a.name_key = lower(regexp_replace(btrim(l.name), '\s+', ' ', 'g')));

  -- Ingredients that two list rows would give different codes in one scheme: skipped, never guessed.
  CREATE TEMP TABLE moa1_conflict ON COMMIT DROP AS
  SELECT DISTINCT ingredient_id FROM moa1_match GROUP BY ingredient_id, scheme HAVING count(DISTINCT group_code) > 1;

  -- Ingredients to fill: matched, no conflict, no active list yet.
  CREATE TEMP TABLE moa1_fill ON COMMIT DROP AS
  SELECT DISTINCT m.ingredient_id FROM moa1_match m
   WHERE m.ingredient_id NOT IN (SELECT ingredient_id FROM moa1_conflict)
     AND NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o
                      WHERE o.ingredient_id = m.ingredient_id AND o.status = 'active');

  -- One row per ingredient, scheme and code. When two list rows agree (cyfluthrin and beta-cyfluthrin share a
  -- CAS), the note of the row named like the ingredient wins, else the first by name.
  INSERT INTO public.active_ingredient_modes_of_action (ingredient_id, scheme, group_code, source_note, created_by, updated_by)
  SELECT DISTINCT ON (m.ingredient_id, m.scheme, m.group_code)
         m.ingredient_id, m.scheme, m.group_code, m.source_note, v_actor, v_actor
    FROM moa1_match m
    JOIN public.active_ingredients a ON a.id = m.ingredient_id
   WHERE m.ingredient_id IN (SELECT ingredient_id FROM moa1_fill)
   ORDER BY m.ingredient_id, m.scheme, m.group_code,
            (a.name_key = lower(regexp_replace(btrim(m.list_name), '\s+', ' ', 'g'))) DESC, m.list_name;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  INSERT INTO public.active_ingredient_events (ingredient_id, event_type, reason, evidence, before_values, after_values, changed_by)
  SELECT f.ingredient_id, 'updated', v_reason, NULL, jsonb_build_object('modes_of_action', '[]'::jsonb),
         jsonb_build_object('modes_of_action', public._ingredient_mode_list(f.ingredient_id)), v_actor
    FROM moa1_fill f;
  GET DIAGNOSTICS v_filled = ROW_COUNT;

  -- Postcondition: every filled ingredient now holds exactly the codes the list gives it, and nothing else.
  IF EXISTS (SELECT 1 FROM moa1_fill f
              WHERE (SELECT array_agg(DISTINCT m.scheme || ' ' || m.group_code ORDER BY m.scheme || ' ' || m.group_code)
                       FROM moa1_match m WHERE m.ingredient_id = f.ingredient_id)
                    IS DISTINCT FROM
                    (SELECT array_agg(o.scheme || ' ' || o.group_code ORDER BY o.scheme || ' ' || o.group_code)
                       FROM public.active_ingredient_modes_of_action o
                      WHERE o.ingredient_id = f.ingredient_id AND o.status = 'active')) THEN
    RAISE EXCEPTION 'MOA_LOAD_POSTCONDITION: a filled ingredient does not hold exactly its listed groups';
  END IF;

  SELECT count(DISTINCT m.ingredient_id) INTO v_kept FROM moa1_match m
   WHERE m.ingredient_id NOT IN (SELECT ingredient_id FROM moa1_fill)
     AND m.ingredient_id NOT IN (SELECT ingredient_id FROM moa1_conflict);
  SELECT string_agg(DISTINCT a.name, '; ') INTO v_skipped
    FROM moa1_conflict c JOIN public.active_ingredients a ON a.id = c.ingredient_id;
  SELECT string_agg(l.name, '; ' ORDER BY l.name) INTO v_unmatched
    FROM moa1_list l WHERE NOT EXISTS (SELECT 1 FROM moa1_match m WHERE m.list_name = l.name);
  SELECT count(*) INTO v_without FROM public.active_ingredients a
   WHERE a.status = 'active'
     AND NOT EXISTS (SELECT 1 FROM public.active_ingredient_modes_of_action o
                      WHERE o.ingredient_id = a.id AND o.status = 'active');

  RAISE NOTICE 'MOA_LOAD: % group rows written on % ingredients; % matched ingredients already had a list (kept)',
    v_rows, v_filled, v_kept;
  RAISE NOTICE 'MOA_LOAD: skipped (list rows disagree): %', COALESCE(v_skipped, 'none');
  RAISE NOTICE 'MOA_LOAD: list rows matching no active ingredient: %', COALESCE(v_unmatched, 'none');
  RAISE NOTICE 'MOA_LOAD: active ingredients still without a group: %', v_without;
END
$load$;
