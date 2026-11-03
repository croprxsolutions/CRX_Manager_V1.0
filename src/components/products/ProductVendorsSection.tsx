import { useCallback, useEffect, useState } from 'react';
import { Star, Trash2 } from 'lucide-react';
import Badge from '../ui/Badge';
import Button from '../ui/Button';
import Card, { CardHeader } from '../ui/Card';
import ConfirmModal from '../ui/ConfirmModal';
import Select from '../ui/Select';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { logActivity } from '../../lib/activityLogger';
import { supabase } from '../../lib/db';
import { formatCents } from '../../lib/money';
import {
  linkProductVendor,
  listProductVendors,
  productVendorErrorMessage,
  unlinkProductVendor,
} from '../../lib/productVendors';
import { Sentry } from '../../lib/sentry';
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

/**
 * The vendors a product can be bought from (WP-PM-15b). Exactly one is preferred, and the product's
 * vendor name is a copy of it: the database keeps that copy and refuses to drop the preferred vendor.
 */
export default function ProductVendorsSection({ productId, productName, isAdmin, userId, onPreferredChanged }: ProductVendorsSectionProps) {
  const { toast } = useToast();
  const [vendors, setVendors] = useState<ProductVendor[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [allVendors, setAllVendors] = useState<{ id: string; name: string }[]>([]);
  const [pickerError, setPickerError] = useState(false);
  const [pickedVendorId, setPickedVendorId] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ProductVendor | null>(null);
  const linkKeys = useIdempotencyKey('link_product_vendor', userId ?? '');
  const unlinkKeys = useIdempotencyKey('unlink_product_vendor', userId ?? '');

  const reload = useCallback(async (): Promise<ProductVendor[] | null> => {
    try {
      const list = await listProductVendors(productId);
      setVendors(list);
      setLoadError(null);
      return list;
    } catch (error) {
      Sentry.captureException(error);
      setLoadError(productVendorErrorMessage(error));
      return null;
    }
  }, [productId]);

  useEffect(() => { void reload(); }, [reload]);

  useEffect(() => {
    if (!isAdmin) return;
    supabase.from('vendors').select('id, name').is('deleted_at', null).order('name').then(({ data, error }) => {
      if (error) { Sentry.captureException(error); setPickerError(true); return; }
      setAllVendors(data ?? []);
    });
  }, [isAdmin]);

  const link = async (vendorId: string, makePreferred: boolean) => {
    if (!userId) return;
    const scope = `${productId}:${vendorId}:${makePreferred}`;
    setBusy(true);
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
      // A first vendor becomes preferred even when not asked, so report whichever vendor now is.
      // If the re-read fails, a vendor just made preferred (or the first one, preferred by default) is still the one to show.
      const wasFirst = !vendors?.some((v) => v.is_preferred);
      const preferred = (await reload())?.find((v) => v.is_preferred)?.vendor_name ?? (makePreferred || wasFirst ? name : null);
      if (preferred) onPreferredChanged(preferred);
    } catch (error) {
      toast('error', productVendorErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const unlink = async () => {
    if (!userId || !removing) return;
    const target = removing;
    setBusy(true);
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
      await reload();
    } catch (error) {
      toast('error', productVendorErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const linkedIds = new Set((vendors ?? []).map((v) => v.vendor_id));
  const addable = allVendors.filter((v) => !linkedIds.has(v.id));

  return (
    <Card>
      <CardHeader title="Vendors" />
      {loadError && <p className="text-sm text-red-700">{loadError}</p>}
      {!loadError && vendors === null && <p className="text-sm text-gray-500">Loading vendors…</p>}
      {vendors !== null && vendors.length === 0 && (
        <p className="text-sm text-gray-500">No vendors linked yet.{isAdmin ? ' Add one below; the first becomes preferred.' : ''}</p>
      )}
      {vendors !== null && vendors.length > 0 && (
        <ul className="divide-y divide-gray-100">
          {vendors.map((v) => (
            <li key={v.link_id} className="flex flex-wrap items-center gap-2 py-2">
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
                  {!v.is_preferred && (
                    <Button size="sm" variant="ghost" icon={<Star className="w-4 h-4" />} disabled={busy}
                      onClick={() => void link(v.vendor_id, true)}>
                      Make preferred
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon={<Trash2 className="w-4 h-4" />} disabled={busy || v.is_preferred}
                    title={v.is_preferred ? 'Make another vendor preferred before removing this one' : undefined}
                    onClick={() => setRemoving(v)}>
                    Remove
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {isAdmin && vendors !== null && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-[14rem] flex-1">
            <Select
              label="Add a vendor"
              value={pickedVendorId}
              onChange={(e) => setPickedVendorId(e.target.value)}
              placeholder="Choose a vendor"
              options={addable.map((v) => ({ value: v.id, label: v.name }))}
            />
          </div>
          <Button size="sm" disabled={busy || !pickedVendorId} onClick={() => void link(pickedVendorId, false)}>
            Add vendor
          </Button>
          {pickerError && <p className="w-full text-sm text-red-700">Could not load the vendor list. Reload the page to add a vendor.</p>}
        </div>
      )}
      <ConfirmModal
        open={removing !== null}
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
