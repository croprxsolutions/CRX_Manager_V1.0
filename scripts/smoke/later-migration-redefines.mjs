// Shared check for the real-schema provers' REDEFINED guards (#1910): does a later migration redefine, or rename
// something onto, a name the proof relies on? Comments are removed first (quote-aware, also inside function and DO
// bodies), so commented-out DDL no longer trips a guard; string literals and dollar-quoted code stay, so DDL inside
// a dynamic EXECUTE still counts. A rename (RENAME TO, RENAME COLUMN/CONSTRAINT ... TO) onto a guarded name counts too.
import { stripCommentsQuoteAware } from '../../.claude/hooks/live-testdata-lib.mjs';

// redefined: the prover's REDEFINED regex. guardedName: regex source matching a guarded name at its start.
export function laterMigrationRedefines(sql, redefined, guardedName) {
  const code = stripCommentsQuoteAware(String(sql), { intoDollarBodies: true });
  const renamedOnto = new RegExp(String.raw`\bRENAME\b[^;]*?\bTO\s+"?(?:${guardedName})`, 'i');
  return redefined.test(code) || renamedOnto.test(code);
}
