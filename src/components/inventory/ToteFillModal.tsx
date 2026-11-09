import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { isDefinitiveRpcRejection } from '../../lib/idempotency';
import { formatCents } from '../../lib/money';
import { fillToteFromBulk, previewToteFill, TOTE_FILL_LOCATION, type ToteFillPreview } from '../../lib/toteFill';

const qty = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 4 });

const COST_NOTE: Record<ToteFillPreview['cost_check'], string> = {
  equal: 'Bulk and tote catalog costs match per gallon.',
  differ: 'Bulk and tote catalog costs differ per gallon, so the estimate changes with this fill.',
  missing: 'A catalog cost is missing on the Bulk or the tote, so there is no estimate.',
};

/** What the fill would record: counts before and after, any shortfall, and the catalog estimate. */
function PreviewDetails({ shown }: { shown: ToteFillPreview }) {
  return (
    <div className="space-y-3" data-testid="tote-fill-preview">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-secondary">
            <th className="font-medium" />
            <th className="font-medium">Before</th>
            <th className="font-medium">After</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Bulk ({shown.bulk_unit})</td>
            <td>{qty(shown.bulk_before)}</td>
            <td className="font-medium text-nav-dark">{qty(shown.bulk_after)}</td>
          </tr>
          <tr>
            <td>Totes ({shown.tote_unit})</td>
            <td>{qty(shown.tote_before)}</td>
            <td className="font-medium text-nav-dark">{qty(shown.tote_after)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-sm text-secondary">
        Takes {qty(shown.bulk_quantity)} {shown.bulk_unit} of Bulk ({qty(shown.gallons)} gal) for {shown.totes} × {qty(shown.tote_size)} {shown.tote_size_unit} tote{shown.totes === 1 ? '' : 's'}, at {TOTE_FILL_LOCATION}.
      </p>
      {shown.shortfall > 0 && (
        <div className="flex gap-2 rounded border-l-4 border-amber-500 bg-amber-50 p-3 text-sm text-amber-800" role="alert">
          <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
          <span>
            Bulk is short {qty(shown.shortfall)} {shown.bulk_unit}. The fill still records, Bulk goes below zero,
            and the stock is flagged for the next count.
          </span>
        </div>
      )}
      <div className="rounded border border-gray-200 p-3 text-sm">
        <p className="font-medium text-nav-dark">Catalog estimate (not purchase cost)</p>
        {shown.estimate_before_cents != null && shown.estimate_after_cents != null && (
          <p>
            Value of Bulk and totes on hand: {formatCents(shown.estimate_before_cents)} before,{' '}
            {formatCents(shown.estimate_after_cents)} after.
          </p>
        )}
        <p className="text-secondary">{COST_NOTE[shown.cost_check]}</p>
        <p className="text-secondary">Purchase cost is not tracked yet; no cost is changed.</p>
      </div>
    </div>
  );
}

/**
 * Fill whole totes from the tote's Bulk (admins only). The admin previews first; the fill sends that
 * preview back and the database refuses it if stock, units, source or catalog cost changed since.
 */
export default function ToteFillModal({ toteProductId, toteName, profileId, onClose, onFilled }: {
  toteProductId: string;
  toteName: string;
  profileId: string;
  onClose: () => void;
  onFilled: () => void;
}) {
  const { toast } = useToast();
  const [totes, setTotes] = useState('1');
  const [preview, setPreview] = useState<ToteFillPreview | null>(null);
  const [busy, setBusy] = useState(false);
  // A fill whose answer was lost: it may have saved. Only the same preview and key may be resent,
  // so the database returns the first result instead of filling twice.
  const [unsure, setUnsure] = useState(false);
  const { getKey, resetKey } = useIdempotencyKey('fill_tote_from_bulk', profileId, JSON.stringify(preview));

  const toteCount = /^\d{1,4}$/.test(totes.trim()) ? Number(totes.trim()) : NaN;
  const totesValid = Number.isInteger(toteCount) && toteCount >= 1;
  const shown = preview?.totes === toteCount ? preview : null;

  const loadPreview = async () => {
    setBusy(true);
    try {
      setPreview(await previewToteFill(toteProductId, toteCount));
    } catch (error) {
      setPreview(null);
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!shown) return;
    setBusy(true);
    try {
      const result = await fillToteFromBulk(shown, getKey());
      resetKey();
      toast(result.requires_review ? 'warning' : 'success', result.requires_review
        ? `Filled. Bulk was short ${qty(result.shortfall)} ${result.bulk_unit}; flagged for the next count.`
        : `Filled ${shown.totes} tote${shown.totes === 1 ? '' : 's'} from ${qty(result.bulk_quantity)} ${result.bulk_unit} of Bulk.`);
      onFilled();
      onClose();
    } catch (error) {
      if (!isDefinitiveRpcRejection(error)) {
        setUnsure(true);
        toast('error', 'Could not tell whether the fill saved. Press Try Again: it will not fill twice.');
        return;
      }
      setUnsure(false);
      toast('error', sanitizeError(error));
      if (hasRpcCode(error, RpcErrorCodes.TOTE_FILL_PREVIEW_CHANGED)) {
        // Show what would be recorded now; the admin confirms again only after seeing it.
        setBusy(false);
        await loadPreview();
        return;
      }
    } finally {
      setBusy(false);
    }
  };

  // Closing on an unknown outcome refreshes the counts, so a fill that did save shows up.
  const close = () => { if (unsure) onFilled(); onClose(); };

  return (
    <Modal open onClose={close} closeDisabled={busy} title="Fill Tote" accent="from Bulk">
      <div className="space-y-4">
        <p className="text-sm text-secondary">{toteName}</p>
        <div className="flex items-end gap-2">
          <Input
            label="Totes to fill"
            type="number"
            min={1}
            step={1}
            value={totes}
            disabled={busy || unsure}
            onChange={(e) => { setTotes(e.target.value); setPreview(null); }}
            error={totes.trim() !== '' && !totesValid ? 'Whole totes only, 1 or more' : undefined}
          />
          <Button variant="secondary" onClick={loadPreview} loading={busy && !shown} disabled={!totesValid || busy || unsure}>
            Preview
          </Button>
        </div>

        {shown && <PreviewDetails shown={shown} />}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" showChevron={false} onClick={close} disabled={busy}>Cancel</Button>
          <Button onClick={confirm} loading={busy && Boolean(shown)} disabled={!shown || busy}>
            {unsure ? 'Try Again' : shown && shown.shortfall > 0 ? 'Fill Anyway' : 'Fill Tote'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
