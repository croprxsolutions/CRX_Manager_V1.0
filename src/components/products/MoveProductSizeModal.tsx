import { useState } from 'react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { formatExactUSD } from '../../lib/money';
import {
  moveProductSize, previewMoveProductSize, searchProductParents,
  type MoveSizePreview, type ProductParent, type ProductParentSize,
} from '../../lib/productParents';
import type { UseTimingOption } from '../../types';
import { OpenWorkList } from './ParentRatesModal';
import { ReasonField } from './ProductParentPanel';

const TIERS = [1, 2, 3] as const;
const text = (value: unknown) => (value == null || value === '' ? 'blank' : String(value));

/**
 * Moves one size to another parent of the same form. The size takes the new parent's category, use
 * timings, rates and EPA number; the save checks the preview so nothing changed underneath it.
 */
export default function MoveProductSizeModal({ parent, size, profileId, timingOptions, onClose, onSaved }: {
  parent: ProductParent;
  size: ProductParentSize;
  profileId: string;
  timingOptions: UseTimingOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<ProductParent[] | null>(null);
  const [target, setTarget] = useState<ProductParent | null>(null);
  const [preview, setPreview] = useState<MoveSizePreview | null>(null);
  const [sameFormulation, setSameFormulation] = useState(false);
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const [busy, setBusy] = useState(false);
  const { getKey, resetKey } = useIdempotencyKey('move_product_size', profileId,
    JSON.stringify([size.product_id, preview?.to_parent_id, preview?.size_fingerprint, reason.trim(), evidence.trim()]));

  const timingLabel = (codes: unknown) => {
    const list = Array.isArray(codes) ? codes as string[] : [];
    return list.length === 0 ? 'none' : list.map((code) => timingOptions.find((option) => option.code === code)?.label ?? code).join(', ');
  };
  const seedOrEach = parent.product_form === 'seed' || parent.product_form === 'each';
  // A seed or each size keeps its own stock unit as its rate unit, whatever the parent shows.
  const afterRateUnit = (movePreview: MoveSizePreview) => (seedOrEach ? movePreview.before.rate_unit : movePreview.after.rate_unit);

  const run = async (work: () => Promise<void>) => {
    setBusy(true);
    try {
      await work();
    } catch (error) {
      toast('error', sanitizeError(error));
      if (hasRpcCode(error, RpcErrorCodes.PRODUCT_PARENT_STALE) || hasRpcCode(error, RpcErrorCodes.PRODUCT_PARENT_SIZE_STALE)
        || hasRpcCode(error, RpcErrorCodes.PRODUCT_RATE_PREVIEW_CHANGED)) setPreview(null);
    } finally {
      setBusy(false);
    }
  };
  const find = () => run(async () => {
    setResults((await searchProductParents(search.trim())).filter((candidate) => candidate.id !== parent.id));
  });
  const choose = (candidate: ProductParent) => run(async () => {
    setTarget(candidate);
    setSameFormulation(false);
    setPreview(null);
    setPreview(await previewMoveProductSize(size.product_id, candidate.id));
  });
  const save = () => run(async () => {
    if (!preview || preview.refusal) return;
    await moveProductSize(size.product_id, preview, reason.trim(), evidence.trim(), getKey());
    resetKey();
    toast('success', `${size.product_name} moved to ${target?.name ?? 'the new parent'}`);
    onSaved();
  });

  const canSave = preview != null && !preview.refusal && sameFormulation && reason.trim() !== '' && evidence.trim() !== '' && !busy;
  const rows = preview ? [
    ['Category', preview.before.category, preview.after.category],
    ['Use timings', timingLabel(preview.before.use_timings), timingLabel(preview.after.use_timings)],
    ['Rate per acre', preview.before.rate_per_acre, preview.after.rate_per_acre],
    ['Rate unit', preview.before.rate_unit, afterRateUnit(preview)],
    ['Suggested rate', preview.before.suggested_rate, preview.after.suggested_rate],
    ['EPA number', preview.before.epa_registration, preview.after.epa_registration],
  ] as const : [];

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={busy}
      size="large"
      title={`Move ${size.product_name}`}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} loading={busy} disabled={!canSave}>Move size</Button>
        </>
      )}
    >
      <fieldset disabled={busy} className="space-y-3">
        <p className="text-sm text-secondary">Moves this size from {parent.name} to another parent of the same formulation. Use it to fix a size grouped under the wrong parent.</p>
        <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void find(); }}>
          <div className="flex-1">
            <Input id="move-size-search" label="Find the parent" value={search} onChange={(event) => setSearch(event.target.value)} />
          </div>
          <Button type="submit" variant="secondary" disabled={search.trim() === ''}>Search</Button>
        </form>
        {results && results.length === 0 && <p className="text-sm text-secondary">No other active parent matches.</p>}
        {results && results.length > 0 && (
          <ul className="max-h-40 divide-y overflow-y-auto rounded-lg border border-gray-200 text-sm">
            {results.map((candidate) => (
              <li key={candidate.id}>
                <button type="button" onClick={() => void choose(candidate)}
                  className={`w-full px-3 py-2 text-left hover:bg-gray-50 ${target?.id === candidate.id ? 'bg-gray-100 font-medium' : ''}`}>
                  {candidate.name}{candidate.nickname ? ` (${candidate.nickname})` : ''} · {candidate.product_form} · {candidate.sizes.length} size(s)
                </button>
              </li>
            ))}
          </ul>
        )}
        {preview?.refusal && <p className="text-sm text-red-600" role="alert">{sanitizeError(new Error(preview.refusal))}</p>}
        {preview && !preview.refusal && (
          <div className="space-y-3 text-sm">
            <table className="w-full text-left">
              <thead><tr className="text-secondary"><th className="font-medium">Value</th><th className="font-medium">Now</th><th className="font-medium">After the move</th></tr></thead>
              <tbody>
                {rows.map(([label, before, after]) => (
                  <tr key={label}><td className="pr-2">{label}</td><td className="pr-2">{text(before)}</td><td className="font-medium text-nav-dark">{text(after)}</td></tr>
                ))}
              </tbody>
            </table>
            {preview.prices && (
              <p className="text-secondary">
                Per-acre prices: {TIERS.map((tier) => {
                  const key = `tier${tier}_price_per_acre` as const;
                  const before = preview.before_prices?.[key];
                  const after = preview.prices?.[key];
                  return `Tier ${tier} ${before == null ? 'none' : formatExactUSD(before)} → ${after == null ? 'none' : formatExactUSD(after)}`;
                }).join(' · ')}
              </p>
            )}
            <OpenWorkList productIds={[size.product_id]} />
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={sameFormulation} onChange={(event) => setSameFormulation(event.target.checked)} />
              <span>I checked: {size.product_name} is the same formulation as {target?.name}.</span>
            </label>
            <ReasonField id="move-size-reason" label="Reason" value={reason} onChange={setReason} />
            <ReasonField id="move-size-evidence" label="Evidence (what shows it)" value={evidence} onChange={setEvidence} />
          </div>
        )}
      </fieldset>
    </Modal>
  );
}
