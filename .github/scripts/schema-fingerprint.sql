-- One line per object in the public schema, the same on any database. db-apply.mjs `schema` runs it on
-- the target (staging) and on a database rebuilt from the repo, then diffs the lines. Catalog only (no
-- table data), so a read-only login with no table grants can run it. Owners are left out (the platform
-- and a restore can differ there); function and view bodies are compared by md5, byte for byte.
-- Fixed search_path: type and function names print the same whatever the login's own setting.
SET search_path = public;
WITH pub AS (SELECT oid FROM pg_namespace WHERE nspname = 'public'),
rel AS (SELECT c.* FROM pg_class c WHERE c.relnamespace = (SELECT oid FROM pub)),
fn AS (SELECT p.*, p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
       FROM pg_proc p WHERE p.pronamespace = (SELECT oid FROM pub)
         AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = p.oid AND d.deptype = 'e')),
lines AS (
  SELECT 'relation ' || relname || ' kind=' || relkind::text || ' rls=' || relrowsecurity || ' force=' || relforcerowsecurity AS line
    FROM rel WHERE relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
  UNION ALL
  SELECT 'column ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' not null' ELSE '' END
         || coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
         || CASE WHEN a.attgenerated::text <> '' THEN ' generated ' || a.attgenerated::text ELSE '' END
    FROM pg_attribute a JOIN rel c ON c.oid = a.attrelid
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'constraint ' || c.relname || '.' || k.conname || ' ' || pg_get_constraintdef(k.oid)
    FROM pg_constraint k JOIN rel c ON c.oid = k.conrelid
  UNION ALL
  SELECT 'index ' || pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN rel c ON c.oid = i.indexrelid
  UNION ALL
  SELECT 'trigger ' || pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN rel c ON c.oid = t.tgrelid WHERE NOT t.tgisinternal
  UNION ALL
  SELECT 'policy ' || tablename || '.' || policyname || ' ' || permissive || ' ' || cmd || ' to ' || array_to_string(roles, ',')
         || ' using ' || coalesce(qual, '-') || ' check ' || coalesce(with_check, '-')
    FROM pg_policies WHERE schemaname = 'public'
  UNION ALL
  SELECT 'view ' || relname || ' md5=' || md5(pg_get_viewdef(oid)) FROM rel WHERE relkind IN ('v', 'm')
  UNION ALL
  SELECT 'function ' || sig || ' kind=' || prokind::text
         || CASE WHEN prokind IN ('f', 'p') THEN ' md5=' || md5(pg_get_functiondef(oid)) ELSE '' END
    FROM fn
  UNION ALL
  SELECT 'enum ' || t.typname || ' ' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)
    FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typnamespace = (SELECT oid FROM pub) GROUP BY t.typname
  UNION ALL
  SELECT 'domain ' || typname || ' ' || format_type(typbasetype, typtypmod) || CASE WHEN typnotnull THEN ' not null' ELSE '' END
    FROM pg_type WHERE typnamespace = (SELECT oid FROM pub) AND typtype = 'd'
  UNION ALL
  -- Grants (who may read, write or call what), without the owner's own implicit rights.
  SELECT 'grant ' || x.privilege_type || ' on ' || c.relname || ' to ' || coalesce(r.rolname, 'PUBLIC')
    FROM rel c, aclexplode(coalesce(c.relacl, acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::"char", c.relowner))) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
    WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S') AND x.grantee <> c.relowner
  UNION ALL
  SELECT 'grant ' || x.privilege_type || ' (' || a.attname || ') on ' || c.relname || ' to ' || coalesce(r.rolname, 'PUBLIC')
    FROM pg_attribute a JOIN rel c ON c.oid = a.attrelid, aclexplode(a.attacl) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
    WHERE a.attacl IS NOT NULL AND x.grantee <> c.relowner
  UNION ALL
  SELECT 'grant EXECUTE on ' || f.sig || ' to ' || coalesce(r.rolname, 'PUBLIC')
    FROM fn f, aclexplode(coalesce(f.proacl, acldefault('f'::"char", f.proowner))) x
    LEFT JOIN pg_roles r ON r.oid = x.grantee
    WHERE x.grantee <> f.proowner
)
SELECT regexp_replace(line, '\s*\n\s*', ' ', 'g') FROM lines ORDER BY 1;
