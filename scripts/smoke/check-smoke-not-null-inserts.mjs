#!/usr/bin/env node

// A migration that makes a column required (ALTER COLUMN x SET NOT NULL, or ADD COLUMN x ... NOT NULL with no
// DEFAULT) breaks every live smoke chain that INSERTs into that table without naming x. It happened twice:
// 20270103140000 (products.product_form, fixed in #1802) and 20270129171000 (products.inventory_unit, #2057).
// This replays the migrations in order to find required-by-migration columns, then reads the INSERT column lists
// of every chain run-smoke.mjs can send to a real database (container-only chains replay an older fixed migration
// set, so they are skipped, as in #1802). Columns that were NOT NULL from CREATE TABLE are not tracked: chains were
// written against those, and some are filled by triggers.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Blank out quoted strings and comments in one left-to-right pass, keeping newlines so line numbers stay exact.
// Dollar-quoted bodies are kept: smoke chains are DO blocks. (Same pass as check-smoke-product-inserts-pricing-free.)
function stripStringsAndComments(sql) {
  return sql.replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (s) =>
    s.startsWith("'") ? `'${s.slice(1, -1).replace(/[^\n]/g, '')}'` : s.replace(/[^\n]/g, ' '),
  );
}

// A table name with an optional schema; only public (or unqualified) tables count.
const TABLE = String.raw`(?:("?)(\w+)\1\s*\.\s*)?"?(\w+)"?`;
const isPublic = (schema) => !schema || schema.toLowerCase() === 'public';
const ident = (s) => s.replace(/"/g, '').toLowerCase();

// Split on commas outside parentheses.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

// DEFAULT NULL is no default: an insert that omits the column still writes NULL.
const hasDefault = (def) => /\b(?:DEFAULT(?![\s(]*NULL\b)|GENERATED|(?:big|small)?serial\d?)\b/i.test(def);
const CONSTRAINT_WORDS = /^(?:CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE|LIKE)\b/i;

/**
 * Replay migration files (already in apply order) and return the columns a migration made required:
 * Map<table, Map<column, migrationName>>. A later DROP NOT NULL, SET DEFAULT, DROP COLUMN or table recreate clears one.
 */
export function requiredColumnsFromMigrations(migrations) {
  const state = new Map(); // table -> Map(column -> { notNull, hasDefault, requiredBy })
  const cols = (t) => state.get(t) ?? state.set(t, new Map()).get(t);
  const col = (t, c) => cols(t).get(c) ?? cols(t).set(c, { notNull: false, hasDefault: false, requiredBy: null }).get(c);

  for (const { name, sql } of migrations) {
    for (const stmt of stripStringsAndComments(sql).split(';')) {
      const create = stmt.match(new RegExp(String.raw`\bCREATE\s+(?:UNLOGGED\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${TABLE}\s*\(([\s\S]*)\)`, 'i'));
      if (create && isPublic(create[2])) {
        const t = ident(create[3]);
        if (/IF\s+NOT\s+EXISTS/i.test(stmt) && state.has(t)) continue;
        state.set(t, new Map());
        for (const el of splitTopLevel(create[4])) {
          if (CONSTRAINT_WORDS.test(el)) continue;
          const [, c] = el.match(/^"?(\w+)"?/) ?? [];
          if (c) Object.assign(col(t, ident(c)), { notNull: /\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/i.test(el), hasDefault: hasDefault(el.replace(/^"?\w+"?/, '')) });
        }
        continue;
      }
      const drop = stmt.match(new RegExp(String.raw`\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${TABLE}`, 'i'));
      if (drop && isPublic(drop[2])) {
        state.delete(ident(drop[3]));
        continue;
      }
      // Not anchored to the statement start: DDL inside a DO block or IF branch counts too.
      const alter = stmt.match(new RegExp(String.raw`\bALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${TABLE}\s+([\s\S]*)$`, 'i'));
      if (!alter || !isPublic(alter[2])) continue;
      const t = ident(alter[3]);
      for (const action of splitTopLevel(alter[4])) {
        let m;
        if ((m = action.match(/^ALTER\s+(?:COLUMN\s+)?"?(\w+)"?\s+(SET|DROP)\s+(NOT\s+NULL|DEFAULT)\b/i))) {
          const c = col(t, ident(m[1]));
          const on = m[2].toUpperCase() === 'SET';
          if (/^NOT/i.test(m[3])) {
            c.notNull = on;
            if (on) c.requiredBy = name; // counts once any default goes away, even in a later migration
          } else {
            c.hasDefault = on && hasDefault(action);
            if (!c.hasDefault && c.notNull) c.requiredBy = name; // dropping the default of a NOT NULL column
          }
        } else if ((m = action.match(/^ADD\s+(?:CONSTRAINT\s+"?\w+"?\s+)?PRIMARY\s+KEY\s*\(([^)]*)\)/i))) {
          for (const c of splitTopLevel(m[1]).map(ident)) Object.assign(col(t, c), { notNull: true, requiredBy: name });
        } else if ((m = action.match(/^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?\s+([\s\S]*)$/i)) && !CONSTRAINT_WORDS.test(m[1])) {
          if (/IF\s+NOT\s+EXISTS/i.test(action) && cols(t).has(ident(m[1]))) continue;
          const def = m[2];
          const notNull = /\bNOT\s+NULL\b|\bPRIMARY\s+KEY\b/i.test(def);
          cols(t).set(ident(m[1]), { notNull, hasDefault: hasDefault(def), requiredBy: notNull ? name : null });
        } else if ((m = action.match(/^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?"?(\w+)"?/i)) && !/^DROP\s+CONSTRAINT\b/i.test(action)) {
          cols(t).delete(ident(m[1]));
        } else if ((m = action.match(/^RENAME\s+TO\s+"?(\w+)"?/i))) {
          state.set(ident(m[1]), cols(t));
          state.delete(t);
        } else if ((m = action.match(/^RENAME\s+(?:COLUMN\s+)?"?(\w+)"?\s+TO\s+"?(\w+)"?/i))) {
          const c = cols(t).get(ident(m[1]));
          cols(t).delete(ident(m[1]));
          if (c) cols(t).set(ident(m[2]), c);
        }
      }
    }
  }

  const required = new Map();
  for (const [t, cs] of state) {
    for (const [c, s] of cs) {
      if (s.requiredBy && s.notNull && !s.hasDefault) (required.get(t) ?? required.set(t, new Map()).get(t)).set(c, s.requiredBy);
    }
  }
  return required;
}

/** Every INSERT INTO a public table in the SQL: { table, columns (null when no column list), line }. */
export function insertsIn(sql) {
  const code = stripStringsAndComments(sql);
  const out = [];
  const re = new RegExp(String.raw`\bINSERT\s+INTO\s+(?:ONLY\s+)?${TABLE}(?:\s+(?:AS\s+)?(?!VALUES\b|SELECT\b|DEFAULT\b|OVERRIDING\b|WITH\b)"?\w+"?)?\s*(\(([^)]*)\))?`, 'gi');
  for (const m of code.matchAll(re)) {
    if (!isPublic(m[2])) continue;
    // DEFAULT VALUES names no column. Positional VALUES may stop short of a newly added column, so it counts as naming
    // none (name the columns to pass). Only SELECT with no column list (a whole-row copy) is trusted to fill every column.
    const namesNone = !m[4] && /^\s*(?:DEFAULT\s+VALUES|VALUES)\b/i.test(code.slice(m.index + m[0].length));
    out.push({ table: ident(m[3]), columns: m[4] ? splitTopLevel(m[5]).map(ident) : namesNone ? [] : null, line: code.slice(0, m.index).split('\n').length });
  }
  return out;
}

export function findMissing(required, chains) {
  const failures = [];
  for (const { name, sql } of chains) {
    for (const ins of insertsIn(sql)) {
      const req = required.get(ins.table);
      // shortcut: INSERTs inside EXECUTE strings are not read (today only permission probes that expect a refusal); parse them if a chain builds fixtures that way.
      if (!req || !ins.columns) continue;
      for (const [c, migration] of req) {
        if (!ins.columns.includes(c)) failures.push({ file: name, line: ins.line, table: ins.table, column: c, migration });
      }
    }
  }
  return failures;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const migDir = path.join(root, 'supabase', 'migrations');
  const smokeDir = path.join(root, 'scripts', 'smoke');
  const migrations = readdirSync(migDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(path.join(migDir, f), 'utf8') }));
  const { specs } = JSON.parse(readFileSync(path.join(smokeDir, 'smoke-specs.json'), 'utf8'));
  // Same rule run-smoke.mjs uses: container-only chains never run against a real database.
  const chainFiles = [...new Set(Object.values(specs).filter((s) => !s.container_only).map((s) => s.chain))].sort();
  const chains = chainFiles.map((f) => ({ name: `scripts/smoke/${f}`, sql: readFileSync(path.join(smokeDir, f), 'utf8') }));

  const failures = findMissing(requiredColumnsFromMigrations(migrations), chains);
  if (failures.length) {
    console.error(`FAIL: ${failures.length} smoke-chain INSERT(s) leave out a column a migration made required (the chain dies with a NOT NULL error):`);
    for (const f of failures) console.error(`  ${f.file}:${f.line} INSERT INTO ${f.table} has no ${f.column} (required by ${f.migration})`);
    console.error('Name the column in each INSERT, or give the column a DEFAULT in the migration.');
    process.exit(1);
  }
  console.log(`PASS: ${chains.length} live smoke chains name every column a migration made required.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
