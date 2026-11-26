import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync('supabase/migrations/20270309020000_pricing_history_append_only.sql', 'utf8')
  .replaceAll('\r\n', '\n')
  .replace(/^--.*$/gm, '');

describe('pricing history append-only migration', () => {
  it('bounds the time waiting for locks and verifies the new triggers are enabled', () => {
    expect(sql.trimStart()).toMatch(/^SET LOCAL lock_timeout = '5s';/);
    expect(sql).toContain("AND t.tgenabled = 'O'");
  });

  it.each([
    ['cost_history', 'COST_HISTORY_APPEND_ONLY'],
    ['quote_price_changes', 'QUOTE_PRICE_HISTORY_APPEND_ONLY'],
  ])('guards updates, deletes and truncates of %s', (table, error) => {
    const fn = `public._${table}_append_only()`;
    expect(sql).toContain(`CREATE FUNCTION ${fn}\nRETURNS trigger\nLANGUAGE plpgsql\nSET search_path = public, pg_temp`);
    expect(sql).toContain(`RAISE EXCEPTION '${error}:`);
    expect(sql).toContain(`REVOKE ALL ON FUNCTION ${fn} FROM PUBLIC, anon, authenticated, service_role, metabase_ro;`);
    expect(sql).toContain(`CREATE TRIGGER trigger_${table}_append_only\n  BEFORE UPDATE OR DELETE ON public.${table}\n  FOR EACH ROW EXECUTE FUNCTION ${fn};`);
    expect(sql).toContain(`CREATE TRIGGER trigger_${table}_no_truncate\n  BEFORE TRUNCATE ON public.${table}\n  FOR EACH STATEMENT EXECUTE FUNCTION ${fn};`);
  });
});
