#!/usr/bin/env node
// Read-only: prints the SQL the LIVE migration ledger recorded for each named migration, as JSON
// [{ name, statements }]. write-codex-push-proof.mjs uses it to recognise an added migration file
// that already ran live with identical text (applied history). Names must look like
// `<14 digits>_<lowercase words>`; anything else is refused before any request is sent.
import { pathToFileURL } from 'node:url';
import { readCredentialToken } from './supabase-credential.mjs';

const PROJECT_ID = 'rhyzpcqhnizqbxphqdkr';
export const MIGRATION_NAME_RE = /^\d{14}_[a-z0-9_]+$/;

export function ledgerStatementsQuery(names) {
  if (!names.length || !names.every((name) => MIGRATION_NAME_RE.test(name))) {
    throw new Error('migration names must look like <14 digits>_<lowercase words>');
  }
  const list = names.map((name) => `'${name}'`).join(', ');
  return `select name, statements from supabase_migrations.schema_migrations where name in (${list});`;
}

async function main() {
  const query = ledgerStatementsQuery(process.argv.slice(2));
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_ID}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${readCredentialToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, read_only: true }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('unexpected ledger reply');
  process.stdout.write(JSON.stringify(rows.map((row) => ({ name: row.name, statements: row.statements }))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
