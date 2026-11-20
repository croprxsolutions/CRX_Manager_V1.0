import { useState } from 'react';
import { Star, Trash2 } from 'lucide-react';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import ConfirmModal from '../ui/ConfirmModal';
import Select from '../ui/Select';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useLatestRef } from '../../hooks/useLatestRef';
import { useLoad } from '../../hooks/useLoad';
import { logActivity } from '../../lib/activityLogger';
import { supabase } from '../../lib/db';
import { formatCents } from '../../lib/money';
import { fetchAllRows, pageWithList } from '../../lib/pagedRead';
import {
  linkProductVendor,
  listProductVendors,
  productVendorErrorMessage,
  unlinkProductVendor,
} from '../../lib/productVendors';
import type { ProductVendor } from '../../types';

interface ProductVendorsSectionProps {
  productId: string;
  productName: string;
  isAdmin: boolean;
  /** The signed-in user's profile id; only needed for admin edits. */
  userId: string | null;
  /** Called with the new preferred vendor's name; the database has already copied it onto the product. */
  onPreferredChanged: (vendorName: string) => void;
}

/** Every vendor an admin can add, page by page: one read stops silently at 1,000 rows. */
async function readVendorChoices(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await fetchAllRows((from, to) => pageWithList(supabase.from('vendors')
    .select('id, name', { count: 'exact' }).is('deleted_at', null).order('name').order('id').range(from, to)));
  if (error) throw error;
  if (!data) throw new Error('vendors read returned no list');
  return data;
}

interface VendorRowProps {
  vendor: ProductVendor;
  isAdmin: boolean;
  disabled: boolean;
  canMakePreferred: boolean;
  onMakePreferred: () => void;
  onRemove: () => void;
}

function VendorRow({ vendor: v, isAdmin, disabled, canMakePreferred, onMakePreferred, onRemove }: VendorRowProps) {
  return (
    <li className="flex flex-wrap items-center gap-2 py-2">
      <span className="font-medium text-gray-900">{v.vendor_name}</span>
      {v.is_preferred && <Badge variant="success" size="sm">Preferred</Badge>}
      {!v.item_details_known && <Badge variant="warning" size="sm">Item details not yet known</Badge>}
      {v.item_details_known && (
        <span className="text-xs text-gray-500">
          {[v.supplier_product_name, v.supplier_sku, v.supplier_pack_description].filter(Boolean).join(' · ')}
        </span>
      )}
      {isAdmin && v.last_cost_cents !== null && (
        <span className="text-xs text-gray-600">
          Last cost {formatCents(v.last_cost_cents)} per unit{v.last_cost_as_of ? ` (as of ${v.last_cost_as_of})` : ''}
        </span>
      )}
      {isAdmin && (
        <span className="ml-auto flex gap-1">
          {canMakePreferred && (
            <Button size="sm" variant="ghost" icon={<Star className="w-4 h-4" />} disabled={disabled} onClick={onMakePreferred}>
              Make preferred
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<Trash2 className="w-4 h-4" />} disabled={disabled || v.is_preferred}
            title={v.is_preferred ? 'Make another vendor preferred before removing this one' : undefined}
            onClick={onRemove}>
            Remove
          </Button>
        </span>
      )}
    </li>
  );
}

type Loaded<T> = ReturnType<typeof useLoad<T>>;

function LinkedStatus({ linked, isAdmin }: { linked: Loaded<ProductVendor[]>; isAdmin: boolean }) {
  if (linked.status === 'loading') return <p className="text-sm text-gray-500">Loading vendors…</p>;
  if (linked.status === 'failed') {
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-red-700">
        <span>{productVendorErrorMessage(linked.error)}</span>
        <Button size="sm" variant="secondary" onClick={() => void linked.reload()}>Try again</Button>
      </div>
    );
  }
  if (linked.status !== 'loaded') return null;
  return (
    <>
      {linked.stale && (
        <div role="alert" className="mb-2 flex flex-wrap items-center gap-2 text-sm text-amber-800">
          <span>Could not refresh the vendors. This list may be out of date.</span>
          <Button size="sm" variant="secondary" disabled={linked.refreshing} onClick={() => void linked.reload()}>Try again</Button>
        </div>
      )}
      {linked.data.length === 0 && (
        <p className="text-sm text-gray-500">No vendors linked yet.{isAdmin ? ' Add one below; the first becomes preferred.' : ''}</p>
      )}
    </>
  );
}

interface AddVendorBarProps {
  picker: Loaded<{ id: string; name: string }[]>;
  addable: { id: string; name: string }[];
  pick: string;
  onPick: (vendorId: string) => void;
  disabled: boolean;
  onAdd: () => void;
}

function AddVendorBar({ picker, addable, pick, onPick, disabled, onAdd }: AddVendorBarProps) {
  return (
    <div className="mt-3 flex flex-wrap items-end gap-2">
      <div className="min-w-[14rem] flex-1">
        <Select
          label="Add a vendor"
          value={pick}
          onChange={(e) => onPick(e.target.value)}
          placeholder="Choose a vendor"
          options={addable.map((v) => ({ value: v.id, label: v.name }))}
          disabled={disabled}
        />
      </div>
      <Button size="sm" disabled={disabled || !pick} onClick={onAdd}>
        Add vendor
      </Button>
      {picker.status === 'loading' && <p className="w-full text-sm text-gray-500">Loading the vendor list…</p>}
      {picker.status === 'failed' && (
        <div role="alert" className="flex w-full flex-wrap items-center gap-2 text-sm text-red-700">
          <span>Could not load the vendor list.</span>
          <Button size="sm" variant="secondary" onClick={() => void picker.reload()}>Try again</Button>
        </div>
      )}
    </div>
  );
}

/**
 * The vendors a product can be bought from (WP-PM-15b). Exactly one is preferred, and the product's
 * vendor name is a copy of it: the database keeps that copy and refuses to drop the preferred vendor.
 */
export default function ProductVendorsSection({ productId, productName, isAdmin, userId, onPreferredChanged }: ProductVendorsSectionProps) {
  const { toast } = useToast();
  // Costs come back only for admins, so a role change is a different read.
  const linked = useLoad(`vendors:${productId}:${isAdmin}`, () => listProductVendors(productId), {
    report: { extra: { context: 'product_vendors' } },
  });
  const picker = useLoad(isAdmin ? 'vendor-choices' : null, readVendorChoices, {
    report: { extra: { context: 'vendor_choices' } },
  });
  const vendors = linked.status === 'loaded' ? linked.data : null;
  const listUsable = linked.status === 'loaded' && !linked.stale && !linked.refreshing;
  const allVendors = picker.status === 'loaded' ? picker.data : [];
  const [pickedVendorId, setPickedVendorId] = useState('');
  const productRef = useLatestRef(productId);
  // The product a save is running for, so another product's controls stay usable.
  const [busyFor, setBusyFor] = useState<string | null>(null);
  const busy = busyFor === productId;
  const [removing, setRemoving] = useState<ProductVendor | null>(null);
  // A new product or role starts clean: no pick and no open removal (React's reset-on-prop-change pattern).
  // The picker list is re-read only after a role change, so this also drops a pick across a picker reload.
  const owner = `${productId}:${isAdmin}`;
  const [shownFor, setShownFor] = useState(owner);
  if (shownFor !== owner) {
    setShownFor(owner);
    setPickedVendorId('');
    setRemoving(null);
  }
  // Remove confirms one link of THIS product: switching product or losing admin closes it.
  const removable = isAdmin && removing !== null && (vendors ?? []).some((v) => v.link_id === removing.link_id);
  const actor = userId ?? '';
  const linkKeys = useIdempotencyKey('link_product_vendor', actor);
  const unlinkKeys = useIdempotencyKey('unlink_product_vendor', actor);

  const link = async (vendorId: string, makePreferred: boolean) => {
    if (!userId) return;
    const scope = `${productId}:${vendorId}:${makePreferred}`;
    setBusyFor(productId);
    try {
      await linkProductVendor(productId, vendorId, makePreferred, userId, linkKeys.getKeyFor(scope));
      linkKeys.resetKeyFor(scope);
      const name = allVendors.find((v) => v.id === vendorId)?.name ?? vendors?.find((v) => v.vendor_id === vendorId)?.vendor_name ?? 'Vendor';
      logActivity({
        event: makePreferred ? 'product_preferred_vendor_changed' : 'product_vendor_added',
        description: makePreferred ? `${name} is now the preferred vendor for ${productName}` : `${name} added as a vendor for ${productName}`,
        performedBy: userId,
        entityType: 'product',
        entityId: productId,
      });
      setPickedVendorId('');
      if (productRef.current !== productId) return; // the screen moved to another product; its own read is running
      // A first vendor becomes preferred even when not asked, so report whichever vendor now is.
      // If the re-read fails, a vendor just made preferred (or the first one, preferred by default) is still the one to show.
      const wasFirst = !vendors?.some((v) => v.is_preferred);
      const fresh = await linked.reload();
      if (fresh.status === 'skipped') return; // a newer read owns the list; guess nothing
      const preferred = (fresh.status === 'applied' ? fresh.data.find((v) => v.is_preferred)?.vendor_name : undefined)
        ?? (makePreferred || wasFirst ? name : null);
      if (preferred) onPreferredChanged(preferred);
    } catch (error) {
      toast('error', productVendorErrorMessage(error));
    } finally {
      setBusyFor((current) => (current === productId ? null : current));
    }
  };

  const unlink = async () => {
    if (!userId || !removing || !removable) return;
    const target = removing;
    setBusyFor(productId);
    try {
      await unlinkProductVendor(target.link_id, userId, unlinkKeys.getKeyFor(target.link_id));
      unlinkKeys.resetKeyFor(target.link_id);
      logActivity({
        event: 'product_vendor_removed',
        description: `${target.vendor_name} removed as a vendor for ${productName}`,
        performedBy: userId,
        entityType: 'product',
        entityId: productId,
      });
      setRemoving(null);
      await linked.reload();
    } catch (error) {
      toast('error', productVendorErrorMessage(error));
    } finally {
      setBusyFor((current) => (current === productId ? null : current));
    }
  };

  const linkedIds = new Set((vendors ?? []).map((v) => v.vendor_id));
  const addable = allVendors.filter((v) => !linkedIds.has(v.id));
  // A pick that is no longer offered (list reloaded, failed, or vendor now linked) is no pick.
  const pick = addable.some((v) => v.id === pickedVendorId) ? pickedVendorId : '';

  return (
    <Card>
      <CardHeader title="Vendors" />
      <LinkedStatus linked={linked} isAdmin={isAdmin} />
      {vendors !== null && vendors.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {vendors.map((v, i) => (
            <VendorRow key={v.link_id} vendor={v} isAdmin={isAdmin} disabled={busy || !listUsable}
              // One action per vendor: the server makes that vendor's best link preferred.
              canMakePreferred={!vendors.some((o, j) => o.vendor_id === v.vendor_id && (o.is_preferred || j < i))}
              onMakePreferred={() => void link(v.vendor_id, true)} onRemove={() => setRemoving(v)} />
          ))}
        </ul>
      )}
      {isAdmin && vendors !== null && (
        <AddVendorBar picker={picker} addable={addable} pick={pick} onPick={setPickedVendorId}
          disabled={busy || !listUsable} onAdd={() => void link(pick, false)} />
      )}
      <ConfirmModal
        open={removable}
        onClose={() => setRemoving(null)}
        onConfirm={() => void unlink()}
        title="Remove vendor"
        message={`Remove ${removing?.vendor_name ?? 'this vendor'} from ${productName}? Its price history stays.`}
        confirmLabel="Remove"
        variant="danger"
        loading={busy}
      />
    </Card>
  );
}
