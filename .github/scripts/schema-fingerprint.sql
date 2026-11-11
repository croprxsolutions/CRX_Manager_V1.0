-- One line per object in the public schema, the same on any database. db-apply.mjs `schema` runs it on
-- the target (staging) and on a database rebuilt from the repo, then diffs the lines. Catalog only (no
-- table data), so a read-only login with no table grants can run it. Owners show as 'admin' when they are
-- postgres or supabase_admin (the platform and a restore can differ there), by name otherwise (an app
-- role owning a table bypasses its RLS). Function and view bodies are compared by md5, byte for byte.
-- Fixed search_path: type and function names print the same whatever the login's own setting.
SET search_path = public;
WITH pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.* FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
who AS (SELECT oid, CASE WHEN rolname IN ('postgres', 'supabase_admin') THEN 'admin' ELSE rolname END AS name FROM pg_roles),
fn AS (SELECT p.*, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
       FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')),
lines AS (
  SELECT 'relation ' || relname || ' kind=' || relkind::text || ' persistence=' || relpersistence::text || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity
         || coalesce(' partition ' || pg_get_expr(relpartbound, oid), '')
         || ' owner=' || (SELECT name FROM who WHERE who.oid = relowner) AS line
    FROM rel WHERE relkind IN ('r', 'p', 'v', 'm', 'f', 'S', 'c')
  UNION ALL
  SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
         || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
         || CASE WHEN a.attgenerated::text <> '' THEN ' generated ' || a.attgenerated::text ELSE '' END
         || CASE WHEN a.attidentity::text <> '' THEN ' identity ' || a.attidentity::text ELSE '' END
         || CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN ' collate ' || a.attcollation::regcollation::text ELSE '' END
    FROM pg_attribute a JOIN rel c ON c.oid = a.attrelid
    JOIN pg_type t ON t.oid = a.atttypid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'c') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint ' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN rel c ON c.oid = k.conrelid
  UNION ALL
  SELECT 'index ' || pg_get_indexdef(i.indexrelid) || ' valid=' || i.indisvalid || ' ready=' || i.indisready FROM pg_index i JOIN rel c ON c.oid = i.indexrelid
  UNION ALL
  SELECT 'trigger ' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN rel c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal
  UNION ALL
  -- Triggers elsewhere (e.g. auth.users) that call a function in public.
  SELECT 'trigger ' || t.tgenabled::text || ' ' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal AND p.pronamespace = (SELECT oid FROM pub)
      AND t.tgrelid NOT IN (SELECT oid FROM rel)
  UNION ALL
  SELECT 'publication ' || pubname || ' ' || schemaname || '.' || tablename FROM pg_publication_tables WHERE schemaname = 'public'
  UNION ALL
  SELECT 'policy ' || schemaname || '.' || tablename || '.' || policyname || ' ' || permissive || ' ' || cmd || ' to ' || array_to_string(roles, ',')
         || ' using ' || coalesce(qual, '-') || ' check ' || coalesce(with_check, '-')
    FROM pg_policies WHERE schemaname IN ('public', 'storage')
  UNION ALL
  SELECT 'view ' || relname || ' md5=' || md5(pg_get_viewdef(oid)) FROM rel WHERE relkind IN ('v', 'm')
  UNION ALL
  SELECT 'function ' || sig || ' kind=' || prokind::text
         || CASE WHEN prokind IN ('f', 'p') THEN ' md5=' || md5(pg_get_functiondef(oid)) ELSE '' END
         || ' owner=' || (SELECT name FROM who WHERE who.oid = proowner)
    FROM fn
  UNION ALL
  SELECT 'aggregate ' || f.sig || ' ' || a.aggtransfn::regproc::text || ' ' || a.aggfinalfn::regproc::text || ' ' || format_type(a.aggtranstype, NULL)
         || coalesce(' init ' || a.agginitval, '')
    FROM fn f JOIN pg_aggregate a ON a.aggfnoid = f.oid
  UNION ALL
  SELECT 'sequence ' || c.relname || ' ' || format_type(q.seqtypid, NULL) || ' start ' || q.seqstart || ' by ' || q.seqincrement
         || ' min ' || q.seqmin || ' max ' || q.seqmax || ' cache ' || q.seqcache || ' cycle=' || q.seqcycle
         || coalesce((SELECT ' owned by ' || o.relname || '.' || a.attname FROM pg_depend d JOIN pg_class o ON o.oid = d.refobjid
                      JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
                      WHERE d.objid = q.seqrelid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')), '')
    FROM pg_sequence q JOIN rel c ON c.oid = q.seqrelid
  UNION ALL
  SELECT 'enum ' || t.typname || ' ' || string_agg(quote_literal(e.enumlabel), ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace = (SELECT oid FROM pub) GROUP BY t.typname
  UNION ALL
  SELECT 'domain ' || typname || ' ' || format_type(typbasetype, typtypmod) || CASE WHEN typnotnull THEN ' not null' ELSE '' END
    FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typtype = 'd'
  UNION ALL
  SELECT 'constraint domain ' || t.typname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN pg_type t ON t.oid = k.contypid WHERE t.typnamespace = (SELECT oid FROM pub)
  UNION ALL
  SELECT 'range ' || t.typname || ' ' || format_type(r.rngsubtype, NULL)
    FROM pg_range r JOIN pg_type t ON t.oid = r.rngtypid WHERE t.typnamespace = (SELECT oid FROM pub)
  UNION ALL
  SELECT 'schema public owner=' || (SELECT name FROM who WHERE who.oid = n.nspowner) || ' ' || x.privilege_type
         || CASE WHEN x.is_grantable THEN '+grant' ELSE '' END || ' to ' || coalesce(r.rolname, 'PUBLIC')
    FROM pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n'::"char", n.nspowner))) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
    WHERE n.nspname = 'public' AND x.grantee <> n.nspowner AND coalesce(r.rolname, '') NOT IN ('postgres', 'supabase_admin')
  UNION ALL
  -- Default privileges: what every future table, sequence or function in public will grant.
  SELECT 'default ' || d.defaclobjtype::text || ' by ' || (SELECT name FROM who WHERE who.oid = d.defaclrole) || ' in ' || coalesce(n.nspname, '*')
         || ' ' || x.privilege_type || CASE WHEN x.is_grantable THEN '+grant' ELSE '' END || ' to ' || coalesce(r.rolname, 'PUBLIC')
    FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace, aclexplode(d.defaclacl) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
    WHERE n.nspname = 'public' OR d.defaclnamespace = 0
  UNION ALL
  -- Grants (who may read, write or call what). The owner and the two admin roles are left out: which of
  -- them owns an object can differ between the platform and a restore; the app roles are what matter.
  SELECT 'grant ' || x.privilege_type || CASE WHEN x.is_grantable THEN '+grant' ELSE '' END || ' on ' || c.relname || ' to ' || coalesce(r.rolname, 'PUBLIC')
    FROM rel c, aclexplode(coalesce(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND x.grantee <> c.relowner AND coalesce(r.rolname, '') NOT IN ('postgres', 'supabase_admin')
  UNION ALL
  SELECT 'grant ' || x.privilege_type || CASE WHEN x.is_grantable THEN '+grant' ELSE '' END || ' (' || a.attname || ') on ' || c.relname || ' to ' || coalesce(r.rolname, 'PUBLIC')
    FROM pg_attribute a JOIN rel c ON c.oid = a.attrelid, aclexplode(a.attacl) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
    WHERE a.attacl IS NOT NULL AND x.grantee <> c.relowner AND coalesce(r.rolname, '') NOT IN ('postgres', 'supabase_admin')
  UNION ALL
  SELECT 'grant EXECUTE' || CASE WHEN x.is_grantable THEN '+grant' ELSE '' END || ' on ' || f.sig || ' to ' || coalesce(r.rolname, 'PUBLIC')
    FROM fn f, aclexplode(coalesce(f.proacl, acldefault('f'::"char", f.proowner))) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
    WHERE x.grantee <> f.proowner AND coalesce(r.rolname, '') NOT IN ('postgres', 'supabase_admin')
)
SELECT regexp_replace(line, '\s*\n\s*', ' ', 'g') FROM lines ORDER BY 1;
