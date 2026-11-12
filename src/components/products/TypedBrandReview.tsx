import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Card from '../ui/Card';
import Button from '../ui/Button';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { Sentry } from '../../lib/sentry';
import { getProductBrands, productBrandErrorMessage, saveProductBrand } from '../../lib/productBrands';
import { deliveryBrandErrorMessage, getTypedBrandsForReview, reviewTypedBrand, type TypedBrandForReview } from '../../lib/deliveryBrands';
import type { ProductBrand } from '../../types';

/**
 * Admin only (Brand PR B, B-2): brands a driver typed from the jug because they were not on the product's list.
 * "Add to list" saves the brand with the existing brand writer, then links the pick to it; "Link" points it at a
 * brand already listed; "Dismiss" closes it. Each step keeps its own retry key until it returns. Shown only when
 * something is waiting.
 */
export default function TypedBrandReview() {
  const { profile } = useAuth();
  const { toast } = useToast();
  const addIdem = useIdempotencyKey('upsert_product_brand', profile?.id || '');
  const reviewIdem = useIdempotencyKey('review_typed_brand', profile?.id || '');
  const [rows, setRows] = useState<TypedBrandForReview[]>([]);
  const [busyPick, setBusyPick] = useState<string | null>(null);
  // The brand list a "Link" choice is made from, per pick being linked.
  const [linking, setLinking] = useState<{ pickId: string; brands: ProductBrand[]; brandId: string } | null>(null);
  const requestRef = useRef(0);
  const linkRequestRef = useRef(0);
  const [loadFailed, setLoadFailed] = useState(false);

  const load = useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const next = await getTypedBrandsForReview();
      if (request === requestRef.current) { setRows(next); setLoadFailed(false); }
    } catch (error) {
      if (request === requestRef.current) setLoadFailed(true);
      Sentry.captureException(error, { level: 'warning', extra: { context: 'Typed brands for review could not be loaded' } });
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const link = async (row: TypedBrandForReview, brandId: string) => {
    const scope = JSON.stringify([row.pick_id, 'link', brandId]);
    await reviewTypedBrand(row.pick_id, 'link', brandId, reviewIdem.getKeyFor(scope));
    reviewIdem.resetKeyFor(scope);
  };

  const run = async (row: TypedBrandForReview, step: () => Promise<void>, done: string) => {
    if (busyPick) return;
    setBusyPick(row.pick_id);
    try {
      await step();
      toast('success', done);
      setLinking(null);
    } catch (error) {
      toast('error', deliveryBrandErrorMessage(error));
    } finally {
      // The row stays disabled until the list has refreshed, so a finished row is never clicked again.
      await load();
      setBusyPick(null);
    }
  };

  const addToList = (row: TypedBrandForReview) => run(row, async () => {
    const list = await getProductBrands(row.product_id);
    let added: ProductBrand;
    try {
      added = await saveProductBrand({
        productId: row.product_id,
        parentId: list.parentId,
        brandName: row.brand_name,
        epaRegistration: row.epa_registration ?? '',
        manufacturer: row.manufacturer ?? '',
        isCurrentlySourced: true,
        isRup: null,
        signalWord: null,
      }, addIdem.getKeyFor(row.pick_id));
    } catch (error) {
      throw new Error(productBrandErrorMessage(error));
    }
    await link(row, added.id);
    // Kept until the link succeeds too: retrying after a failed link replays the same add, never a second brand.
    addIdem.resetKeyFor(row.pick_id);
  }, `${row.brand_name} added to the list.`);

  const startLink = async (row: TypedBrandForReview) => {
    const request = ++linkRequestRef.current;
    try {
      const list = await getProductBrands(row.product_id);
      if (request === linkRequestRef.current) setLinking({ pickId: row.pick_id, brands: list.brands, brandId: '' });
    } catch (error) {
      if (request === linkRequestRef.current) toast('error', productBrandErrorMessage(error));
    }
  };

  const dismiss = (row: TypedBrandForReview) => run(row, async () => {
    const scope = JSON.stringify([row.pick_id, 'dismiss']);
    await reviewTypedBrand(row.pick_id, 'dismiss', null, reviewIdem.getKeyFor(scope));
    reviewIdem.resetKeyFor(scope);
  }, 'Dismissed.');

  if (rows.length === 0) {
    if (!loadFailed) return null;
    return (
      <Card>
        <p className="text-sm text-amber-800">
          Brands to review could not be loaded.{' '}
          <button type="button" className="font-medium underline" onClick={() => void load()}>Try again</button>
        </p>
      </Card>
    );
  }

  return (
    <Card>
      <h2 className="font-heading text-lg font-semibold text-nav-dark">Brands to review</h2>
      <p className="mb-3 text-sm text-secondary">Drivers typed these brands because they were not on the product's list.</p>
      {loadFailed && (
        <p className="mb-3 text-sm text-amber-800">
          This list could not be refreshed and may be out of date.{' '}
          <button type="button" className="font-medium underline" onClick={() => void load()}>Try again</button>
        </p>
      )}
      <ul className="divide-y divide-gray-100">
        {rows.map((row) => {
          const busy = busyPick === row.pick_id;
          const linkOpen = linking?.pickId === row.pick_id;
          return (
            <li key={row.pick_id} className="space-y-2 py-3">
              <p className="text-sm text-nav-dark">
                <span className="font-medium">{row.brand_name}</span>
                {row.epa_registration ? ` · EPA ${row.epa_registration}` : ' · no EPA number'}
                {row.manufacturer ? ` · ${row.manufacturer}` : ''}
                {' for '}{row.product_name || 'a product'} ({row.quantity}) on{' '}
                <Link to={`/deliveries/${row.delivery_id}`} className="text-crx-green underline">{row.delivery_number || 'a delivery'}</Link>
              </p>
              {row.review_note === 'number_differs_from_list' && (
                <p className="text-sm text-amber-800">The name is on the list, but with a different EPA number.</p>
              )}
              {linkOpen ? (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    aria-label={`Listed brand to link ${row.brand_name} to`}
                    className="min-h-11 rounded-lg border border-gray-300 px-3 text-sm"
                    value={linking.brandId}
                    disabled={busy}
                    onChange={(e) => setLinking({ ...linking, brandId: e.target.value })}
                  >
                    <option value="">Pick a listed brand…</option>
                    {linking.brands.map((b) => <option key={b.id} value={b.id}>{b.brand_name}{b.epa_registration ? ` · EPA ${b.epa_registration}` : ''}</option>)}
                  </select>
                  <Button size="sm" disabled={!linking.brandId || busy} loading={busy}
                    onClick={() => void run(row, () => link(row, linking.brandId), 'Linked.')}>Link</Button>
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => { linkRequestRef.current++; setLinking(null); }}>Cancel</Button>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" disabled={!!busyPick} loading={busy} onClick={() => void addToList(row)}>Add to list</Button>
                  <Button size="sm" variant="secondary" disabled={!!busyPick} onClick={() => void startLink(row)}>Link to existing</Button>
                  <Button size="sm" variant="ghost" disabled={!!busyPick} onClick={() => void dismiss(row)}>Dismiss</Button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
