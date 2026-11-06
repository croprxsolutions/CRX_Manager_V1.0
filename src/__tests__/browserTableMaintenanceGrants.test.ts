import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Standing guard for 20261123130000: signed-in (authenticated) and anonymous (anon) users hold no
// TRUNCATE, TRIGGER or MAINTAIN on any public table or view, and new tables do not get them. A later
// migration that GRANTs one of them (or ALL, which includes them) to anon, authenticated or PUBLIC on a
// public table, on ALL TABLES IN SCHEMA public, or through ALTER DEFAULT PRIVILEGES re-opens that hole.
const root = process.cwd();
const MIGRATIONS = path.join(root, 'supabase/migrations');
const LOCK = '20261123130000_revoke_truncate_trigger_maintain.sql';

const strip = (sql: string) => sql.replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const NOT_TABLES = /^(FUNCTION|PROCEDURE|ROUTINE|SCHEMA|SEQUENCE|DATABASE|DOMAIN|TYPE|LANGUAGE|LARGE\s+OBJECT|FOREIGN\s+(DATA\s+WRAPPER|SERVER)|TABLESPACE|PARAMETER|ALL\s+(FUNCTIONS|PROCEDURES|ROUTINES|SEQUENCES)|FUNCTIONS|ROUTINES|SEQUENCES|TYPES|SCHEMAS)\b/i;
const unquote = (name: string) => name.trim().replace(/"/g, '');
/** True when a schema-qualified or bare relation name lives in public (bare names default to public). */
const inPublic = (name: string) => {
  const parts = unquote(name).split('.');
  return parts.length === 1 || parts[0].toLowerCase() === 'public';
};

const BROWSER = /\b(anon|authenticated|PUBLIC)\b/i;

/**
 * Every statement that grants TRUNCATE, TRIGGER, MAINTAIN or ALL on a public table (or all/future ones) to a
 * browser role, plus the two indirect routes: a role membership (e.g. pg_maintain) or ownership handed to one.
 * shortcut: text only, so a privilege list built in dynamic SQL is missed; the migration's postflight and the
 * live sweep `browser-table-maintenance` catch those.
 */
function maintenanceGrants(source: string): string[] {
  return strip(source).split(';').map((s) => s.replace(/\s+/g, ' ').trim()).filter((statement) => {
    if (/\bOWNER\s+TO\s+"?(anon|authenticated)"?(\s|$)/i.test(statement)) return true;
    const membership = /^GRANT\s+(?!.*\sON\s)(.+?)\s+TO\s+(.+)$/i.exec(statement);
    if (membership) return BROWSER.test(membership[2]);
    const grant = /\bGRANT\s+(.+?)\s+ON\s+(.+?)\s+TO\s+(.+)$/i.exec(statement);
    if (!grant) return false;
    const [, privileges, target, grantees] = grant;
    if (!/\b(TRUNCATE|TRIGGER|MAINTAIN|ALL)\b/i.test(privileges)) return false;
    if (!BROWSER.test(grantees)) return false;
    if (NOT_TABLES.test(target)) return false;
    const defaults = /^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(statement);
    const schemas = /\bIN\s+SCHEMA\s+(.+?)\s+(GRANT|REVOKE)\b/i.exec(statement)?.[1];
    if (defaults) return !schemas || schemas.split(',').some((s) => unquote(s).toLowerCase() === 'public');
    const all = /^ALL\s+TABLES\s+IN\s+SCHEMA\s+(.+)$/i.exec(target);
    if (all) return all[1].split(',').some((s) => unquote(s).toLowerCase() === 'public');
    return target.replace(/^TABLE\s+/i, '').split(',').some(inPublic);
  });
}

const later = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql') && name > LOCK)
  .map((name) => ({ name, sql: readFileSync(path.join(MIGRATIONS, name), 'utf8') }));

describe('browser roles: no TRUNCATE, TRIGGER or MAINTAIN on public tables (20261123130000)', () => {
  it('the lock revokes all three on every public table and in the postgres default privileges', () => {
    const lock = strip(readFileSync(path.join(MIGRATIONS, LOCK), 'utf8'));
    expect(lock).toMatch(/REVOKE TRUNCATE, TRIGGER, MAINTAIN ON ALL TABLES IN SCHEMA public FROM authenticated, anon;/);
    expect(lock).toMatch(/ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public\s+REVOKE TRUNCATE, TRIGGER, MAINTAIN ON TABLES FROM authenticated, anon;/);
    expect(maintenanceGrants(lock)).toEqual([]);
  });

  it('catches every re-opening shape (a bad sample fails the guard)', () => {
    for (const sql of [
      'GRANT TRUNCATE ON public.orders TO authenticated;',
      'GRANT TRIGGER ON TABLE orders TO anon;',
      'GRANT SELECT, MAINTAIN ON "public"."profiles" TO authenticated;',
      'GRANT ALL ON TABLE public.orders TO authenticated;',
      'GRANT ALL PRIVILEGES ON public.a, public.b TO PUBLIC;',
      'grant truncate on all tables in schema public to authenticated;',
      'GRANT MAINTAIN ON ALL TABLES IN SCHEMA "public" TO anon;',
      'ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT TRUNCATE ON TABLES TO authenticated;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon;',
      'ALTER DEFAULT PRIVILEGES GRANT TRIGGER ON TABLES TO authenticated;',
      'GRANT TRIGGER ON public.orders TO service_role, authenticated WITH GRANT OPTION;',
      'GRANT\n  TRUNCATE\n  ON public.orders\n  TO authenticated;',
      'GRANT pg_maintain TO authenticated;',
      'GRANT service_role TO anon;',
      'ALTER TABLE public.orders OWNER TO authenticated;',
      'ALTER VIEW public.v OWNER TO "anon";',
    ]) expect(maintenanceGrants(sql), sql).toHaveLength(1);
  });

  it('ignores the grants that stay allowed', () => {
    for (const sql of [
      'GRANT SELECT, INSERT, UPDATE, DELETE ON public.orders TO authenticated;',
      'GRANT ALL ON public.orders TO service_role;',
      'GRANT ALL ON FUNCTION public.f() TO authenticated;',
      'GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO authenticated;',
      'GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated;',
      'GRANT ALL ON SEQUENCE public.s TO authenticated;',
      'GRANT ALL ON SCHEMA public TO authenticated;',
      'GRANT ALL ON storage.objects TO authenticated;',
      'GRANT TRUNCATE ON ALL TABLES IN SCHEMA private TO authenticated;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;',
      'ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT ALL ON TABLES TO authenticated;',
      'REVOKE TRUNCATE ON public.orders FROM authenticated;',
      '-- GRANT TRUNCATE ON public.orders TO authenticated;',
      'GRANT authenticated TO authenticator;',
      'ALTER TABLE public.orders OWNER TO postgres;',
      'GRANT EXECUTE ON FUNCTION public.f() TO authenticated;',
    ]) expect(maintenanceGrants(sql), sql).toEqual([]);
  });

  it('no later migration grants them back', () => {
    expect(later.flatMap(({ name, sql }) => maintenanceGrants(sql).map((statement) => `${name}: ${statement}`))).toEqual([]);
  });
});
