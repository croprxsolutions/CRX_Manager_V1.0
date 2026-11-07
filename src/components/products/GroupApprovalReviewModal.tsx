import Button from '../ui/Button';
import Modal from '../ui/Modal';
import {
  CONFLICT_LABELS,
  SIZE_ROLE_LABELS,
  brandVariantText,
  brandVariants,
  conflictValueText,
  type ConflictField,
  type ApprovalEntry,
  type PriceChange,
  type ProposalGroup,
} from '../../lib/productParentProposals';
import type { ProductRatePerAcre } from '../../types';

export interface ApprovalReview {
  groups: ProposalGroup[];
  entries: ApprovalEntry[];
  changes: PriceChange[];
}

// The server's exact value, unrounded: approval refuses any per-acre price that differs from this preview.
function perAcre(prices: ProductRatePerAcre): string {
  return [prices.tier1_price_per_acre, prices.tier2_price_per_acre, prices.tier3_price_per_acre]
    .map((v) => (v == null ? '—' : `$${v}`))
    .join(' / ');
}

/** Which brands the shared parent list keeps, and which version of each, exactly as the approval sends them. */
function BrandDecisions({ group, entry }: { group: ProposalGroup; entry: ApprovalEntry }) {
  if (!entry.brands) return null;
  const variants = brandVariants(group);
  return (
    <ul className="list-disc pl-5 text-gray-800">
      {Object.entries(entry.brands).map(([name, pick]) => {
        const list = variants.get(name) ?? [];
        const kept = list.find((b) => b.brand_id === pick.source_brand_id);
        const label = list[0]?.brand_name ?? name;
        return (
          <li key={name}>
            Brand {label}: {pick.keep ? <>keep{kept ? ` (${brandVariantText(kept)})` : ''}</> : 'drop from the shared list'}
          </li>
        );
      })}
    </ul>
  );
}

interface GroupApprovalReviewModalProps {
  review: ApprovalReview | null;
  error: string | null;
  saving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

/** Shows exactly what an approval will write, so a batch is approved as shown (build sheet 5.1 step 4). */
export default function GroupApprovalReviewModal({ review, error, saving, onClose, onConfirm }: GroupApprovalReviewModalProps) {
  if (!review) return null;
  const count = review.entries.length;
  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      size="large"
      title={`Approve ${count} group${count === 1 ? '' : 's'}`}
      footer={(
        <div className="flex justify-end gap-2">
          <Button variant="secondary" disabled={saving} onClick={onClose}>Cancel</Button>
          <Button loading={saving} onClick={onConfirm}>Approve as shown</Button>
        </div>
      )}
    >
      <div className="space-y-4 text-sm">
        <p className="text-gray-700">
          Each group becomes one parent product. Every size keeps its ID, stock and history; only the values below
          are copied onto the sizes, and a per-acre price changes only where listed.
        </p>
        {review.entries.map((entry) => {
          const group = review.groups.find((g) => g.id === entry.group_id);
          if (!group) return null;
          return (
            <div key={entry.group_id} className="rounded-lg border border-gray-200 p-3 space-y-1">
              <p className="font-semibold text-gray-900">{entry.name}</p>
              {(Object.keys(entry.choices) as ConflictField[]).map((field) => (
                <p key={field} className="text-gray-800">
                  {CONFLICT_LABELS[field]}: <span className="font-medium">{conflictValueText(field, entry.choices[field])}</span>
                </p>
              ))}
              <BrandDecisions group={group} entry={entry} />
              <ul className="list-disc pl-5 text-gray-800">
                {group.members.map((m) => (
                  <li key={m.product_id}>
                    {m.product_name} · {SIZE_ROLE_LABELS[entry.size_roles[m.product_id]]}
                    {entry.totes[m.product_id] && (entry.totes[m.product_id].shop_filled ? ' · shop-filled from Bulk' : ' · vendor-filled')}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {review.changes.length > 0 ? (
          <div className="space-y-1">
            <p className="font-semibold text-gray-900">Per-acre prices that change (tier 1 / 2 / 3)</p>
            <ul className="space-y-1">
              {review.changes.map((c) => (
                <li key={c.productId} className="text-gray-800">
                  {c.productName}: {perAcre(c.before)} → <span className="font-medium">{perAcre(c.after)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-gray-700">No size's rate or per-acre price changes.</p>
        )}
        {error && <p role="alert" className="rounded-md bg-red-50 p-3 text-red-800">{error}</p>}
      </div>
    </Modal>
  );
}
