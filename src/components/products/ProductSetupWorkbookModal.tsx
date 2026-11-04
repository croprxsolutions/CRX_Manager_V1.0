import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { sanitizeError } from '../../lib/db';
import { formatExactUSD } from '../../lib/money';
import { listProductUseTimingOptions } from '../../lib/productUseTimings';
import {
  applyProductSetup,
  buildSetupPreview,
  editedRateRows,
  generateSetupWorkbook,
  loadSetupWorkbookExport,
  MAX_SETUP_WORKBOOK_SAVE_ROWS,
  parseSetupWorkbook,
  previewProductRates,
  saveProductRates,
  type RatePreview,
  type RatePreviewRow,
  type RateUploadRow,
  type SetupPreview,
} from '../../lib/productSetupWorkbook';

const TIERS = [1, 2, 3] as const;
const money = (value: number | null | undefined) => (value == null ? 'none' : formatExactUSD(value));
const RATE_PROBLEM: Record<string, string> = {
  stale: 'changed by someone else since you downloaded it',
  invalid_rate: 'rate must be blank or a number of 0 or more, up to 6 decimals',
  invalid_unit: 'rate unit is missing or not a known unit for this product\'s form',
  not_found: 'product not found',
};
const rateText = (r: RatePreviewRow['before']) =>
  r ? `${r.rate_per_acre ?? '(blank)'} ${r.rate_unit ?? ''}${r.suggested_rate ? ` · "${r.suggested_rate}"` : ''}`.trim() : '';

/**
 * The setup workbook (WP-PM-11a-2): product details and rates in one spreadsheet, separate from the
 * price sheet. Each tab is previewed and confirmed on its own; nothing saves until its Confirm.
 */
export default function ProductSetupWorkbookModal({ open, profileId, onClose, onSaved }: {
  open: boolean;
  profileId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');
  const [setup, setSetup] = useState<SetupPreview | null>(null);
  const [rates, setRates] = useState<{ rows: RateUploadRow[]; preview: RatePreview | null } | null>(null);
  const [setupSaved, setSetupSaved] = useState<string[] | null>(null);
  const [ratesSaved, setRatesSaved] = useState<number | null>(null);
  const setupKey = useIdempotencyKey('apply_product_setup', profileId, JSON.stringify([fileName, setup?.changes.map((c) => c.product_id)]));
  const ratesKey = useIdempotencyKey('set_product_rates', profileId, JSON.stringify([fileName, rates?.rows.map((r) => r.product_id)]));

  const reset = () => {
    setSetup(null); setRates(null); setSetupSaved(null); setRatesSaved(null); setFileName('');
  };
  const close = () => {
    if (setupSaved || ratesSaved != null) onSaved();
    reset();
    onClose();
  };

  const download = async () => {
    setBusy(true);
    try {
      const [exported, options] = await Promise.all([loadSetupWorkbookExport(), listProductUseTimingOptions()]);
      const blob = await generateSetupWorkbook(exported, options);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `crx-product-setup-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    reset();
    setBusy(true);
    try {
      const parsed = await parseSetupWorkbook(await file.arrayBuffer());
      const [current, options] = await Promise.all([loadSetupWorkbookExport(), listProductUseTimingOptions()]);
      const setupPreview = buildSetupPreview(parsed.setupRows, current, options);
      const rateRows = editedRateRows(parsed.rateRows);
      if (setupPreview.changes.length > MAX_SETUP_WORKBOOK_SAVE_ROWS || rateRows.length > MAX_SETUP_WORKBOOK_SAVE_ROWS) {
        throw new Error(`Save at most ${MAX_SETUP_WORKBOOK_SAVE_ROWS} changed rows per tab at a time.`);
      }
      setSetup(setupPreview);
      setRates({ rows: rateRows, preview: rateRows.length > 0 ? await previewProductRates(rateRows) : null });
      setFileName(file.name);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const confirmSetup = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      const saved = await applyProductSetup({ rows: setup.changes, performedBy: profileId, idempotencyKey: setupKey.getKey() });
      setupKey.resetKey();
      setSetupSaved(saved.rows.map((row) => row.product_name));
      toast('success', `Saved setup changes to ${saved.changed_count} products`);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmRates = async () => {
    if (!rates?.preview) return;
    setBusy(true);
    try {
      const saved = await saveProductRates({ preview: rates.preview, rows: rates.rows, performedBy: profileId, idempotencyKey: ratesKey.getKey() });
      ratesKey.resetKey();
      setRatesSaved(saved.changed_count);
      toast('success', `Saved rates for ${saved.changed_count} products`);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const rateChanges = rates?.preview?.rows.filter((r) => r.status === 'change') ?? [];
  const rateProblems = rates?.preview?.rows.filter((r) => r.status !== 'change' && r.status !== 'unchanged') ?? [];
  const setupBlocked = !setup || setup.changes.length === 0 || setup.stale.length > 0 || setup.invalid.length > 0;
  const ratesBlocked = rateChanges.length === 0 || rateProblems.length > 0 || Boolean(rates?.preview?.rates_locked);

  return (
    <Modal open={open} onClose={close} closeDisabled={busy} title="Setup workbook" size="large"
      footer={<Button variant="secondary" onClick={close} disabled={busy}>Close</Button>}>
      <div className="space-y-4 text-sm">
        <p className="text-secondary">
          Product details and rates in one spreadsheet, separate from the price sheet. Edit the green columns, then upload it here.
          Each tab is previewed and saved on its own; nothing saves until you confirm that tab.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={() => void download()} loading={busy}>
            Download setup workbook
          </Button>
          <Button variant="secondary" icon={<Upload className="w-4 h-4" />} onClick={() => fileRef.current?.click()} disabled={busy}>
            Upload and preview
          </Button>
          <input ref={fileRef} type="file" className="hidden" aria-label="Setup workbook file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
        </div>

        {setup && (
          <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Setup tab preview">
            <h3 className="font-semibold text-nav-dark">Setup tab: {setup.changes.length} products to change</h3>
            {[...setup.stale, ...setup.invalid].map((p) => (
              <p key={p.product_id} className="text-red-700">{p.product_name}: {p.problem}</p>
            ))}
            {(setup.stale.length > 0 || setup.invalid.length > 0) && (
              <p className="text-red-700">Fix these rows, or download a fresh workbook, before saving this tab.</p>
            )}
            {setup.changes.length > 0 && (
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-left">
                  <thead><tr className="text-secondary"><th className="font-medium">Product</th><th className="font-medium">Field</th><th className="font-medium">Now</th><th className="font-medium">New</th></tr></thead>
                  <tbody>
                    {setup.changes.flatMap((row) => row.display.map((d) => (
                      <tr key={`${row.product_id}-${d.field}`}><td>{row.product_name}</td><td>{d.field}</td><td>{d.before}</td><td className="font-medium text-nav-dark">{d.after}</td></tr>
                    )))}
                  </tbody>
                </table>
              </div>
            )}
            {setupSaved
              ? <p className="text-green-700">Saved: {setupSaved.join(', ')}</p>
              : <Button onClick={() => void confirmSetup()} loading={busy} disabled={setupBlocked}>Confirm Setup tab</Button>}
          </section>
        )}

        {rates && (
          <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Rates tab preview">
            <h3 className="font-semibold text-nav-dark">Rates tab: {rateChanges.length} products to change</h3>
            {rates.preview?.rates_locked && (
              <p className="text-red-700">Rates are locked. An admin can correct one product at a time from its product page, with a reason.</p>
            )}
            {rateProblems.map((p) => (
              <p key={p.product_id} className="text-red-700">{p.product_name ?? p.product_id}: {RATE_PROBLEM[p.status]}</p>
            ))}
            {rateChanges.length > 0 && (
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-left">
                  <thead><tr className="text-secondary"><th className="font-medium">Product</th><th className="font-medium">Rate now → new</th>
                    {TIERS.map((t) => <th key={t} className="font-medium">Tier {t} per acre</th>)}</tr></thead>
                  <tbody>
                    {rateChanges.map((r) => (
                      <tr key={r.product_id}>
                        <td>{r.product_name}</td>
                        <td>{rateText(r.before)} → <span className="font-medium text-nav-dark">{rateText(r.after)}</span></td>
                        {TIERS.map((t) => (
                          <td key={t}>{money(r.before?.[`tier${t}_price_per_acre`])} → <span className="font-medium text-nav-dark">{money(r.after?.[`tier${t}_price_per_acre`])}</span></td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rates.rows.length === 0 && <p className="text-secondary">No rate edits in this file.</p>}
            {ratesSaved != null
              ? <p className="text-green-700">Saved rates for {ratesSaved} products.</p>
              : <Button onClick={() => void confirmRates()} loading={busy} disabled={ratesBlocked}>Confirm Rates tab</Button>}
          </section>
        )}
      </div>
    </Modal>
  );
}
