import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = join(process.cwd(), 'supabase', 'migrations');
const notice = readdirSync(migrations).find((name) => name.endsWith('_record_standard_delivery_assignment_notice.sql'));
if (!notice) throw new Error('Delivery assignment notice migration is missing');
const sql = readFileSync(join(migrations, notice), 'utf8').replace(/\r\n/g, '\n');

describe('standard delivery assignment notice boundary', () => {
  it('does not create a notice on a replay or take its actor from the client payload', () => {
    const fresh = sql.slice(sql.indexOf('IF v_replay IS NULL THEN'), sql.indexOf('RETURN v_result;'));
    expect(fresh).toContain('_bind_replay_receipt_20261015(');
    expect(fresh).toContain('INSERT INTO public.notifications');
    expect(fresh).toContain("'delivery_assigned', 'delivery', d.id, v_actor");
    expect(fresh).toContain("FROM public.deliveries AS d");
    expect(fresh).toContain('EXCEPTION WHEN OTHERS');
  });

  it('silently skips the same legacy notice only from the original actor', () => {
    expect(sql).toContain('notice.created_by = auth.uid()');
    expect(sql).toContain('notice.user_id = NEW.user_id');
    expect(sql).toContain('notice.related_entity_id = NEW.related_entity_id');
    expect(sql).toMatch(/THEN\s+RETURN NULL;/);
    expect(sql).toMatch(/WHEN \(\s*current_user = 'authenticated'\s+AND NEW.notification_type = 'delivery_assigned'/);
    expect(sql).toContain('FROM PUBLIC, anon, authenticated, service_role;');
  });
});
