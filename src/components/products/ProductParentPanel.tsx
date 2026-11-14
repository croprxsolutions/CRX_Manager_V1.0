import { useState } from 'react';
import { Link } from 'react-router-dom';
import Card, { CardHeader } from '../ui/Card';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import ConfirmModal from '../ui/ConfirmModal';
import Badge from '../ui/Badge';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { SIZE_ROLE_LABELS, updateProductParent, type ProductParent } from '../../lib/productParents';
import { visibleProductCategories } from '../../lib/productSetup';
import type { CropOption, ProductCategory, UseTimingOption } from '../../types';
import UseTimingPicker from './UseTimingPicker';
import ParentRatesModal from './ParentRatesModal';
import ParentIdentityModal from './ParentIdentityModal';
import MoveProductSizeModal from './MoveProductSizeModal';

export function ReasonField({ id, label, value, onChange }: { id: string; label: string; value: string; onChange: (value: string) => void }) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-secondary">{label} (required)</label>
      <textarea
        id={id}
        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
        rows={2}
        maxLength={1000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

const timingLabels = (codes: readonly string[] | null, options: readonly UseTimingOption[]) =>
  (codes ?? []).map((code) => options.find((option) => option.code === code)?.label ?? code).join(', ') || 'None';

function EditParentModal({ parent, profileId, categoryOptions, timingOptions, cropOptions, onClose, onSaved }: {
  parent: ProductParent;
  profileId: string;
  categoryOptions: ProductCategory[];
  timingOptions: UseTimingOption[];
  cropOptions: CropOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(parent.name);
  const [nickname, setNickname] = useState(parent.nickname ?? '');
  const [category, setCategory] = useState(parent.category ?? '');
  const [timings, setTimings] = useState<string[]>(parent.use_timings ?? []);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  // Only timings the chosen category takes stay selected; the rest would be cleared on every size.
  const allowed = new Set(timingOptions.filter((option) => option.category === category).map((option) => option.code));
  // While the options are still loading (or failed), no timing counts as cleared.
  const optionsLoaded = timingOptions.length > 0;
  const keptTimings = optionsLoaded ? timings.filter((code) => allowed.has(code)) : timings;
  const cleared = optionsLoaded ? (parent.use_timings ?? []).filter((code) => !allowed.has(code)) : [];
  const changes: Record<string, unknown> = {};
  if (name.trim() !== parent.name) changes.name = name.trim();
  if ((nickname.trim() || null) !== parent.nickname) changes.nickname = nickname.trim();
  if ((category || null) !== parent.category) changes.category = category;
  if ([...keptTimings].sort().join('\u0000') !== [...(parent.use_timings ?? [])].sort().join('\u0000')) changes.use_timings = keptTimings;
  const { getKey, resetKey } = useIdempotencyKey('update_product_parent', profileId,
    JSON.stringify([parent.id, parent.parent_version, changes, reason.trim()]));
  const canSave = name.trim() !== '' && reason.trim() !== '' && Object.keys(changes).length > 0 && !saving;

  const save = async () => {
    setConfirmClear(false);
    setSaving(true);
    try {
      await updateProductParent({ parentId: parent.id, expectedVersion: parent.parent_version, changes, reason: reason.trim(), key: getKey() });
      resetKey();
      toast('success', `Saved parent ${name.trim()} and all ${parent.sizes.length} size(s)`);
      onSaved();
    } catch (error) {
      toast('error', sanitizeError(error));
      if (hasRpcCode(error, RpcErrorCodes.PRODUCT_PARENT_STALE)) onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        closeDisabled={saving}
        title="Edit parent"
        footer={(
          <>
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button onClick={() => (cleared.length > 0 && 'use_timings' in changes ? setConfirmClear(true) : void save())} loading={saving} disabled={!canSave}>
              Save parent
            </Button>
          </>
        )}
      >
        <fieldset disabled={saving} className="space-y-3">
          <p className="text-sm text-secondary">
            Category and use timing are copied to all {parent.sizes.length} size(s). The change is logged with your reason.
          </p>
          <Input label="Parent name" required value={name} onChange={(event) => setName(event.target.value)} />
          <Input label="Nickname" value={nickname} onChange={(event) => setNickname(event.target.value)} />
          <div>
            <label htmlFor="parent-category" className="mb-1 block text-sm font-medium text-secondary">Category</label>
            <select id="parent-category" value={category} onChange={(event) => setCategory(event.target.value)}
              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-nav-dark focus-visible:ring-2 focus-visible:ring-crx-green">
              <option value="">-- Select --</option>
              {visibleProductCategories(categoryOptions, parent.category).map((item) => (
                <option key={item.name} value={item.name}>{item.name}{item.is_active ? '' : ' (retired)'}</option>
              ))}
            </select>
          </div>
          {allowed.size > 0 && (
            <fieldset>
              <legend className="mb-1 text-sm font-medium text-secondary">Use Timing</legend>
              <div className="space-y-1 rounded-lg border border-gray-200 bg-white p-2">
                <UseTimingPicker options={timingOptions} crops={cropOptions} category={category}
                  selected={keptTimings} held={parent.use_timings} onChange={setTimings} />
              </div>
            </fieldset>
          )}
          {cleared.length > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" role="status">
              {category || 'No category'} does not take these use timings, so saving clears them on every size: {timingLabels(cleared, timingOptions)}.
            </p>
          )}
          <ReasonField id="parent-edit-reason" label="Reason" value={reason} onChange={setReason} />
        </fieldset>
      </Modal>
      <ConfirmModal
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        onConfirm={() => void save()}
        title="Clear use timings?"
        message={`This clears ${timingLabels(cleared, timingOptions)} on all ${parent.sizes.length} size(s) of ${parent.name}.`}
        confirmLabel="Clear and save"
        variant="warning"
        loading={saving}
      />
    </>
  );
}

function parentRows(parent: ProductParent, seedOrEach: boolean, timingOptions: UseTimingOption[]): Array<[string, string]> {
  return [
    ['Category', parent.category ?? 'None'],
    ['Use timing', timingLabels(parent.use_timings, timingOptions)],
    ['Rate per acre', parent.rate_per_acre == null ? 'None' : `${parent.rate_per_acre} ${seedOrEach ? "(in each size's stock unit)" : parent.rate_unit ?? ''}`.trim()],
    ['Suggested rate', parent.suggested_rate ?? 'None'],
    ['Product form', parent.product_form],
    ['Formulation type', parent.formulation_type ?? 'Not recorded'],
    ['Safener', parent.safener ?? 'Not recorded'],
    ['EPA number', parent.generic_epa_registration ?? 'None'],
  ];
}

function SizeRow({ size, isThisSize, isAdmin, busy, blocked, onMove }: {
  size: ProductParent['sizes'][number]; isThisSize: boolean; isAdmin: boolean; busy: boolean; blocked: string | undefined; onMove: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
      {isThisSize
        ? <span className="font-medium text-nav-dark">{size.product_name} (this size)</span>
        : <Link to={`/products/${size.product_id}`} className="text-crx-green underline hover:text-crx-green-dark">{size.product_name}</Link>}
      {size.sku && <span className="text-xs text-secondary">{size.sku}</span>}
      <Badge variant="default">{SIZE_ROLE_LABELS[size.size_role] ?? size.size_role}</Badge>
      {!size.is_active && <Badge variant="warning">Inactive</Badge>}
      {isAdmin && (
        <Button size="sm" variant="secondary" showChevron={false} className="ml-auto" disabled={busy} title={blocked} onClick={onMove}>
          Move this size
        </Button>
      )}
    </li>
  );
}

/**
 * PAR-1 Parent panel on the product page: what the parent shares with every size, its sizes, and the
 * admin actions. Every write goes through the parent's own checked database call.
 */
export default function ProductParentPanel({
  parent, productId, isAdmin, profileId, ratesLocked, categoryOptions, timingOptions, cropOptions = [], rateUnitOptions, busy, onChanged,
}: {
  parent: ProductParent;
  productId: string;
  isAdmin: boolean;
  profileId: string;
  ratesLocked: boolean | null;
  categoryOptions: ProductCategory[];
  timingOptions: UseTimingOption[];
  /** Crop names for the picker's groups (USE-1); without them a group shows its crop code. */
  cropOptions?: CropOption[];
  rateUnitOptions: string[];
  /** Other unsaved edits on the page: parent actions wait for them. */
  busy: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<null | 'edit' | 'rates' | 'identity' | { move: string }>(null);
  const seedOrEach = parent.product_form === 'seed' || parent.product_form === 'each';
  const close = () => setOpen(null);
  const saved = () => { setOpen(null); onChanged(); };
  const blocked = busy ? 'Save or discard your other changes first' : undefined;

  const rows = parentRows(parent, seedOrEach, timingOptions);

  return (
    <Card>
      <CardHeader title="Parent" accent={parent.name} />
      <div className="space-y-4" data-testid="product-parent-panel">
        {parent.nickname && <p className="text-sm text-secondary">Nickname: <span className="text-nav-dark">{parent.nickname}</span></p>}
        {!parent.is_active && <Badge variant="warning">Inactive parent</Badge>}
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label}><dt className="text-secondary">{label}</dt><dd className="text-nav-dark">{value}</dd></div>
          ))}
        </dl>
        <p className="text-xs text-secondary">These values are shared by every size and change only here.</p>
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="secondary" showChevron={false} disabled={busy} title={blocked} onClick={() => setOpen('edit')}>Edit parent</Button>
            <Button size="sm" variant="secondary" showChevron={false} disabled={busy || ratesLocked === null} title={blocked}
              onClick={() => setOpen('rates')}>
              {ratesLocked ? 'Correct parent rates' : 'Parent rates'}
            </Button>
            <Button size="sm" variant="secondary" showChevron={false} disabled={busy} title={blocked} onClick={() => setOpen('identity')}>Correct identity</Button>
          </div>
        )}
        <div>
          <p className="mb-1 text-sm font-medium text-secondary">Sizes</p>
          <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
            {parent.sizes.map((size) => (
              <SizeRow key={size.product_id} size={size} isThisSize={size.product_id === productId} isAdmin={isAdmin} busy={busy}
                blocked={blocked} onMove={() => setOpen({ move: size.product_id })} />
            ))}
          </ul>
        </div>
      </div>
      {open === 'edit' && (
        <EditParentModal parent={parent} profileId={profileId} categoryOptions={categoryOptions} timingOptions={timingOptions} cropOptions={cropOptions}
          onClose={close} onSaved={saved} />
      )}
      {open === 'rates' && ratesLocked !== null && (
        <ParentRatesModal parent={parent} profileId={profileId} ratesLocked={ratesLocked} unitOptions={rateUnitOptions}
          onClose={close} onSaved={saved} />
      )}
      {open === 'identity' && <ParentIdentityModal parent={parent} profileId={profileId} onClose={close} onSaved={saved} />}
      {open !== null && typeof open === 'object' && (
        <MoveProductSizeModal
          parent={parent}
          size={parent.sizes.find((size) => size.product_id === open.move)!}
          profileId={profileId}
          timingOptions={timingOptions}
          onClose={close}
          onSaved={saved}
        />
      )}
    </Card>
  );
}
