import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
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
import { loadSetupWorkbookChemistry } from '../../lib/productSetupChemistry';
import { assertChemistryWorkbookFitsParserLimit } from '../../lib/productSetupChemistryWorkbook';
import { classifyParentRatesSaveFailure, handleRatesSaveFailure, type DeferredRatesRebase, type RatesState } from './setupWorkbookRateRecovery';
import SetupWorkbookChemistryTabs from './SetupWorkbookChemistryTabs';
import type { ParsedChemistryWorkbook } from '../../lib/productSetupChemistryWorkbook';

const TIERS = [1, 2, 3] as const;
const money = (value: number | null | undefined) => (value == null ? 'none' : formatExactUSD(value));
const INVALID_AMOUNT = 'Invalid amount';
const PARENT_RATE_PREVIEW_STALE_CODES = [RpcErrorCodes.PRODUCT_RATE_PREVIEW_CHANGED, RpcErrorCodes.PRODUCT_RATES_STALE,
  RpcErrorCodes.PRODUCT_PARENT_RATES_STALE, RpcErrorCodes.PRODUCT_PARENT_SIZE_STALE, RpcErrorCodes.PRODUCT_PARENT_STALE] as const;
const PARENT_RATE_LOCK_CODES = [RpcErrorCodes.PRODUCT_RATES_LOCKED, RpcErrorCodes.PRODUCT_RATES_NOT_LOCKED] as const;
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

async function readAndValidateWorkbookSnapshot(file: File, isCurrent: () => boolean) {
  const parsed = await parseSetupWorkbook(await file.arrayBuffer());
  if (!isCurrent()) return null;
  const [current, options, categories, parents] = await Promise.all([
    loadSetupWorkbookExport(), listProductUseTimingOptions(), listProductCategories(), getProductParents(null),
  ]);
  if (!isCurrent()) return null;
  const currentMembershipHash = await setupMembershipHash(parsed.setupRows.map((row) => row.product_id), parents);
  if (!isCurrent()) return null;
  if (currentMembershipHash !== parsed.membershipHash) throw new Error(GROUPING_CHANGED);
  return { parsed, current, options, categories, parents };
}

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

interface SetupWorkbookDialogProps {
  open: boolean; profileId: string; busy: boolean; parentBusy: boolean; onClose: () => void; onSaved: () => void; fileRef: React.RefObject<HTMLInputElement | null>;
  download: () => void; upload: (file: File) => void; setup: SetupPreview | null; setupSaved: string[] | null;
  setupBlocked: boolean; confirmSetup: () => void; rates: { rows: RateUploadRow[]; preview: RatePreview | null } | null;
  rateChanges: RatePreviewRow[]; rateProblems: RatePreviewRow[]; ratesSaved: number | null; ratesBlocked: boolean;
  confirmRates: () => void; retryRatesPreview: () => void;
  parentRates: { rows: ParentRateUploadRow[]; previews: ParentRatePreview[] | null } | null;
  parentRatesSaved: number | null; parentRatesBlocked: boolean; confirmParentRates: () => void; retryParentPreview: () => void;
  chemistryGeneration: number; chemistryParsed: ParsedChemistryWorkbook | null;
  chemistryBusyOwnerKey: string; onChemistryBusyChange: (ownerKey: string, busy: boolean) => void;
}

function SetupWorkbookDialog(props: SetupWorkbookDialogProps) {
  const { open, profileId, busy, parentBusy, onClose, onSaved, fileRef, download, upload, setup, setupSaved, setupBlocked,
    confirmSetup, rates, rateChanges, rateProblems, ratesSaved, ratesBlocked, confirmRates, retryRatesPreview,
    parentRates, parentRatesSaved, parentRatesBlocked, confirmParentRates, retryParentPreview, chemistryGeneration, chemistryParsed,
    chemistryBusyOwnerKey, onChemistryBusyChange } = props;
  return <Modal open={open} onClose={onClose} closeDisabled={busy} title="Setup workbook" size="large"
    footer={<Button variant="secondary" onClick={onClose} disabled={busy}>Close</Button>}>
    <div className="space-y-4 text-sm">
      <p className="text-secondary">
        Product details and rates in one spreadsheet, separate from the price sheet. Edit the green columns, then upload it here.
        Each tab is previewed and saved on its own; nothing saves until you confirm that tab.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={() => void download()} loading={busy} disabled={busy}>Download setup workbook</Button>
        <Button variant="secondary" icon={<Upload className="w-4 h-4" />} onClick={() => fileRef.current?.click()} disabled={busy}>Upload and preview</Button>
        <input ref={fileRef} type="file" className="hidden" aria-label="Setup workbook file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(event) => { const file = event.target.files?.[0]; if (file) void upload(file); }} />
      </div>
      {setup && <SetupTabPreview setup={setup} saved={setupSaved} busy={busy} blocked={setupBlocked} onConfirm={() => void confirmSetup()} />}
      {rates && <RatesTabPreview locked={Boolean(rates.preview?.rates_locked)} edited={rates.rows.length} changes={rateChanges}
        problems={rateProblems} saved={ratesSaved} busy={busy} blocked={ratesBlocked} previewMissing={!rates.preview}
        onConfirm={() => void confirmRates()} onRetry={() => void retryRatesPreview()} />}
      {parentRates && <ParentRatesTabPreview rows={parentRates.rows} previews={parentRates.previews} saved={parentRatesSaved}
        busy={busy} blocked={parentRatesBlocked} onConfirm={() => void confirmParentRates()} onRetry={() => void retryParentPreview()} />}
      <SetupWorkbookChemistryTabs key={`${profileId}:${chemistryGeneration}:${open}`} open={open} profileId={profileId} fileGeneration={chemistryGeneration}
        parsed={chemistryParsed} onSaved={onSaved} parentBusy={parentBusy} busyOwnerKey={chemistryBusyOwnerKey} onBusyChange={onChemistryBusyChange} />
    </div>
  </Modal>;
}

function saveSetupWorkbookFile(blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `crx-product-setup-${new Date().toISOString().slice(0, 10)}.xlsx`;
  link.click();
  URL.revokeObjectURL(url);
}

async function saveParentRateChanges(input: {
  parentRates: { rows: ParentRateUploadRow[]; previews: ParentRatePreview[] | null } | null;
  currentGeneration: () => number;
  generation: number;
  key: { getKey: () => string; resetKey: () => void };
  setBusy: (value: boolean) => void;
  setSaved: (value: number | null) => void;
  setParentRatesState: (value: { rows: ParentRateUploadRow[]; previews: ParentRatePreview[] | null }) => void;
  setRetryPending: (value: boolean) => void;
  hadRetryPending: boolean;
  onLockChanged: () => Promise<void>;
  onSaved: () => void;
  toast: (type: 'error' | 'success', message: string) => void;
}): Promise<void> {
  const { parentRates, currentGeneration, generation, key, setBusy, setSaved, setParentRatesState, setRetryPending, hadRetryPending,
    onLockChanged, onSaved, toast } = input;
  const previews = parentRates?.previews;
  if (!parentRates || !previews) return;
  setBusy(true);
  try {
    const saved = await setParentRates(parentRates.rows.map((row, index) => ({
      preview: previews[index],
      rates: { rate_per_acre: row.rate_per_acre, rate_unit: row.rate_unit, suggested_rate: row.suggested_rate },
    })), key.getKey());
    if (generation !== currentGeneration()) return;
    key.resetKey();
    setRetryPending(false);
    onSaved();
    setSaved(saved.changed_count);
    toast('success', `Saved rates for ${saved.changed_count} ${saved.changed_count === 1 ? 'parent' : 'parents'}`);
  } catch (error) {
    if (generation !== currentGeneration()) return;
    const stale = PARENT_RATE_PREVIEW_STALE_CODES.some((code) => hasRpcCode(error, code));
    const lockChanged = PARENT_RATE_LOCK_CODES.some((code) => hasRpcCode(error, code));
    if (stale || lockChanged) {
      setParentRatesState({ rows: parentRates.rows, previews: null });
    }
    const failure = classifyParentRatesSaveFailure(error, hadRetryPending, stale || lockChanged);
    setRetryPending(failure.retryPending);
    toast('error', failure.message);
    if (lockChanged) {
      try {
        await onLockChanged();
      } catch (refreshError) {
        if (generation === currentGeneration()) {
          toast('error', `The rate lock changed, but its current state could not be loaded. Use Preview parent rates again. ${sanitizeError(refreshError)}`);
        }
      } finally {
        if (generation === currentGeneration()) onSaved();
      }
    }
  } finally {
    if (generation === currentGeneration()) setBusy(false);
  }
}

function useChemistryBusyOwner(profileId: string, generation: number, open: boolean) {
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const ownerKey = `${profileId}:${generation}:${open}`;
  const ownerRef = useRef(ownerKey);
  const previousOwner = useRef(ownerKey);
  const setBusyValue = useCallback((nextBusy: boolean) => {
    if (busyRef.current === nextBusy) return;
    busyRef.current = nextBusy;
    setBusy(nextBusy);
  }, []);
  const onBusyChange = useCallback((reportedOwner: string, nextBusy: boolean) => {
    if (reportedOwner === ownerRef.current) setBusyValue(nextBusy);
  }, [setBusyValue]);
  useLayoutEffect(() => {
    ownerRef.current = ownerKey;
    if (previousOwner.current === ownerKey) return;
    previousOwner.current = ownerKey;
    setBusyValue(false);
  }, [ownerKey, setBusyValue]);
  return { busy, ownerKey, onBusyChange, setBusyValue };
}

async function retryProductRatesPreview(input: {
  rates: RatesState; generation: number; currentGeneration: () => number; setBusy: (busy: boolean) => void;
  previewRates: (rows: RateUploadRow[], generation: number) => Promise<void>;
  toast: (type: 'error' | 'success' | 'warning', message: string) => void;
}): Promise<void> {
  const { rates, generation, currentGeneration, setBusy, previewRates, toast } = input;
  if (!rates) return;
  setBusy(true);
  try { await previewRates(rates.rows, generation); }
  catch (error) { if (generation === currentGeneration()) toast('error', sanitizeError(error)); }
  finally { if (generation === currentGeneration()) setBusy(false); }
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
  const [rates, setRates] = useState<RatesState>(null);
  const [setupSaved, setSetupSaved] = useState<string[] | null>(null);
  const [ratesSaved, setRatesSaved] = useState<number | null>(null);
  const [parentRates, setParentRatesState] = useState<{ rows: ParentRateUploadRow[]; previews: ParentRatePreview[] | null } | null>(null);
  const [parentRatesSaved, setParentRatesSaved] = useState<number | null>(null);
  const [chemistryParsed, setChemistryParsed] = useState<ParsedChemistryWorkbook | null>(null);
  const [chemistryOwnerProfile, setChemistryOwnerProfile] = useState(profileId);
  const [chemistryGeneration, setChemistryGeneration] = useState(0);
  const chemistryGenerationRef = useRef(0);
  const previousProfile = useRef(profileId);
  const parentRatesRetryPending = useRef(false); const ratesRetryPending = useRef(false); const deferredRatesRebase = useRef<DeferredRatesRebase>(null);
  const chemistryBusyState = useChemistryBusyOwner(profileId, chemistryGeneration, open);
  const chemistryBusy = chemistryBusyState.busy;
  const chemistryBusyOwnerKey = chemistryBusyState.ownerKey;
  const onChemistryBusyChange = chemistryBusyState.onBusyChange;
  const setChemistryBusyValue = chemistryBusyState.setBusyValue;
  // Scoped to the whole save payload: an exact retry reuses its key, a revised file gets a new one.
  const setupKey = useIdempotencyKey('apply_product_setup', profileId, JSON.stringify(setup?.changes));
  const ratesKey = useIdempotencyKey('set_product_rates', profileId, JSON.stringify([rates?.rows, rates?.preview])); const resetRatesKey = ratesKey.resetKey;
  const parentRatesKey = useIdempotencyKey('set_parent_rates', profileId, JSON.stringify([parentRates?.rows, parentRates?.previews]));

  const reset = useCallback((discardRatesRetry = false) => {
    chemistryGenerationRef.current += 1;
    setChemistryGeneration(chemistryGenerationRef.current);
    if (fileRef.current) fileRef.current.value = '';
    setBusy(false);
    setChemistryBusyValue(false);
    parentRatesRetryPending.current = false;
    ratesRetryPending.current = false;
    deferredRatesRebase.current = null;
    if (discardRatesRetry) {
      resetRatesKey();
    }
    setChemistryParsed(null);
    setChemistryOwnerProfile(profileId);
    setSetup(null); setRates(null); setSetupSaved(null); setRatesSaved(null);
    setParentRatesState(null); setParentRatesSaved(null);
  }, [profileId, resetRatesKey, setChemistryBusyValue]);
  useLayoutEffect(() => {
    if (previousProfile.current === profileId) return;
    previousProfile.current = profileId;
    reset(true);
  }, [profileId, reset]);
  const close = () => {
    reset(true);
    onClose();
  };

  const download = async () => {
    const generation = chemistryGenerationRef.current;
    setBusy(true);
    try {
      // A failed parents load stops the download: grouped sizes must not be offered as ungrouped.
      const [exported, options, parents, chemistry] = await Promise.all([
        loadSetupWorkbookExport(), listProductUseTimingOptions(), getProductParents(null), loadSetupWorkbookChemistry(),
      ]);
      if (generation !== chemistryGenerationRef.current) return;
      assertChemistryWorkbookFitsParserLimit(chemistry);
      const blob = await generateSetupWorkbook(exported, options, parents, chemistry);
      if (generation !== chemistryGenerationRef.current) return;
      saveSetupWorkbookFile(blob);
    } catch (error) {
      if (generation === chemistryGenerationRef.current) toast('error', sanitizeError(error));
    } finally {
      if (generation === chemistryGenerationRef.current) setBusy(false);
    }
  };

  const upload = async (file: File) => {
    reset();
    const generation = chemistryGenerationRef.current;
    setBusy(true);
    try {
      const snapshot = await readAndValidateWorkbookSnapshot(file, () => generation === chemistryGenerationRef.current);
      if (!snapshot) return;
      const { parsed, current, options, categories, parents } = snapshot;
      const setupPreview = buildSetupPreview(parsed.setupRows, current, options, categories.filter((c) => c.is_active).map((c) => c.name), groupedParentNames(parents));
      const rateRows = editedRateRows(parsed.rateRows);
      const parentRows = editedParentRateRows(parsed.parentRateRows);
      if (setupPreview.changes.length > MAX_SETUP_WORKBOOK_SAVE_ROWS || rateRows.length > MAX_SETUP_WORKBOOK_SAVE_ROWS) {
        throw new Error(`Save at most ${MAX_SETUP_WORKBOOK_SAVE_ROWS} changed rows per tab at a time.`);
      }
      if (parentRows.length > MAX_PARENT_RATE_SAVE_ROWS) {
        throw new Error(`Save at most ${MAX_PARENT_RATE_SAVE_ROWS} changed parents on the Parent Rates tab at a time.`);
      }
      setChemistryOwnerProfile(profileId);
      setChemistryParsed(parsed.chemistry);
      setSetup(setupPreview);
      // Keep the parent rows first, so a failed Rates preview still leaves them ready to preview again.
      if (parentRows.length > 0) setParentRatesState({ rows: parentRows, previews: null });
      if (rateRows.length > 0) await previewRates(rateRows, generation);
      else setRates({ rows: rateRows, preview: null });
      if (generation !== chemistryGenerationRef.current) return;
      if (parentRows.length > 0) await previewParents(parentRows, generation);
    } catch (error) {
      if (generation === chemistryGenerationRef.current) toast('error', sanitizeError(error));
    } finally {
      if (generation === chemistryGenerationRef.current) {
        setBusy(false);
        if (fileRef.current) fileRef.current.value = '';
      }
    }
  };

  // The rows are kept before the preview is read, so a failed read leaves them ready to preview again.
  const previewRates = async (rows: RateUploadRow[], generation: number) => {
    if (generation !== chemistryGenerationRef.current) return;
    setRates({ rows, preview: null });
    const preview = await previewProductRates(rows);
    if (generation === chemistryGenerationRef.current) setRates({ rows, preview });
  };
  // One preview per edited parent; its sizes are the snapshot the save checks.
  const previewParents = async (rows: ParentRateUploadRow[], generation: number) => {
    if (generation !== chemistryGenerationRef.current) return;
    setParentRatesState({ rows, previews: null });
    const previews = await Promise.all(rows.map((row) => previewParentRates(row.parent_id, row)));
    if (generation === chemistryGenerationRef.current) setParentRatesState({ rows, previews });
  };
  const retryParentPreview = async () => {
    if (!parentRates) return;
    const generation = chemistryGenerationRef.current;
    setBusy(true);
    try {
      await previewParents(parentRates.rows, generation);
      if (generation === chemistryGenerationRef.current) parentRatesRetryPending.current = false;
    } catch (error) {
      if (generation === chemistryGenerationRef.current) toast('error', sanitizeError(error));
    } finally {
      if (generation === chemistryGenerationRef.current) setBusy(false);
    }
  };
  const retryRatesPreview = () => { void retryProductRatesPreview({ rates, generation: chemistryGenerationRef.current,
    currentGeneration: () => chemistryGenerationRef.current, setBusy, previewRates, toast }); };

  const confirmSetup = async () => {
    if (!setup) return;
    const generation = chemistryGenerationRef.current;
    const keepParentRatesRetry = parentRatesRetryPending.current;
    const keepRatesRetry = ratesRetryPending.current;
    setBusy(true);
    try {
      const saved = await applyProductSetup({ rows: setup.changes, performedBy: profileId, idempotencyKey: setupKey.getKey() });
      if (generation !== chemistryGenerationRef.current) return;
      setupKey.resetKey();
      onSaved();
      setSetupSaved(saved.rows.map((row) => row.product_name));
      toast('success', `Saved setup changes to ${saved.changed_count} products`);
      // The old parent previews are stale now; drop them first so a failed re-read cannot leave them confirmable.
      if (parentRates && parentRatesSaved == null && !keepParentRatesRetry) setParentRatesState({ rows: parentRates.rows, previews: null });
      // Rates not yet saved: carry over this save's own version moves and show their preview again.
      if (rates && rates.rows.length > 0 && ratesSaved == null && !keepRatesRetry) {
        await previewRates(rebaseRateRowsAfterSetup(rates.rows, saved), generation);
      } else if (rates && rates.rows.length > 0 && ratesSaved == null && keepRatesRetry) {
        deferredRatesRebase.current = { source: JSON.stringify([rates.rows, rates.preview]), generation,
          rows: rebaseRateRowsAfterSetup(rates.rows, saved) };
      }
      // A notes save moves a size's version, so parent previews are read again before their save.
      if (parentRates && parentRatesSaved == null && !keepParentRatesRetry) await previewParents(parentRates.rows, generation);
    } catch (error) {
      if (generation === chemistryGenerationRef.current) toast('error', sanitizeError(error));
    } finally {
      if (generation === chemistryGenerationRef.current) setBusy(false);
    }
  };

  const confirmRates = async () => {
    if (!rates?.preview) return;
    const generation = chemistryGenerationRef.current;
    const hadRetryPending = ratesRetryPending.current || ratesKey.hasKeyFor(JSON.stringify([rates.rows, rates.preview]));
    setBusy(true);
    try {
      const saved = await saveProductRates({ preview: rates.preview, rows: rates.rows, performedBy: profileId, idempotencyKey: ratesKey.getKey() });
      if (generation !== chemistryGenerationRef.current) return;
      ratesKey.resetKey();
      ratesRetryPending.current = false;
      onSaved();
      setRatesSaved(saved.changed_count);
      toast('success', `Saved rates for ${saved.changed_count} products`);
    } catch (error) {
      if (generation === chemistryGenerationRef.current) {
        toast('error', handleRatesSaveFailure({ error, hadRetryPending, currentRates: rates, generation,
          ratesRetryPending, deferredRatesRebase, setRates, resetKey: ratesKey.resetKey }));
      }
    } finally {
      if (generation === chemistryGenerationRef.current) setBusy(false);
    }
  };

  const confirmParentRates = () => saveParentRateChanges({ parentRates, currentGeneration: () => chemistryGenerationRef.current,
    generation: chemistryGenerationRef.current, key: parentRatesKey, setBusy, setSaved: setParentRatesSaved,
    hadRetryPending: parentRatesRetryPending.current,
    setParentRatesState, setRetryPending: (value) => { parentRatesRetryPending.current = value; },
    onLockChanged: async () => {
      if (parentRates) await previewParents(parentRates.rows, chemistryGenerationRef.current);
    }, onSaved, toast });

  const { rateChanges, rateProblems, setupBlocked, ratesBlocked, parentRatesBlocked } = tabStates(setup, rates, parentRates);
  const chemistryForCurrentProfile = chemistryOwnerProfile === profileId ? chemistryParsed : null;

  const dialogProps: SetupWorkbookDialogProps = {
    open, profileId, busy: busy || chemistryBusy, parentBusy: busy, onClose: close, onSaved, fileRef, download, upload, setup, setupSaved, setupBlocked,
    confirmSetup, rates, rateChanges, rateProblems, ratesSaved, ratesBlocked, confirmRates, retryRatesPreview,
    parentRates, parentRatesSaved, parentRatesBlocked, confirmParentRates, retryParentPreview, chemistryGeneration,
    chemistryParsed: chemistryForCurrentProfile, chemistryBusyOwnerKey, onChemistryBusyChange,
  };
  return <SetupWorkbookDialog {...dialogProps} />;
}
