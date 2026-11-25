import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { approveLiquidDensityDraft, sourceText, type WeightDraft, type WeightSubject } from '../../lib/productWeights';
import type { LiquidDensityBrand } from '../../types';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';

export function LiquidDensityBrandList({ brands }: { brands: LiquidDensityBrand[] }) {
  if (brands.length === 0) return <p className="text-sm text-secondary">No active brands are listed for this group.</p>;
  return (
    <ul className="divide-y divide-gray-200 rounded-lg border border-gray-200">
      {brands.map((brand) => (
        <li key={brand.brand_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <div>
            <p className="font-medium text-nav-dark">{brand.brand_name}</p>
            <p className="text-xs text-secondary">{[brand.manufacturer, brand.epa_registration].filter(Boolean).join(' · ')}</p>
          </div>
          {brand.sds_url?.startsWith('https://') ? (
            <a href={brand.sds_url} target="_blank" rel="noopener noreferrer" aria-label={`Open SDS for ${brand.brand_name}`}
              className="inline-flex min-h-11 items-center gap-1 rounded px-2 font-medium text-blue-700 underline focus-visible:outline-2">
              SDS <ExternalLink size={14} aria-hidden="true" />
            </a>
          ) : <span className="text-xs text-secondary">No SDS link saved</span>}
        </li>
      ))}
    </ul>
  );
}

interface ApproveLiquidDensityDraftModalProps {
  subject: WeightSubject;
  draft: WeightDraft;
  brands: LiquidDensityBrand[];
  profileId: string;
  onClose: () => void;
  onDone: () => void;
}

export function ApproveLiquidDensityDraftModal({
  subject, draft, brands, profileId, onClose, onDone,
}: ApproveLiquidDensityDraftModalProps) {
  const { toast } = useToast();
  const [matches, setMatches] = useState(false);
  const [saving, setSaving] = useState(false);
  const { getKey, resetKey } = useIdempotencyKey('approve_liquid_density_draft', profileId,
    JSON.stringify([subject.subject_id, subject.version, draft.id, brands]));

  async function approve() {
    if (!matches || saving) return;
    setSaving(true);
    try {
      await approveLiquidDensityDraft(subject, draft.id, brands, true, getKey());
      resetKey();
      toast('success', 'Draft weight approved for the group');
      onDone();
    } catch (error: unknown) {
      toast('error', sanitizeError(error));
      if (hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_STALE) ||
          hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_BASIS_CHANGED) ||
          hasRpcCode(error, RpcErrorCodes.PRODUCT_WEIGHT_BRANDS_CHANGED)) onDone();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} closeDisabled={saving} title="Approve liquid draft weight?"
      footer={<>
        <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button type="button" disabled={!matches} loading={saving} onClick={() => void approve()}>Approve weight</Button>
      </>}>
      <div className="space-y-4">
        <p className="text-sm text-secondary">{draft.value} lb/gal from {sourceText(draft.source)} applies to every size of {subject.parent_name ?? 'this group'}.</p>
        <LiquidDensityBrandList brands={brands} />
        <label className="flex items-start gap-2 text-sm text-nav-dark">
          <input type="checkbox" checked={matches} disabled={saving} onChange={(event) => setMatches(event.target.checked)} />
          <span>I checked the current brands and confirmed this weight applies to the whole group.</span>
        </label>
        <p className="text-sm text-secondary">If a brand has a different weight, split the group in Product Setup before approving.</p>
      </div>
    </Modal>
  );
}
