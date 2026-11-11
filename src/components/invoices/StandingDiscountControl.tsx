import { useEffect, useRef, useState } from 'react';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { assertRpcResult, sanitizeError, supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';

/**
 * The office's standing discount on one chemical-sale draft (billing plan M4b; Mason 2026-11-09: "easy for the
 * office to change or remove it on a sale before it's posted"). set_invoice_standing_discount re-saves the draft
 * from the database, so it is locked while the editor has unsaved changes. Admin only (the caller shows it).
 */
export default function StandingDiscountControl({ invoiceId, disabled, onChanged }: {
  invoiceId: string;
  disabled: boolean;
  onChanged: () => void | Promise<void>;
}) {
  const { profile } = useAuth();
  const { toast } = useToast();
  const idem = useIdempotencyKey('set_invoice_standing_discount', profile?.id || '');
  const [rate, setRate] = useState<{ pct: number; office: boolean } | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // The invoice on screen now: a reply for another invoice (the page moved on) is dropped.
  const currentIdRef = useRef(invoiceId);

  const load = async () => {
    const forId = invoiceId;
    const { data, error } = await supabase
      .from('invoice_standing_discount_rates')
      .select('rate_pct, set_by')
      .eq('invoice_id', invoiceId)
      .maybeSingle();
    if (currentIdRef.current !== forId) return;
    if (error) { toast('error', sanitizeError(error)); return; }
    const row = data as { rate_pct: number | string; set_by: string | null } | null;
    const next = { pct: Number(row?.rate_pct ?? 0), office: !!row?.set_by };
    setRate(next);
    setDraft(String(next.pct));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { currentIdRef.current = invoiceId; setRate(null); void load(); }, [invoiceId]);

  const apply = async (pct: number | null) => {
    if (pct !== null && (!/^[0-9]{1,3}(\.[0-9]{1,2})?$/.test(draft.trim()) || pct > 100)) {
      toast('error', 'Enter a standing discount from 0 to 100%, with at most two decimals.');
      return;
    }
    const scope = `${invoiceId}:${pct ?? 'customer'}`;
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('set_invoice_standing_discount', {
        p_invoice_id: invoiceId, p_pct: pct, p_idempotency_key: idem.getKeyFor(scope),
      });
      if (error) throw error;
      assertRpcResult(data, 'set_invoice_standing_discount');
      idem.resetKeyFor(scope);
      toast('success', pct === null ? "This sale uses the customer's standing discount again" : `Standing discount for this sale set to ${pct}%`);
      if (currentIdRef.current !== invoiceId) return;
      await load();
      await onChanged();
    } catch (err: unknown) {
      Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { extra: { context: 'set_invoice_standing_discount' } });
      toast('error', sanitizeError(err));
    } finally {
      // Also when the page moved to another invoice meanwhile: that invoice's control must not stay locked.
      setSaving(false);
    }
  };

  if (!rate) return null;
  const locked = disabled || saving;
  return (
    <div className="space-y-2">
      <div className="flex items-end gap-2">
        <label className="flex-1 text-sm text-secondary">
          Standing discount for this sale (%)
          <input
            type="number"
            min={0}
            max={100}
            step={0.01}
            value={draft}
            disabled={locked}
            onChange={(e) => setDraft(e.target.value)}
            className="mt-1 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-nav-dark focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:bg-gray-50 disabled:opacity-50"
          />
        </label>
        <Button variant="secondary" size="sm" showChevron={false} loading={saving}
          disabled={locked || draft.trim() === '' || Number(draft) === rate.pct}
          onClick={() => apply(Number(draft))}>
          Apply
        </Button>
      </div>
      <p className="text-xs text-secondary">
        {disabled ? 'Save your changes first, then change the discount.'
          : rate.office ? 'Set for this sale.' : "The customer's rate when this sale was drafted."}
      </p>
      {rate.office && (
        <Button variant="ghost" size="sm" showChevron={false} disabled={locked} onClick={() => apply(null)}>
          Use the customer&apos;s rate
        </Button>
      )}
    </div>
  );
}
