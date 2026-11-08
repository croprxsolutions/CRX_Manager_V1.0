-- KI-30: correct the EPA registration numbers of 48 products (data only).
--
-- WHY: a read-only re-measure on 2026-11-08 against EPA's registry (PPLS) found 40 products whose stored
-- number is wrong (EPA moved it to a new number, or it belongs to another brand) and 8 with no number that
-- have a registry match. Each proposed number and its evidence is in Mason's KI-30 review workbook
-- (docs/manual/KNOWN_ISSUES.md KI-30). Only HIGH and MEDIUM proposals are here; the 4 products that need
-- a person to read the jug are left alone. Mason chose this reviewed migration over hand edits (2026-11-08).
--
-- WHAT: sets products.epa_registration (and updated_at) on exactly these 48 rows. A row changes only when
-- its name and stored number (exactly; blank means NULL or empty text) still equal the measured values below,
-- checked under a row lock; if any of the 48 has
-- moved, been deleted or joined a product family, nothing changes and the migration stops. The existing
-- trigger write_product_change_history records each change (old and new number) in product_change_history.
-- Some readers (spray-job proofs, application reports, year-end summaries) still show the product's current
-- number, so the migration also stops if any listed product now has a posted invoice line or a job or spray
-- record; on 2026-11-08 none had (the only two invoice lines are drafts with no number, which should pick up
-- the corrected one).
-- No schema, function, grant or policy change.
--
-- ROLLBACK: set each listed product back to its measured value (old_epa below) with the same guard in reverse
-- (the stored number must still equal new_epa). The 8 blank ones go back to NULL: on 2026-11-08 five were
-- NULL and three empty text, which the app and every EPA check treat alike as "no number". product_change_history
-- keeps each row's old and new number (field_name = 'epa_registration', change_type 'updated').

DO $ki30$
DECLARE
  v_expected constant integer := 48;
  v_bad text;
  v_done integer;
BEGIN
  -- Set here, not with SET LOCAL above the block, so it holds however the file is run.
  PERFORM set_config('lock_timeout', '10s', true);
  CREATE TEMP TABLE ki30_epa_fix (id uuid PRIMARY KEY, product_name text NOT NULL, old_epa text NOT NULL, new_epa text NOT NULL)
    ON COMMIT DROP;
  INSERT INTO ki30_epa_fix (id, product_name, old_epa, new_epa) VALUES
    ('3c404225-cd73-4744-ba8c-9536abcf6223'::uuid, 'Aproach - 110 Gal', '62719-602', '352-840'),
    ('0302ddf4-8745-44a5-a344-c48d7d439c7c'::uuid, 'Aproach - 2.5 Gal', '62719-602', '352-840'),
    ('b9be7164-b8bc-4a52-b4b6-6405b6c0d777'::uuid, 'Authority First - 10#', '279-3195', '279-3246'),
    ('b1b96b2a-46ed-438d-86af-8004750b0f85'::uuid, 'Basagran 5L - 2.5 Gal', '12500-49', '7969-112'),
    ('2b92d279-51f3-4324-8792-13f52e9bbbe8'::uuid, 'Crossbow/Crossroad - 2.5 Gal', '62719-324', '62719-260'),
    ('0ac5816e-9c4a-4692-a78a-68b3e495431f'::uuid, 'Distinct - 7.5 lbs', '7969-360', '7969-150'),
    ('98165916-4c2b-459c-a1a4-8b501b46927b'::uuid, 'Duracor - 1 Gal', '62719-622', '62719-739'),
    ('a5746e61-7b21-40d8-a33f-54476caa7c9e'::uuid, 'Duracor - 250 Gal', '62719-622', '62719-739'),
    ('76cc1352-4de1-4d81-abaf-b712c8cf96d7'::uuid, 'Endura - 104 oz', '7969-204', '7969-197'),
    ('0c7db329-e84b-46c8-9a84-8354d420494f'::uuid, 'Forcivo - 2.5 Gal', '62719-613', '279-3642-62719'),
    ('1a1bcdf2-7292-49c4-8e6a-3bee2fbff4da'::uuid, 'Forcivo - 250 Gal', '62719-613', '279-3642-62719'),
    ('1debe3ec-f7fc-40b5-912b-25ab5c922394'::uuid, 'Headline SC - 2.5 Gal', '7969-233', '7969-289'),
    ('036d97fb-0410-47dc-99d7-536278da71fa'::uuid, 'Huskie - 2.5 Gal', '62719-602', '264-1023'),
    ('0aa0f180-7a84-44cb-81c4-2e934b846176'::uuid, 'Huskie Complete - 2.14 Gal', '62719-602', '264-1135'),
    ('0294faa8-ab0b-488e-9efe-868071738625'::uuid, 'Imazuron Herbicide', '', '228-654'),
    ('25e84da2-107d-4c42-9720-4f875e317db8'::uuid, 'Mauler - 2.5 Gal', '', '70506-68-59639'),
    ('1ba9b1f2-6c5f-49c5-add2-71a270c254cb'::uuid, 'Pramitol 25E - 2.5 Gal', '70506-123', '53883-505'),
    ('014f67c4-4f17-4403-8312-13bb3a93de7c'::uuid, 'Priaxor - 2.5 Gal', '7969-379', '7969-311'),
    ('2cf386c9-782c-45fa-8dc4-ccf27608d8d9'::uuid, 'Roundup QuikPro SC Total - 2.5 Gal', '', '105211-119'),
    ('5e7dcbfe-46d9-4fdf-a6e9-82e017c9b758'::uuid, 'Smart Choice 15G HC Smartbox - 50# SB', '5481-561', '5481-579'),
    ('6e3aa651-e662-499d-8ad5-364ae2130926'::uuid, 'Sonic Boom - 2.5 Gal', '62719-680', '70506-394-62719'),
    ('e86dc089-9121-4a5e-b5f6-7211bee3d809'::uuid, 'Spike 20P - 5#', '70506-137', '62719-121'),
    ('2a7e1649-9d21-40ae-964d-738f24554642'::uuid, 'Tendovo - 2.5 Gal', '', '100-1684'),
    ('4422a2d9-fd77-4ec2-b17b-8010b539ba1c'::uuid, 'Tendovo - Bulk', '', '100-1684'),
    ('ac926057-cfae-4070-9cb6-ff2ecc421c3c'::uuid, 'Treaty Extra', '', '71368-76'),
    ('df4b8cb5-8992-4866-bebe-073ea2e971ad'::uuid, 'TripleFLEX II - Bulk', '62719-131', '524-614'),
    ('db6b3b17-7c38-4987-9b7f-f5374310f975'::uuid, 'Varisto - 2.5 Gal', '7969-385', '241-447'),
    ('eea41d96-64b1-4ef1-8263-f07bb1254c6d'::uuid, 'Verdict - 2.5 Gal', '7969-330', '7969-279'),
    ('5ae6e7b6-c982-4345-be9e-9f07e8b49a18'::uuid, 'Verdict - Bulk', '7969-330', '7969-279'),
    ('22332dd6-4eab-4f46-8f2e-8fe8b9975c6c'::uuid, 'Viatude - 2.5 Gal', '62719-615', '352-942'),
    ('00da2570-a3a6-4b50-8704-aad1e5c700ff'::uuid, 'Victrato - Per Unit', '', '100-1724'),
    ('b7d9f11d-6256-4c47-940d-b309612323ec'::uuid, 'Warrior II w/Zeon - 1 Gal', '100-940', '100-1295'),
    ('25d83c17-75d7-46be-a8cc-60d472d029a1'::uuid, 'WideARmatch - 2.5 Gal', '62719-512', '62719-746'),
    ('76aaae09-429f-4498-84d8-15e352a1e279'::uuid, 'WideARmatch - 250 Gal', '62719-512', '62719-746'),
    ('3ba6df61-b644-4f25-97a9-33a9dfda88b5'::uuid, 'Zannis SC', '', '91234-430'),
    ('d4fb23e5-48b0-49a5-98ce-ce68c2d80e2d'::uuid, 'Zironar LFR - 2.5 Gal', '279-3618', '279-9719'),
    ('1ec38578-6eaa-4cff-acd5-0ee0ec8dceda'::uuid, 'Cimarron Plus - 10 oz', '432-1572', '101563-183'),
    ('071ee443-aa74-419f-bf24-3a9317e7c7e3'::uuid, 'Copper-Count-N', '10465-3', '8419-1'),
    ('b5d42717-1626-4962-bd74-f69e671cc615'::uuid, 'Evito - 128 oz', '66330-64', '70506-396'),
    ('a55d16f2-fdae-4ab8-afa7-e544a001f01e'::uuid, 'Evito T - 2.5 Gal', '66330-383', '70506-425'),
    ('cc840d15-dc65-47b7-91bc-15af348523d4'::uuid, 'First Rate - 12 oz', '62719-275', '5481-676'),
    ('2495e380-7c58-44ea-822f-a84838fbdf27'::uuid, 'Ilevo Seed Treatment - 15 Gal', '264-1167', '7969-441'),
    ('386a0ef3-bbcd-4628-9e02-66bf51dd22e6'::uuid, 'Ilevo Seed Treatment - 2.5 Gal', '264-1167', '7969-441'),
    ('038d3694-28f8-4753-a802-e939b5989704'::uuid, 'Ilevo Seed Treatment - Per Unit', '264-1167', '7969-441'),
    ('651c4660-3cee-472b-a2e2-2547d9b0065e'::uuid, 'Powermax 3 - 2.5 Gal', '524-659', '105211-118'),
    ('d50b3d7f-1dd3-4271-b230-8ee2925e6273'::uuid, 'Powermax 3 - Bulk', '524-659', '105211-118'),
    ('1ba1edbd-9859-47cd-8e35-874c75dbbfff'::uuid, 'Python - 2.5 lb', '62719-277', '5481-677'),
    ('2476f61e-8c79-460a-9ad4-a448889b2a9b'::uuid, 'Tempo SC Ultra - 8 oz', '432-1363', '101563-86');

  IF (SELECT count(*) FROM ki30_epa_fix) <> v_expected THEN
    RAISE EXCEPTION 'KI30_LIST_SIZE: expected % rows', v_expected;
  END IF;
  IF EXISTS (SELECT 1 FROM ki30_epa_fix
              WHERE new_epa !~ '^[1-9][0-9]{0,5}-[1-9][0-9]{0,4}(-[1-9][0-9]{0,5})?$' OR new_epa = old_epa) THEN
    RAISE EXCEPTION 'KI30_BAD_TARGET: a new number is malformed or unchanged';
  END IF;

  -- Lock the listed rows first, so nobody can rename them, change their number or add them to a family
  -- (the family tables reference products by foreign key, so those inserts wait on this lock) until commit.
  PERFORM 1 FROM public.products p WHERE p.id IN (SELECT id FROM ki30_epa_fix) ORDER BY p.id FOR UPDATE;
  -- New invoice, job and spray-lot lines also reference products by foreign key, so they wait too. Hold the
  -- invoices already carrying these products, so a draft cannot be posted between the check below and the
  -- update, and hold job_product_epa (no foreign key to products) still for these few seconds.
  PERFORM 1 FROM public.invoices i
   WHERE EXISTS (SELECT 1 FROM public.invoice_items ii WHERE ii.invoice_id = i.id AND ii.product_id IN (SELECT id FROM ki30_epa_fix))
   ORDER BY i.id FOR SHARE;
  LOCK TABLE public.job_product_epa IN SHARE MODE;

  -- Every row must still be exactly as measured: same product, same name, same stored number (exactly; a
  -- blank means NULL or empty text), not in a family (as a member, a fill source or a cost reference).
  SELECT string_agg(f.product_name, ', ' ORDER BY f.product_name) INTO v_bad
    FROM ki30_epa_fix f LEFT JOIN public.products p ON p.id = f.id
   WHERE p.id IS NULL
      OR p.product_name IS DISTINCT FROM f.product_name
      OR COALESCE(p.epa_registration, '') <> f.old_epa
      OR EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = f.id OR m.fill_source_product_id = f.id)
      OR EXISTS (SELECT 1 FROM public.product_parent_cost_reference c WHERE c.reference_product_id = f.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI30_ROW_MOVED: these products no longer match the reviewed list, nothing was changed: %', v_bad;
  END IF;

  -- Spray-job proofs, application reports and year-end summaries still read the product's current number.
  -- On 2026-11-08 none of these products had a posted invoice line or any job or spray record, so changing
  -- the number rewrites no history. If one appeared since (the lock above makes new ones wait), stop.
  SELECT string_agg(f.product_name, ', ' ORDER BY f.product_name) INTO v_bad
    FROM ki30_epa_fix f
   WHERE EXISTS (SELECT 1 FROM public.invoice_items ii JOIN public.invoices i ON i.id = ii.invoice_id
                  WHERE ii.product_id = f.id AND i.status IS DISTINCT FROM 'draft')
      OR EXISTS (SELECT 1 FROM public.job_chemicals jc WHERE jc.product_id = f.id)
      OR EXISTS (SELECT 1 FROM public.job_product_epa k WHERE k.product_id = f.id)
      OR EXISTS (SELECT 1 FROM public.application_record_lots l WHERE l.product_id = f.id);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI30_HISTORY_EXISTS: these products now have a posted invoice or a job or spray record, nothing was changed: %', v_bad;
  END IF;

  UPDATE public.products p
     SET epa_registration = f.new_epa, updated_at = now()
    FROM ki30_epa_fix f
   WHERE p.id = f.id AND p.product_name = f.product_name AND COALESCE(p.epa_registration, '') = f.old_epa
     AND NOT EXISTS (SELECT 1 FROM public.product_parent_members m WHERE m.product_id = f.id OR m.fill_source_product_id = f.id)
     AND NOT EXISTS (SELECT 1 FROM public.product_parent_cost_reference c WHERE c.reference_product_id = f.id);
  GET DIAGNOSTICS v_done = ROW_COUNT;
  IF v_done <> v_expected THEN
    RAISE EXCEPTION 'KI30_UPDATE_COUNT: updated % of % rows', v_done, v_expected;
  END IF;
END;
$ki30$;
