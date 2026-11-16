import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { supabase, assertRpcResult } from '../../lib/db';
import Dropdown from './Dropdown';
import type { CommissionSplit } from '../../types';

// Fallback only — the live list comes from list_commission_recipients(),
// which returns every active commission-eligible profile the database-side
// validator will accept. Fallback entries carry no id; the database stamps
// recipient_user_id at save time (migration 20260722170000).
interface RecipientOption {
  id: string | null;
  full_name: string;
}

const FALLBACK_RECIPIENTS: RecipientOption[] = [
  { id: null, full_name: 'Mason Wells' },
  { id: null, full_name: 'Chance Tuttle' },
  { id: null, full_name: 'CMCTW LLC' },
  { id: null, full_name: 'Crop Rx Solutions' },
];

interface CommissionSplitEditorProps {
  value: CommissionSplit;
  onChange: (value: CommissionSplit) => void;
  label?: string;
  /** RAC controls ignore a disabled fieldset, so a locked form passes this too. */
  disabled?: boolean;
}

export default function CommissionSplitEditor({
  value,
  onChange,
  label = 'Commission Split',
  disabled,
}: CommissionSplitEditorProps) {
  const splits = value.splits;
  const total = splits.reduce((sum, s) => sum + (s.percentage || 0), 0);
  const isValid = Math.abs(total - 100) < 0.01;

  const [recipients, setRecipients] = useState<RecipientOption[]>(FALLBACK_RECIPIENTS);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data, error } = await supabase.rpc('list_commission_recipients');
        if (error) throw error;
        // Pre-20260722170000 the RPC returns { full_name } only; after it,
        // { id, full_name }. Accept both so deploy/apply order doesn't matter.
        const rows = assertRpcResult<{ id?: string | null; full_name: string | null }[]>(
          data,
          'list_commission_recipients'
        );
        if (cancelled || !Array.isArray(rows)) return;
        const options = rows
          .filter(
            (r): r is { id?: string | null; full_name: string } =>
              typeof r.full_name === 'string' && r.full_name.trim() !== ''
          )
          .map((r) => ({ id: typeof r.id === 'string' ? r.id : null, full_name: r.full_name }));
        if (options.length > 0) setRecipients(options);
      } catch {
        // Keep the fallback list — the dropdown must still work if the RPC
        // is unavailable (e.g. migration not yet applied).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSplit = (index: number, field: 'recipient' | 'percentage', val: string | number) => {
    const updated = splits.map((s, i) => {
      if (i !== index) return s;
      if (field === 'percentage') {
        return { ...s, percentage: typeof val === 'string' ? parseFloat(val) || 0 : val };
      }
      const name = String(val);
      // Carry the profile UUID when the picked option has one; a re-pick of a
      // legacy/fallback name clears any stale id so the DB re-resolves it.
      const picked = recipients.find((r) => r.full_name === name);
      return { ...s, recipient: name, recipient_user_id: picked?.id ?? null };
    });
    onChange({ splits: updated });
  };

  const addSplit = () => {
    onChange({ splits: [...splits, { recipient: '', percentage: 0 }] });
  };

  const removeSplit = (index: number) => {
    onChange({ splits: splits.filter((_, i) => i !== index) });
  };

  return (
    <div className="w-full">
      {label && (
        <label className="block text-sm font-medium text-secondary mb-1">
          {label}
        </label>
      )}
      <div className="space-y-1">
        {splits.map((split, i) => {
          // A stored value outside the known list (legacy data) still needs to
          // display; it stays selectable so the row isn't silently blanked.
          const isLegacy =
            split.recipient !== '' &&
            !recipients.some((r) => r.full_name === split.recipient);
          return (
            // items-start: the Dropdown keeps an empty helper line under its trigger.
            <div key={i} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <Dropdown
                  aria-label={`Recipient for split ${i + 1}`}
                  value={split.recipient || null}
                  onChange={(name) => updateSplit(i, 'recipient', name)}
                  placeholder="Select recipient..."
                  disabled={disabled}
                  options={[
                    ...recipients.map((r) => ({ value: r.full_name, label: r.full_name })),
                    ...(isLegacy ? [{ value: split.recipient, label: split.recipient }] : []),
                  ]}
                />
              </div>
              <div className="relative w-24 shrink-0">
                <input
                  type="number"
                  value={split.percentage || ''}
                  onChange={(e) => updateSplit(i, 'percentage', e.target.value)}
                  placeholder="0"
                  aria-label={`Commission percentage for split ${i + 1}`}
                  min="0"
                  max="100"
                  step="any"
                  className="w-full h-11 md:h-10 px-3 pr-7 text-sm text-nav-dark bg-white border border-gray-200 rounded-lg placeholder:text-gray-500 focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green transition-colors duration-150"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">%</span>
              </div>
              {splits.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeSplit(i)}
                  aria-label={`Remove split ${i + 1}`}
                  className="h-11 w-11 md:h-10 md:w-10 shrink-0 inline-flex items-center justify-center rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              )}
            </div>
          );
        })}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={addSplit}
            className="inline-flex min-h-11 md:min-h-10 items-center gap-1 text-xs font-medium text-crx-green hover:text-crx-green/80 transition-colors"
          >
            <Plus className="w-3 h-3" />
            Add Recipient
          </button>
          <span
            className={`text-xs font-medium ${
              splits.length === 0
                ? 'text-gray-400'
                : isValid
                  ? 'text-emerald-600'
                  : 'text-amber-600'
            }`}
          >
            Total: {total.toFixed(1)}%
            {splits.length > 0 && !isValid && ' (should be 100%)'}
          </span>
        </div>
      </div>
    </div>
  );
}
