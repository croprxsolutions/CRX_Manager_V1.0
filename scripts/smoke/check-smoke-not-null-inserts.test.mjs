import assert from 'node:assert/strict';
import { requiredColumnsFromMigrations, insertsIn, findMissing } from './check-smoke-not-null-inserts.mjs';

const mig = (name, sql) => ({ name, sql });
const req = (...migrations) => requiredColumnsFromMigrations(migrations);
const cols = (r, t) => [...(r.get(t)?.keys() ?? [])].sort();

// SET NOT NULL (single and multi-action ALTER, quoted, public., ONLY, IF EXISTS) marks the column required.
let r = req(
  mig('1', 'CREATE TABLE public.products (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, unit text, form text, note text);'),
  mig('2', 'ALTER TABLE ONLY public."products"\n  ALTER COLUMN unit SET NOT NULL,\n  ADD CONSTRAINT unit_ok CHECK (unit ~ \'x\');\nALTER TABLE IF EXISTS products ALTER form SET NOT NULL;'),
);
assert.deepEqual(cols(r, 'products'), ['form', 'unit'], 'SET NOT NULL marks columns; CREATE TABLE NOT NULL (name) is not tracked');
assert.equal(r.get('products').get('unit'), '2');

// A later DROP NOT NULL, SET DEFAULT, DROP COLUMN, or a default already present clears it.
r = req(
  mig('1', 'CREATE TABLE t (a text, b text, c text, d text DEFAULT \'x\');'),
  mig('2', 'ALTER TABLE t ALTER COLUMN a SET NOT NULL, ALTER COLUMN b SET NOT NULL, ALTER COLUMN c SET NOT NULL, ALTER COLUMN d SET NOT NULL;'),
  mig('3', 'ALTER TABLE t ALTER COLUMN a DROP NOT NULL; ALTER TABLE t ALTER COLUMN b SET DEFAULT \'y\'; ALTER TABLE t DROP COLUMN IF EXISTS c;'),
);
assert.deepEqual(cols(r, 't'), [], 'cleared by DROP NOT NULL / SET DEFAULT / DROP COLUMN; default from CREATE TABLE counts');

// ADD COLUMN NOT NULL without a default is required; with DEFAULT, GENERATED or serial it is not.
r = req(mig('1', `ALTER TABLE public.t
  ADD COLUMN IF NOT EXISTS a text NOT NULL,
  ADD COLUMN b text NOT NULL
    DEFAULT 'v1',
  ADD COLUMN c numeric(10, 2) NOT NULL GENERATED ALWAYS AS (1) STORED,
  ADD COLUMN d bigserial NOT NULL,
  ADD e uuid NOT NULL REFERENCES other(id);`));
assert.deepEqual(cols(r, 't'), ['a', 'e']);

// DEFAULT NULL is no default; a default dropped after SET NOT NULL makes it required; DDL inside DO blocks counts;
// a table rename carries its required columns.
r = req(
  mig('1', 'CREATE TABLE t (a text, b text DEFAULT \'x\', c text);'),
  mig('2', 'ALTER TABLE t ADD COLUMN d text NOT NULL DEFAULT NULL; ALTER TABLE t ALTER COLUMN b SET NOT NULL;'),
  mig('3', 'ALTER TABLE t ALTER COLUMN b DROP DEFAULT;'),
  mig('4', "DO $$ BEGIN IF true THEN ALTER TABLE public.t ALTER COLUMN c SET NOT NULL; END IF; END $$;"),
  mig('5', 'ALTER TABLE t RENAME TO t2;'),
);
assert.deepEqual(cols(r, 't'), []);
assert.deepEqual(cols(r, 't2'), ['b', 'c', 'd']);
assert.equal(r.get('t2').get('b'), '3', 'blames the migration that dropped the default');

// Dropping the default of a NOT NULL column (added by migration or by CREATE TABLE) makes it required;
// DEFAULT (NULL) is no default.
r = req(
  mig('1', "CREATE TABLE t (a text NOT NULL DEFAULT 'x', e text);"),
  mig('2', "ALTER TABLE t ADD COLUMN b text NOT NULL DEFAULT 'Gal', ADD COLUMN c text NOT NULL DEFAULT 'y';"),
  mig('3', 'ALTER TABLE t ALTER COLUMN b DROP DEFAULT, ALTER COLUMN a DROP DEFAULT, ALTER COLUMN e SET NOT NULL, ALTER COLUMN e SET DEFAULT (NULL);'),
);
assert.deepEqual(cols(r, 't'), ['a', 'b', 'e']);
assert.equal(r.get('t').get('a'), '3');
assert.equal(r.get('t').get('b'), '3', 'blames the migration that dropped the default');

// ADD PRIMARY KEY makes its columns NOT NULL.
r = req(mig('1', 'CREATE TABLE t (a text, b text);'), mig('2', 'ALTER TABLE t ADD CONSTRAINT t_pk PRIMARY KEY (a, b);'));
assert.deepEqual(cols(r, 't'), ['a', 'b']);

// Comments, strings and other schemas are ignored.
r = req(mig('1', "-- ALTER TABLE t ALTER COLUMN a SET NOT NULL;\nSELECT 'ALTER TABLE t ALTER COLUMN b SET NOT NULL;';\nALTER TABLE auth.users ALTER COLUMN c SET NOT NULL;"));
assert.equal(r.size, 0);

// INSERT parsing: prefix, quotes, alias, multi-line lists, INSERT ... SELECT, no column list, other schemas.
const ins = insertsIn(`DO $$ BEGIN
  INSERT INTO public.products (product_name,
    "inventory_unit") VALUES ('a', 'Gal');
  INSERT INTO products AS p (product_name) SELECT 'b';
  INSERT INTO "products"(product_name, product_form)
  SELECT x, y FROM src;
  INSERT INTO products VALUES ('c');
  INSERT INTO products SELECT v_row.*;
  INSERT INTO auth.users (id) VALUES (gen_random_uuid());
  INSERT INTO products DEFAULT VALUES;
  RAISE NOTICE 'two
lines';
  INSERT INTO ONLY products (product_name) VALUES ('e');
  -- INSERT INTO products (product_name) VALUES ('d');
  PERFORM 'INSERT INTO products (product_name) VALUES (1)';
END $$;`);
assert.deepEqual(ins.map((i) => [i.table, i.columns, i.line]), [
  ['products', ['product_name', 'inventory_unit'], 2],
  ['products', ['product_name'], 4],
  ['products', ['product_name', 'product_form'], 5],
  ['products', [], 7],
  ['products', null, 8],
  ['products', [], 10],
  ['products', ['product_name'], 13],
]);

// End to end: the inventory_unit case that broke staging (#2050 / #2057).
const required = req(
  mig('1', 'CREATE TABLE products (id uuid DEFAULT gen_random_uuid(), product_name text, inventory_unit text);'),
  mig('20270129171000_x.sql', 'ALTER TABLE public.products ALTER COLUMN inventory_unit SET NOT NULL, ADD CONSTRAINT k CHECK (true);'),
);
const failures = findMissing(required, [
  { name: 'broken.sql', sql: "\nINSERT INTO public.products (product_name)\nVALUES ('[E2E] x');" },
  { name: 'fixed.sql', sql: "INSERT INTO public.products (product_name, inventory_unit) VALUES ('[E2E] x', 'Gal');" },
]);
assert.deepEqual(failures, [{ file: 'broken.sql', line: 2, table: 'products', column: 'inventory_unit', migration: '20270129171000_x.sql' }]);

console.log('PASS: check-smoke-not-null-inserts tests');
