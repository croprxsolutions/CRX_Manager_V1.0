import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import Badge, { type BadgeVariant } from '../ui/Badge';
import Button from '../ui/Button';
import Input from '../ui/Input';
import {
  CONFLICT_LABELS,
  FLAG_LABELS,
  SIZE_ROLE_LABELS,
  approvalProblems,
  brandVariants,
  brandVariantText,
  conflictValueText,
  parentIsFertilizer,
  rateText,
  type ConflictField,
  type GroupDraft,
  type ProposalGroup,
  type ProposalMember,
  type SizeRole,
} from '../../lib/productParentProposals';

const STATUS_BADGE: Record<ProposalGroup['status'], { label: string; variant: BadgeVariant }> = {
  proposed: { label: 'Proposed', variant: 'info' },
  held: { label: 'Held', variant: 'warning' },
  rejected: { label: 'Rejected', variant: 'error' },
  approved: { label: 'Approved', variant: 'success' },
};

function sizeText(m: ProposalMember): string {
  return [m.container_size, m.container_unit].filter(Boolean).join(' ') || '—';
}

interface ProposalGroupCardProps {
  group: ProposalGroup;
  draft: GroupDraft | null;
  onDraftChange: (draft: GroupDraft) => void;
  selected: boolean;
  onSelectedChange: (selected: boolean) => void;
  onHold: () => void;
  onReject: () => void;
  onApprove: () => void;
  /** Grouping is switched off: approval would be refused, so it is not offered. */
  approveOff: boolean;
  busy: boolean;
  /** Names of the other groups in this proposal with the same EPA number. */
  sameEpaNames?: string[];
}

function MembersTable({ group }: { group: ProposalGroup }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-gray-600 border-b">
            <th className="py-1 pr-3">Size name</th>
            <th className="py-1 pr-3">SKU</th>
            <th className="py-1 pr-3">Size</th>
            <th className="py-1 pr-3">Stock unit</th>
            <th className="py-1 pr-3">Category</th>
            <th className="py-1 pr-3">Rate</th>
            <th className="py-1 pr-3">EPA No.</th>
            <th className="py-1 pr-3">Manufacturer</th>
            <th className="py-1 pr-3">Brands</th>
          </tr>
        </thead>
        <tbody>
          {group.members.map((m) => (
            <tr key={m.product_id} className="border-b last:border-0 align-top">
              <td className="py-1 pr-3 font-medium text-gray-900">
                {m.product_name}
                {!m.is_active && <Badge variant="default" size="sm" className="ml-2">Inactive</Badge>}
              </td>
              <td className="py-1 pr-3">{m.sku ?? '—'}</td>
              <td className="py-1 pr-3 whitespace-nowrap">{sizeText(m)}</td>
              <td className="py-1 pr-3">{m.inventory_unit ?? '—'}</td>
              <td className="py-1 pr-3">{m.category ?? '—'}</td>
              <td className="py-1 pr-3">{rateText(m)}</td>
              <td className="py-1 pr-3 whitespace-nowrap">{m.epa_registration ?? '—'}</td>
              <td className="py-1 pr-3">{m.manufacturer ?? '—'}</td>
              <td className="py-1 pr-3">{m.brands?.length ? m.brands.map((b) => b.brand_name).join(', ') : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ConflictPicks({ group, draft, onDraftChange }: { group: ProposalGroup; draft: GroupDraft; onDraftChange: (d: GroupDraft) => void }) {
  const fields = Object.keys(group.conflicts) as ConflictField[];
  if (fields.length === 0) return null;
  return (
    <div className="space-y-2">
      {fields.map((field) => (
        <fieldset key={field} className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <legend className="px-1 text-sm font-semibold text-amber-900">Sizes disagree on {CONFLICT_LABELS[field]}: pick the parent's value</legend>
          {(group.conflicts[field] ?? []).map((value, index) => (
            <label key={index} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${group.id}-${field}`}
                checked={draft.picks[field] === index}
                onChange={() => onDraftChange({ ...draft, picks: { ...draft.picks, [field]: index } })}
              />
              {conflictValueText(field, value)}
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

function SizeAnswers({ group, draft, onDraftChange }: { group: ProposalGroup; draft: GroupDraft; onDraftChange: (d: GroupDraft) => void }) {
  // The database records shop-filled only for a fertilizer parent with a Bulk size to fill from.
  const canShopFill = Object.values(draft.sizeRoles).includes('bulk') && parentIsFertilizer(group, draft);
  return (
    <div className="space-y-1">
      <p className="text-sm font-semibold text-gray-800">Size roles</p>
      {group.members.map((m) => {
        const role = draft.sizeRoles[m.product_id];
        const tote = draft.totes[m.product_id];
        return (
          <div key={m.product_id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-48 text-gray-900">{m.product_name}</span>
            <select
              aria-label={`Size role for ${m.product_name}`}
              className="rounded-md border border-gray-300 px-2 py-1 text-sm"
              value={role}
              onChange={(e) => onDraftChange({ ...draft, sizeRoles: { ...draft.sizeRoles, [m.product_id]: e.target.value as SizeRole } })}
            >
              {(Object.keys(SIZE_ROLE_LABELS) as SizeRole[]).map((r) => <option key={r} value={r}>{SIZE_ROLE_LABELS[r]}</option>)}
            </select>
            {role === 'fixed_tote' && (
              <select
                aria-label={`Tote answer for ${m.product_name}`}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                value={tote === undefined ? '' : tote ? 'shop' : 'vendor'}
                onChange={(e) => {
                  const totes = { ...draft.totes };
                  if (e.target.value === '') delete totes[m.product_id];
                  else totes[m.product_id] = e.target.value === 'shop';
                  onDraftChange({ ...draft, totes });
                }}
              >
                <option value="">Tote: choose…</option>
                <option value="vendor">Vendor-filled package</option>
                <option value="shop" disabled={!canShopFill && tote !== true}>Shop-filled from the Bulk size (fertilizer only)</option>
              </select>
            )}
          </div>
        );
      })}
    </div>
  );
}

function BrandPicks({ group, draft, onDraftChange }: { group: ProposalGroup; draft: GroupDraft; onDraftChange: (d: GroupDraft) => void }) {
  const variants = brandVariants(group);
  if (!group.flags.includes('brand_lists_differ') || variants.size === 0) return null;
  return (
    <fieldset className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
      <legend className="px-1 text-sm font-semibold text-amber-900">Brand lists differ: pick the parent's list</legend>
      {[...variants.entries()].map(([name, list]) => {
        const pick = draft.brands[name] ?? { keep: true, sourceBrandId: null };
        const set = (next: typeof pick) => onDraftChange({ ...draft, brands: { ...draft.brands, [name]: next } });
        return (
          <div key={name} className="flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1">
              <input type="checkbox" checked={pick.keep} onChange={(e) => set({ ...pick, keep: e.target.checked })} />
              Keep {list[0].brand_name}
            </label>
            {pick.keep && list.length > 1 && (
              <select
                aria-label={`Version of ${list[0].brand_name} to keep`}
                className="rounded-md border border-gray-300 px-2 py-1 text-sm"
                value={pick.sourceBrandId ?? ''}
                onChange={(e) => set({ ...pick, sourceBrandId: e.target.value || null })}
              >
                <option value="">Choose which version…</option>
                {list.map((b) => (
                  <option key={b.brand_id} value={b.brand_id}>
                    {brandVariantText(b)}
                  </option>
                ))}
              </select>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}

function DecisionControls(props: ProposalGroupCardProps & { draft: GroupDraft }) {
  const { group, draft, onDraftChange, busy } = props;
  const problems = approvalProblems(group, draft);
  return (
    // Locked while a preview or save runs, so the review always shows what the card shows.
    <fieldset disabled={busy} className="space-y-3 border-t pt-3">
      <Input
        label="Parent name"
        value={draft.name}
        maxLength={200}
        onChange={(e) => onDraftChange({ ...draft, name: e.target.value })}
      />
      <ConflictPicks group={group} draft={draft} onDraftChange={onDraftChange} />
      <SizeAnswers group={group} draft={draft} onDraftChange={onDraftChange} />
      <BrandPicks group={group} draft={draft} onDraftChange={onDraftChange} />
      {group.identity_basis === 'owner_confirmed' && (
        <label className="flex items-center gap-2 text-sm font-medium text-gray-900">
          <input
            type="checkbox"
            checked={draft.ownerConfirmed}
            onChange={(e) => onDraftChange({ ...draft, ownerConfirmed: e.target.checked })}
          />
          No size has an EPA number. I confirm these sizes are the same product.
        </label>
      )}
      {problems.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-red-600">
          {problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || problems.length > 0 || props.approveOff} title={props.approveOff ? 'Grouping is not switched on yet' : undefined} onClick={props.onApprove}>Approve this group</Button>
        <Button size="sm" variant="secondary" disabled={busy} onClick={props.onHold}>Hold…</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={props.onReject}>Reject…</Button>
      </div>
    </fieldset>
  );
}

export default function ProposalGroupCard(props: ProposalGroupCardProps) {
  const { group, draft, selected, onSelectedChange } = props;
  const [open, setOpen] = useState(false);
  const status = STATUS_BADGE[group.status];
  const ready = draft !== null && approvalProblems(group, draft).length === 0;
  return (
    <div className="rounded-lg border border-gray-200 bg-white">
      <div className="flex items-start gap-3 p-3">
        {group.status === 'proposed' && !props.approveOff && (
          <input
            type="checkbox"
            className="mt-1"
            aria-label={`Select ${group.suggested_name} for batch approval`}
            checked={selected}
            disabled={!ready || props.busy}
            title={ready ? undefined : 'Open the group and answer its questions first'}
            onChange={(e) => onSelectedChange(e.target.checked)}
          />
        )}
        <button type="button" className="flex flex-1 items-start gap-2 text-left" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className="flex-1 space-y-1">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold text-gray-900">{group.suggested_name}</span>
              <Badge variant={status.variant} size="sm">{status.label}</Badge>
              <span className="text-xs text-gray-600">
                {group.members.length} size{group.members.length === 1 ? '' : 's'} · {group.product_form ?? 'no form'} · EPA {group.generic_epa_registration ?? 'none'}
              </span>
            </span>
            <span className="block text-xs text-gray-600">{group.members.map((m) => m.product_name).join(' | ')}</span>
            {group.flags.length > 0 && (
              <span className="flex flex-wrap gap-1">
                {group.flags.map((f) => <Badge key={f} variant="warning" size="sm">{FLAG_LABELS[f] ?? f}</Badge>)}
              </span>
            )}
            {group.flags.includes('same_epa_different_name') && (props.sameEpaNames?.length ?? 0) > 0 && (
              <span className="block text-xs text-amber-800">
                Also EPA {group.generic_epa_registration}: {props.sameEpaNames?.join(', ')}
              </span>
            )}
            {group.reason &&<span className="block text-sm text-gray-800">Reason: {group.reason}</span>}
          </span>
        </button>
      </div>
      {open && (
        <div className="space-y-3 px-3 pb-3">
          <MembersTable group={group} />
          {group.status === 'proposed' && draft && <DecisionControls {...props} draft={draft} />}
        </div>
      )}
    </div>
  );
}
