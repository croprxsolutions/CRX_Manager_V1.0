import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { sanitizeError } from '../../lib/db';
import { formatExactUSD } from '../../lib/money';
import { getProductParents, previewParentRates, setParentRates, type ParentRatePreview } from '../../lib/productParents';
import { listProductCategories } from '../../lib/productSetup';
import { listProductUseTimingOptions } from '../../lib/productUseTimings';
import {
  applyProductSetup,
  buildSetupPreview,
  editedParentRateRows,
  editedRateRows,
  generateSetupWorkbook,
  groupedParentNames,
  loadSetupWorkbookExport,
  MAX_PARENT_RATE_SAVE_ROWS,
  MAX_SETUP_WORKBOOK_SAVE_ROWS,
  parseSetupWorkbook,
  previewProductRates,
  rebaseRateRowsAfterSetup,
  saveProductRates,
  setupMembershipHash,
  type ParentRateUploadRow,
  type RatePreview,
  type RatePreviewRow,
  type RateUploadRow,
  type SetupPreview,
} from '../../lib/productSetupWorkbook';

const TIERS = [1, 2, 3] as const;
const money = (value: number | null | undefined) => (value == null ? 'none' : formatExactUSD(value));
const INVALID_AMOUNT = 'Invalid amount';
/** True when a parent-rate preview has a per-acre price the screen cannot show exactly. */
const hasUnshownPrice = (previews: ParentRatePreview[]) => previews.some((preview) => preview.sizes.some((size) => TIERS.some((t) => (
  money(size.prices[`tier${t}_price_per_acre`]) === INVALID_AMOUNT || money(size.before_prices[`tier${t}_price_per_acre`]) === INVALID_AMOUNT))));
const RATE_PROBLEM: Record<string, string> = {
  stale: 'changed by someone else since you downloaded it',
  invalid_rate: 'rate must be blank or a number of 0 or more, up to 6 decimals',
  invalid_unit: 'rate unit is missing or not a known unit for this product\'s form',
  not_found: 'product not found',
};
const rateText = (r: RatePreviewRow['before']) =>
  r ? `${r.rate_per_acre ?? '(blank)'} ${r.rate_unit ?? ''}${r.suggested_rate ? ` · "${r.suggested_rate}"` : ''}`.trim() : '';

const plural = (n: number) => `${n} ${n === 1 ? 'product' : 'products'}`;
const GROUPING_CHANGED = 'Products were grouped or moved since this workbook was downloaded. Download a new workbook.';
const parentRateText = (r: { rate_per_acre: string | null; rate_unit: string | null; suggested_rate: string | null }) =>
  `${r.rate_per_acre ?? '(blank)'} ${r.rate_unit ?? ''}${r.suggested_rate ? ` · "${r.suggested_rate}"` : ''}`.trim();

/** Previews for edited parents; a parent changed since the download is named, not saved. */
function ParentRatesTabPreview({ rows, previews, saved, busy, blocked, onConfirm, onRetry }: {
  rows: ParentRateUploadRow[]; previews: ParentRatePreview[] | null; saved: number | null; busy: boolean; blocked: boolean;
  onConfirm: () => void; onRetry: () => void;
}) {
  const locked = previews?.some((p) => p.rates_locked) ?? false;
  return (
    <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Parent Rates tab preview">
      <h3 className="font-semibold text-nav-dark">Parent Rates tab: {rows.length} {rows.length === 1 ? 'parent' : 'parents'} to change</h3>
      {locked && (
        <p className="text-red-700">Rates are locked. An admin can correct one parent at a time from its product page, with a reason.</p>
      )}
      {previews && hasUnshownPrice(previews) && (
        <p className="text-red-700">A per-acre price here is too large to show exactly. Fix that rate in the file and upload it again.</p>
      )}
      {previews?.map((preview, index) => (preview.parent_version !== rows[index].expected.parent_version ? (
        <p key={preview.parent_id} className="text-red-700">{rows[index].parent_name}: changed by someone else since you downloaded it</p>
      ) : null))}
      {previews && (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-left" aria-label="Parent rate changes and affected sizes">
            <thead><tr className="text-secondary"><th className="font-medium">Parent and size</th><th className="font-medium">Rate now → new</th>
              {TIERS.map((t) => <th key={t} className="font-medium">Tier {t} per acre</th>)}</tr></thead>
            <tbody>
              {previews.flatMap((preview, index) => [
                <tr key={preview.parent_id}>
                  <td className="font-medium">{rows[index].parent_name}</td>
                  <td>{parentRateText(preview.before)} → <span className="font-medium text-nav-dark">{parentRateText(preview.after)}</span></td>
                  {TIERS.map((t) => <td key={t} />)}
                </tr>,
                ...preview.sizes.map((size) => (
                  <tr key={`${preview.parent_id}-${size.product_id}`}>
                    <td className="pl-4">{size.product_name}</td>
                    <td />
                    {TIERS.map((t) => (
                      <td key={t}>{money(size.before_prices[`tier${t}_price_per_acre`])} → <span className="font-medium text-nav-dark">{money(size.prices[`tier${t}_price_per_acre`])}</span></td>
                    ))}
                  </tr>
                )),
              ])}
            </tbody>
          </table>
        </div>
      )}
      {!previews && saved == null && (
        <Button variant="secondary" onClick={onRetry} loading={busy}>Preview parent rates again</Button>
      )}
      {saved != null
        ? <p className="text-green-700">Saved rates for {saved} {saved === 1 ? 'parent' : 'parents'}.</p>
        : <Button onClick={onConfirm} loading={busy} disabled={blocked}>Confirm Parent Rates tab</Button>}
    </section>
  );
}

function SetupTabPreview({ setup, saved, busy, blocked, onConfirm }: {
  setup: SetupPreview; saved: string[] | null; busy: boolean; blocked: boolean; onConfirm: () => void;
}) {
  const [onlyQuoteLines, setOnlyQuoteLines] = useState(false);
  const quoteLineCount = setup.changes.filter((row) => row.quote_line).length;
  const rows = onlyQuoteLines ? setup.changes.filter((row) => row.quote_line) : setup.changes;
  return (
    <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Setup tab preview">
      <h3 className="font-semibold text-nav-dark">Setup tab: {plural(setup.changes.length)} to change</h3>
      {quoteLineCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-amber-50 p-2 text-amber-900">
          <p>{plural(quoteLineCount)} change what new quote lines show. Existing quotes keep their notes.</p>
          <label className="flex min-h-11 items-center gap-2">
            <input type="checkbox" checked={onlyQuoteLines} onChange={(e) => setOnlyQuoteLines(e.target.checked)} />
            Show only these
          </label>
        </div>
      )}
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
              {rows.flatMap((row) => [
                ...row.display.map((d) => (
                  <tr key={`${row.product_id}-${d.field}`}><td>{row.product_name}</td><td>{d.field}</td><td>{d.before}</td><td className="font-medium text-nav-dark">{d.after}</td></tr>
                )),
                ...(row.quote_line ? [
                  <tr key={`${row.product_id}-quote-line`} className="bg-amber-50">
                    <td>{row.product_name}</td><td>New quote lines show</td>
                    <td>{row.quote_line.before || '(blank)'}</td><td className="font-medium text-nav-dark">{row.quote_line.after || '(blank)'}</td>
                  </tr>,
                ] : []),
              ])}
            </tbody>
          </table>
        </div>
      )}
      {saved
        ? <p className="text-green-700">Saved: {saved.join(', ')}</p>
        : <Button onClick={onConfirm} loading={busy} disabled={blocked}>
          {quoteLineCount > 0 ? `Confirm Setup tab (${plural(quoteLineCount)} change what customers see)` : 'Confirm Setup tab'}
        </Button>}
    </section>
  );
}

function RatesTabPreview({ locked, edited, changes, problems, saved, busy, blocked, previewMissing, onConfirm, onRetry }: {
  locked: boolean; edited: number; changes: RatePreviewRow[]; problems: RatePreviewRow[];
  saved: number | null; busy: boolean; blocked: boolean; previewMissing: boolean; onConfirm: () => void; onRetry: () => void;
}) {
  return (
    <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Rates tab preview">
      <h3 className="font-semibold text-nav-dark">Rates tab: {plural(changes.length)} to change</h3>
      {locked && (
        <p className="text-red-700">Rates are locked. An admin can correct one product at a time from its product page, with a reason.</p>
      )}
      {problems.map((p) => (
        <p key={p.product_id} className="text-red-700">{p.product_name ?? p.product_id}: {RATE_PROBLEM[p.status]}</p>
      ))}
      {changes.length > 0 && (
        <div className="max-h-64 overflow-auto">
          <table className="w-full text-left">
            <thead><tr className="text-secondary"><th className="font-medium">Product</th><th className="font-medium">Rate now → new</th>
              {TIERS.map((t) => <th key={t} className="font-medium">Tier {t} per acre</th>)}</tr></thead>
            <tbody>
              {changes.map((r) => (
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
      {edited === 0 && <p className="text-secondary">No rate edits in this file.</p>}
      {previewMissing && edited > 0 && saved == null && (
        <Button variant="secondary" onClick={onRetry} loading={busy}>Preview rates again</Button>
      )}
      {saved != null
        ? <p className="text-green-700">Saved rates for {plural(saved)}.</p>
        : <Button onClick={onConfirm} loading={busy} disabled={blocked}>Confirm Rates tab</Button>}
    </section>
  );
}

/**
 * The setup workbook (WP-PM-11a-2): product details and rates in one spreadsheet, separate from the
 * price sheet. Each tab is previewed and confirmed on its own; nothing saves until its Confirm.
 */
/** What each tab's preview shows and whether its save is blocked. */
function tabStates(
  setup: SetupPreview | null,
  rates: { rows: RateUploadRow[]; preview: RatePreview | null } | null,
  parentRates: { rows: ParentRateUploadRow[]; previews: ParentRatePreview[] | null } | null,
) {
  const rateChanges = rates?.preview?.rows.filter((r) => r.status === 'change') ?? [];
  const rateProblems = rates?.preview?.rows.filter((r) => r.status !== 'change' && r.status !== 'unchanged') ?? [];
  return {
    rateChanges,
    rateProblems,
    setupBlocked: !setup || setup.changes.length === 0 || setup.stale.length > 0 || setup.invalid.length > 0,
    ratesBlocked: rateChanges.length === 0 || rateProblems.length > 0 || Boolean(rates?.preview?.rates_locked),
    parentRatesBlocked: !parentRates?.previews || hasUnshownPrice(parentRates.previews) || parentRates.previews.some((preview, index) => (
      preview.rates_locked || preview.parent_version !== parentRates.rows[index].expected.parent_version)),
  };
}

export default function ProductSetupWorkbookModal({ open, profileId, onClose, onSaved }: {
  open: boolean;
  profileId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [setup, setSetup] = useState<SetupPreview | null>(null);
  const [rates, setRates] = useState<{ rows: RateUploadRow[]; preview: RatePreview | null } | null>(null);
  const [setupSaved, setSetupSaved] = useState<string[] | null>(null);
  const [ratesSaved, setRatesSaved] = useState<number | null>(null);
  const [parentRates, setParentRatesState] = useState<{ rows: ParentRateUploadRow[]; previews: ParentRatePreview[] | null } | null>(null);
  const [parentRatesSaved, setParentRatesSaved] = useState<number | null>(null);
  // Scoped to the whole save payload: an exact retry reuses its key, a revised file gets a new one.
  const setupKey = useIdempotencyKey('apply_product_setup', profileId, JSON.stringify(setup?.changes));
  const ratesKey = useIdempotencyKey('set_product_rates', profileId, JSON.stringify([rates?.rows, rates?.preview]));
  const parentRatesKey = useIdempotencyKey('set_parent_rates', profileId, JSON.stringify([parentRates?.rows, parentRates?.previews]));

  const reset = () => {
    setSetup(null); setRates(null); setSetupSaved(null); setRatesSaved(null);
    setParentRatesState(null); setParentRatesSaved(null);
  };
  const close = () => {
    reset();
    onClose();
  };

  const download = async () => {
    setBusy(true);
    try {
      // A failed parents load stops the download: grouped sizes must not be offered as ungrouped.
      const [exported, options, parents] = await Promise.all([loadSetupWorkbookExport(), listProductUseTimingOptions(), getProductParents(null)]);
      const blob = await generateSetupWorkbook(exported, options, parents);
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
      const [current, options, categories, parents] = await Promise.all([
        loadSetupWorkbookExport(), listProductUseTimingOptions(), listProductCategories(), getProductParents(null),
      ]);
      if (await setupMembershipHash(parsed.setupRows.map((row) => row.product_id), parents) !== parsed.membershipHash) {
        throw new Error(GROUPING_CHANGED);
      }
      const setupPreview = buildSetupPreview(parsed.setupRows, current, options, categories.filter((c) => c.is_active).map((c) => c.name), groupedParentNames(parents));
      const rateRows = editedRateRows(parsed.rateRows);
      const parentRows = editedParentRateRows(parsed.parentRateRows);
      if (setupPreview.changes.length > MAX_SETUP_WORKBOOK_SAVE_ROWS || rateRows.length > MAX_SETUP_WORKBOOK_SAVE_ROWS) {
        throw new Error(`Save at most ${MAX_SETUP_WORKBOOK_SAVE_ROWS} changed rows per tab at a time.`);
      }
      if (parentRows.length > MAX_PARENT_RATE_SAVE_ROWS) {
        throw new Error(`Save at most ${MAX_PARENT_RATE_SAVE_ROWS} changed parents on the Parent Rates tab at a time.`);
      }
      setSetup(setupPreview);
      // Keep the parent rows first, so a failed Rates preview still leaves them ready to preview again.
      if (parentRows.length > 0) setParentRatesState({ rows: parentRows, previews: null });
      if (rateRows.length > 0) await previewRates(rateRows);
      else setRates({ rows: rateRows, preview: null });
      if (parentRows.length > 0) await previewParents(parentRows);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  // The rows are kept before the preview is read, so a failed read leaves them ready to preview again.
  const previewRates = async (rows: RateUploadRow[]) => {
    setRates({ rows, preview: null });
    setRates({ rows, preview: await previewProductRates(rows) });
  };
  // One preview per edited parent; its sizes are the snapshot the save checks.
  const previewParents = async (rows: ParentRateUploadRow[]) => {
    setParentRatesState({ rows, previews: null });
    setParentRatesState({ rows, previews: await Promise.all(rows.map((row) => previewParentRates(row.parent_id, row))) });
  };
  const retryParentPreview = async () => {
    if (!parentRates) return;
    setBusy(true);
    try {
      await previewParents(parentRates.rows);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };
  const retryRatesPreview = async () => {
    if (!rates) return;
    setBusy(true);
    try {
      await previewRates(rates.rows);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmSetup = async () => {
    if (!setup) return;
    setBusy(true);
    try {
      const saved = await applyProductSetup({ rows: setup.changes, performedBy: profileId, idempotencyKey: setupKey.getKey() });
      setupKey.resetKey();
      onSaved();
      setSetupSaved(saved.rows.map((row) => row.product_name));
      toast('success', `Saved setup changes to ${saved.changed_count} products`);
      // The old parent previews are stale now; drop them first so a failed re-read cannot leave them confirmable.
      if (parentRates && parentRatesSaved == null) setParentRatesState({ rows: parentRates.rows, previews: null });
      // Rates not yet saved: carry over this save's own version moves and show their preview again.
      if (rates && rates.rows.length > 0 && ratesSaved == null) {
        await previewRates(rebaseRateRowsAfterSetup(rates.rows, saved));
      }
      // A notes save moves a size's version, so parent previews are read again before their save.
      if (parentRates && parentRatesSaved == null) await previewParents(parentRates.rows);
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
      onSaved();
      setRatesSaved(saved.changed_count);
      toast('success', `Saved rates for ${saved.changed_count} products`);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirmParentRates = async () => {
    const previews = parentRates?.previews;
    if (!parentRates || !previews) return;
    setBusy(true);
    try {
      const saved = await setParentRates(parentRates.rows.map((row, index) => ({
        preview: previews[index],
        rates: { rate_per_acre: row.rate_per_acre, rate_unit: row.rate_unit, suggested_rate: row.suggested_rate },
      })), parentRatesKey.getKey());
      parentRatesKey.resetKey();
      onSaved();
      setParentRatesSaved(saved.changed_count);
      toast('success', `Saved rates for ${saved.changed_count} ${saved.changed_count === 1 ? 'parent' : 'parents'}`);
    } catch (error) {
      toast('error', sanitizeError(error));
      // A refused save is usually a stale preview: drop it so the next try previews the current sizes.
      setParentRatesState({ rows: parentRates.rows, previews: null });
    } finally {
      setBusy(false);
    }
  };

  const { rateChanges, rateProblems, setupBlocked, ratesBlocked, parentRatesBlocked } = tabStates(setup, rates, parentRates);

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
          <SetupTabPreview setup={setup} saved={setupSaved} busy={busy} blocked={setupBlocked} onConfirm={() => void confirmSetup()} />
        )}
        {rates && (
          <RatesTabPreview locked={Boolean(rates.preview?.rates_locked)} edited={rates.rows.length} changes={rateChanges}
            problems={rateProblems} saved={ratesSaved} busy={busy} blocked={ratesBlocked} previewMissing={!rates.preview}
            onConfirm={() => void confirmRates()} onRetry={() => void retryRatesPreview()} />
        )}
        {parentRates && (
          <ParentRatesTabPreview rows={parentRates.rows} previews={parentRates.previews} saved={parentRatesSaved} busy={busy}
            blocked={parentRatesBlocked} onConfirm={() => void confirmParentRates()} onRetry={() => void retryParentPreview()} />
        )}
      </div>
    </Modal>
  );
}
