-- KI-30 follow-up: confirm on live that the 48 EPA corrections left no stale copy behind (checks only).
--
-- WHY: 20261214100000_ki30_epa_registration_corrections (applied live 2026-11-08, ledger 20261108192049) let
-- draft invoice lines through and did not check products.product_family_id. A draft line saved before the
-- correction keeps its own copy of the old number (invoice_items.epa_registration), and the invoice PDF
-- prefers that copy. An applied migration is never edited, so this follow-up checks both on live.
--
-- WHAT: no row, schema, function, grant or policy changes. For the same 48 products, it stops with an error if
-- (1) any invoice line (draft or posted) holds a non-blank EPA number other than the corrected one, or
-- (2) any of them has products.product_family_id set. On 2026-11-08 (read-only) both counts were 0.
-- Run on a database without these products (a fresh replay), both checks find nothing and it passes.
--
-- ROLLBACK: nothing to roll back.

DO $ki30f$
DECLARE
  v_bad text;
BEGIN
  CREATE TEMP TABLE ki30_epa_fixed (id uuid PRIMARY KEY, new_epa text NOT NULL) ON COMMIT DROP;
  INSERT INTO ki30_epa_fixed (id, new_epa) VALUES
    ('3c404225-cd73-4744-ba8c-9536abcf6223'::uuid, '352-840'),
    ('0302ddf4-8745-44a5-a344-c48d7d439c7c'::uuid, '352-840'),
    ('b9be7164-b8bc-4a52-b4b6-6405b6c0d777'::uuid, '279-3246'),
    ('b1b96b2a-46ed-438d-86af-8004750b0f85'::uuid, '7969-112'),
    ('2b92d279-51f3-4324-8792-13f52e9bbbe8'::uuid, '62719-260'),
    ('0ac5816e-9c4a-4692-a78a-68b3e495431f'::uuid, '7969-150'),
    ('98165916-4c2b-459c-a1a4-8b501b46927b'::uuid, '62719-739'),
    ('a5746e61-7b21-40d8-a33f-54476caa7c9e'::uuid, '62719-739'),
    ('76cc1352-4de1-4d81-abaf-b712c8cf96d7'::uuid, '7969-197'),
    ('0c7db329-e84b-46c8-9a84-8354d420494f'::uuid, '279-3642-62719'),
    ('1a1bcdf2-7292-49c4-8e6a-3bee2fbff4da'::uuid, '279-3642-62719'),
    ('1debe3ec-f7fc-40b5-912b-25ab5c922394'::uuid, '7969-289'),
    ('036d97fb-0410-47dc-99d7-536278da71fa'::uuid, '264-1023'),
    ('0aa0f180-7a84-44cb-81c4-2e934b846176'::uuid, '264-1135'),
    ('0294faa8-ab0b-488e-9efe-868071738625'::uuid, '228-654'),
    ('25e84da2-107d-4c42-9720-4f875e317db8'::uuid, '70506-68-59639'),
    ('1ba9b1f2-6c5f-49c5-add2-71a270c254cb'::uuid, '53883-505'),
    ('014f67c4-4f17-4403-8312-13bb3a93de7c'::uuid, '7969-311'),
    ('2cf386c9-782c-45fa-8dc4-ccf27608d8d9'::uuid, '105211-119'),
    ('5e7dcbfe-46d9-4fdf-a6e9-82e017c9b758'::uuid, '5481-579'),
    ('6e3aa651-e662-499d-8ad5-364ae2130926'::uuid, '70506-394-62719'),
    ('e86dc089-9121-4a5e-b5f6-7211bee3d809'::uuid, '62719-121'),
    ('2a7e1649-9d21-40ae-964d-738f24554642'::uuid, '100-1684'),
    ('4422a2d9-fd77-4ec2-b17b-8010b539ba1c'::uuid, '100-1684'),
    ('ac926057-cfae-4070-9cb6-ff2ecc421c3c'::uuid, '71368-76'),
    ('df4b8cb5-8992-4866-bebe-073ea2e971ad'::uuid, '524-614'),
    ('db6b3b17-7c38-4987-9b7f-f5374310f975'::uuid, '241-447'),
    ('eea41d96-64b1-4ef1-8263-f07bb1254c6d'::uuid, '7969-279'),
    ('5ae6e7b6-c982-4345-be9e-9f07e8b49a18'::uuid, '7969-279'),
    ('22332dd6-4eab-4f46-8f2e-8fe8b9975c6c'::uuid, '352-942'),
    ('00da2570-a3a6-4b50-8704-aad1e5c700ff'::uuid, '100-1724'),
    ('b7d9f11d-6256-4c47-940d-b309612323ec'::uuid, '100-1295'),
    ('25d83c17-75d7-46be-a8cc-60d472d029a1'::uuid, '62719-746'),
    ('76aaae09-429f-4498-84d8-15e352a1e279'::uuid, '62719-746'),
    ('3ba6df61-b644-4f25-97a9-33a9dfda88b5'::uuid, '91234-430'),
    ('d4fb23e5-48b0-49a5-98ce-ce68c2d80e2d'::uuid, '279-9719'),
    ('1ec38578-6eaa-4cff-acd5-0ee0ec8dceda'::uuid, '101563-183'),
    ('071ee443-aa74-419f-bf24-3a9317e7c7e3'::uuid, '8419-1'),
    ('b5d42717-1626-4962-bd74-f69e671cc615'::uuid, '70506-396'),
    ('a55d16f2-fdae-4ab8-afa7-e544a001f01e'::uuid, '70506-425'),
    ('cc840d15-dc65-47b7-91bc-15af348523d4'::uuid, '5481-676'),
    ('2495e380-7c58-44ea-822f-a84838fbdf27'::uuid, '7969-441'),
    ('386a0ef3-bbcd-4628-9e02-66bf51dd22e6'::uuid, '7969-441'),
    ('038d3694-28f8-4753-a802-e939b5989704'::uuid, '7969-441'),
    ('651c4660-3cee-472b-a2e2-2547d9b0065e'::uuid, '105211-118'),
    ('d50b3d7f-1dd3-4271-b230-8ee2925e6273'::uuid, '105211-118'),
    ('1ba1edbd-9859-47cd-8e35-874c75dbbfff'::uuid, '5481-677'),
    ('2476f61e-8c79-460a-9ad4-a448889b2a9b'::uuid, '101563-86');
  IF (SELECT count(*) FROM ki30_epa_fixed) <> 48 THEN
    RAISE EXCEPTION 'KI30F_LIST_SIZE: expected 48 rows';
  END IF;

  SELECT string_agg(DISTINCT p.product_name, ', ') INTO v_bad
    FROM public.invoice_items ii
    JOIN ki30_epa_fixed f ON f.id = ii.product_id
    JOIN public.products p ON p.id = ii.product_id
   WHERE NULLIF(btrim(ii.epa_registration), '') IS NOT NULL
     AND ii.epa_registration <> f.new_epa;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI30F_STALE_INVOICE_LINE: an invoice line still holds an old EPA number for: %', v_bad;
  END IF;

  SELECT string_agg(p.product_name, ', ' ORDER BY p.product_name) INTO v_bad
    FROM public.products p JOIN ki30_epa_fixed f ON f.id = p.id
   WHERE p.product_family_id IS NOT NULL;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'KI30F_FAMILY_LINK: these corrected products have a product family link: %', v_bad;
  END IF;
END;
$ki30f$;
