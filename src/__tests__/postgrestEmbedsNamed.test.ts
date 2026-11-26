/**
 * postgrestEmbedsNamed.test.ts — KI-202. When a table has two links to the same
 * table (two foreign keys), an embed like `invoices ( ... )` is ambiguous and the
 * read fails with HTTP 300 (PGRST201). Every such embed must name its link:
 * `invoices!invoice_line_allocations_invoice_id_fkey ( ... )`.
 *
 * Reads the generated schema types for the links and scans every
 * `.from('table').select(`...`)` in src for top-level embeds that don't name one.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

// table -> referenced tables it links to more than once
function ambiguousLinks(): Map<string, Set<string>> {
  // A Windows checkout (core.autocrlf) has CRLF line ends; the block pattern below expects LF.
  const types = readFileSync(join(SRC, 'types/supabase.ts'), 'utf8').replace(/\r\n/g, '\n');
  const out = new Map<string, Set<string>>();
  const block = /\n {6}(\w+): \{\n {8}Row: \{[\s\S]*?Relationships: \[([\s\S]*?)\n {8}\]/g;
  for (const [, table, rels] of types.matchAll(block)) {
    const counts = new Map<string, number>();
    for (const [, ref] of rels.matchAll(/referencedRelation: "(\w+)"/g)) counts.set(ref, (counts.get(ref) ?? 0) + 1);
    const twice = [...counts].filter(([, n]) => n > 1).map(([ref]) => ref);
    if (twice.length) out.set(table, new Set(twice));
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === '__tests__' ? [] : sourceFiles(p);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !p.endsWith(join('types', 'supabase.ts')) ? [p] : [];
  });
}

// Top-level embed names in a select string, e.g. "invoices", "x:customers!fk".
function topLevelEmbeds(select: string): string[] {
  const names: string[] = [];
  let depth = 0;
  let token = '';
  for (const ch of select) {
    if (ch === '(') {
      if (depth === 0) {
        const m = token.match(/([\w!:]+)\s*$/);
        if (m) names.push(m[1].split(':').pop() as string);
      }
      depth += 1;
      token = '';
    } else if (ch === ')') {
      depth -= 1;
      token = '';
    } else if (ch === ',') token = '';
    else token += ch;
  }
  return names;
}

describe('PostgREST embeds name their link when a table has two (KI-202)', () => {
  it('finds the schema links it checks against', () => {
    expect(ambiguousLinks().get('invoice_line_allocations')?.has('invoices')).toBe(true);
  });

  it('every ambiguous top-level embed names its foreign key', () => {
    const amb = ambiguousLinks();
    const offenders: string[] = [];
    const call = /\.from\(\s*['"](\w+)['"]\s*\)\s*\.select\(\s*[`'"]([^`'"]*)[`'"]/g;
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(call)) {
        const [, table, select] = m;
        for (const embed of topLevelEmbeds(select)) {
          if (!embed.includes('!') && amb.get(table)?.has(embed)) {
            const line = text.slice(0, m.index).split('\n').length;
            offenders.push(`${file.slice(SRC.length + 1)}:${line} ${table} -> ${embed}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
