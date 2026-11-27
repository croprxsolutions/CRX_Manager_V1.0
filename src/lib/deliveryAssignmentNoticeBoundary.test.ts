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
    expect(fresh).toContain("public._record_standard_delivery_assignment_notice((v_result ->> 'delivery_id')::uuid, v_actor)");
    expect(sql).toContain("'delivery_assigned', 'delivery', d.id, p_actor");
    expect(sql).toContain('FROM public.deliveries AS d');
    expect(sql).toContain('EXCEPTION WHEN OTHERS');
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\._record_standard_delivery_assignment_notice\(uuid, uuid\)\s+FROM PUBLIC, anon, authenticated, service_role;/);
  });

  it('the newest create_delivery_with_items still sends the notice on a fresh save', () => {
    // A later replacement copied from an older body could drop the notice call with CI green.
    const define = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.create_delivery_with_items\s*\(/i;
    const newest = readdirSync(migrations).filter((n) => n.endsWith('.sql')).sort()
      .filter((n) => define.test(readFileSync(join(migrations, n), 'utf8'))).pop();
    expect(newest, 'no migration defines public.create_delivery_with_items').toBeDefined();
    const file = readFileSync(join(migrations, newest!), 'utf8').replace(/\r\n/g, '\n').replace(/--[^\n]*/g, '');
    const start = file.search(define);
    const body = file.slice(start, file.indexOf('$function$;', start));
    const fresh = body.slice(body.indexOf('IF v_replay IS NULL THEN'), body.indexOf('RETURN v_result;'));
    expect(fresh, `${newest}: fresh-save branch not found`).toContain('_bind_replay_receipt_20261015(');
    expect(fresh, `${newest}: a fresh save with a driver must send the notice`).toMatch(
      /IF\s+p_assigned_driver\s+IS\s+NOT\s+NULL\s+THEN\s+PERFORM\s+public\._record_standard_delivery_assignment_notice\(\s*\(v_result\s*->>\s*'delivery_id'\)::uuid,\s*v_actor\s*\);/,
    );
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
