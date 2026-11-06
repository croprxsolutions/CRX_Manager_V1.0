import { useRef, useState } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText, Sparkles, Download, Lock } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import ClearExpiredIntentButton from '../ClearExpiredIntentButton';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import {
  UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE,
  UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE,
  useUncertainMutationIntent,
} from '../../hooks/useUncertainMutationIntent';
import { supabase, assertRpcResult } from '../../lib/db';
import { isCSVFile } from '../../lib/documentOCR';
import { Sentry } from '../../lib/sentry';
import { sanitizeError } from '../../lib/errorSanitizer';
import { listProductCategories } from '../../lib/productSetup';
import type { Json } from '../../types/supabase';
import {
  PRODUCT_IMPORT_COLUMNS,
  PRODUCT_IMPORT_TEMPLATE,
  buildProductImportRow,
  csvRecordProblem,
  importRefusalReason,
  isRetiredPricingColumn,
  mapProductImportHeaders,
  parseCsvRecords,
  refuseInFileDuplicates,
  type ProductImportRow,
} from './bulkProductImportSafety';

interface BulkProductImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

type PerAcre = { tier1_price_per_acre: number | null; tier2_price_per_acre: number | null; tier3_price_per_acre: number | null };
interface Match { product_name: string; is_active: boolean }
/** One row of preview_product_import (20261107090000). */
interface PreviewResult {
  status: 'ok' | 'refused';
  error: string | null;
  after: (PerAcre & { rate_per_acre: string | null; rate_unit: string | null }) | null;
  expected_prices: PerAcre | null;
  sku_matches: Match[];
  name_matches: Match[];
  epa_matches: Match[];
  in_file_duplicate: boolean;
}
interface Row extends ProductImportRow { preview?: PreviewResult }
/** The exact apply_product_setup rows sent, kept in this browser until the save is confirmed. */
interface ImportIntent { rows: Json; count: number }

const MAX_ROWS = 500;
// Browser storage holds about 5 million characters per site, and the retry record is written twice (local and session).
const MAX_IMPORT_CHARS = 1_000_000;
// Live allows 8 s per request and a rate row takes ~20 ms to check, so 500 rate rows in one request timed out (KI-103).
const PREVIEW_BATCH = 100;

/** Checks rows a batch at a time, in order. In-file duplicates are refused across the whole file before this. */
async function previewInBatches(rows: Row[]): Promise<{ rates_locked: boolean; rows: PreviewResult[] }> {
  const out: PreviewResult[] = [];
  let locked: boolean | undefined;
  for (let i = 0; i < rows.length; i += PREVIEW_BATCH) {
    const batch = rows.slice(i, i + PREVIEW_BATCH);
    const { data, error } = await supabase.rpc('preview_product_import', {
      p_rows: batch.map(({ insert, rates }) => (rates ? { insert, rates } : { insert })) as unknown as Json,
    });
    if (error) throw error;
    const res = assertRpcResult<{ rates_locked: boolean; rows: PreviewResult[] }>(data, 'preview_product_import');
    if (res.rows?.length !== batch.length) throw new Error('The check returned a different number of rows than it was sent.');
    // Earlier batches' rows were checked under the other lock state, so the preview would mix the two.
    if (locked !== undefined && locked !== res.rates_locked) {
      throw new Error('Rates were locked or unlocked while the file was being checked. Check the file again.');
    }
    out.push(...res.rows);
    locked = res.rates_locked;
  }
  return { rates_locked: locked ?? false, rows: out };
}
// Per-acre prices are whole cents in the database (a CHECK), so pad the digits as sent; never round a float.
const money = (v: number | null) => {
  if (v == null) return '—';
  const [whole, frac = ''] = String(v).split('.');
  return `$${whole}.${frac.padEnd(2, '0')}`;
};

/** Why a row will not be imported, or null when it is ready. */
function skipReason(r: Row): string | null {
  if (r.error) return r.error;
  const p = r.preview;
  if (!p) return 'Not checked.';
  const dup = [...p.sku_matches, ...p.name_matches][0];
  if (dup) return `Duplicate of ${dup.product_name}${dup.is_active ? '' : ' (inactive)'}: skipped.`;
  if (p.in_file_duplicate) return 'This name or SKU appears more than once in the file: skipped.';
  if (p.status !== 'ok') return importRefusalReason(p.error ?? 'Refused.', r.insert.product_name);
  if (!pricesReadExactly(p.expected_prices)) return 'A previewed per-acre price is too large to check exactly: skipped.';
  return null;
}

// The preview's numeric prices arrive as JavaScript numbers, exact to the cent only below $10 trillion (15 digits).
function pricesReadExactly(p: PerAcre | null): boolean {
  return !p || [p.tier1_price_per_acre, p.tier2_price_per_acre, p.tier3_price_per_acre]
    .every((v) => v == null || Math.abs(v) < 1e13);
}

/** The page closes the window itself after a save, so clear the finished import whenever it closes. */
function useResetOnClose(open: boolean, reset: () => void) {
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) reset();
  }
}

function ImportPreview({ rows, ready, skipped, ratesLocked, ignored }: {
  rows: Row[]; ready: number; skipped: number; ratesLocked: boolean; ignored: string[];
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="p-4 bg-green-50 border border-green-100 rounded-lg">
          <div className="flex items-center gap-2 mb-1">
            <CheckCircle className="w-5 h-5 text-green-600" />
            <span className="text-sm font-medium text-secondary">Ready to Import</span>
          </div>
          <p className="text-2xl font-semibold text-green-600">{ready}</p>
        </div>
        <div className="p-4 bg-red-50 border border-red-100 rounded-lg">
          <div className="flex items-center gap-2 mb-1">
            <AlertCircle className="w-5 h-5 text-red-600" />
            <span className="text-sm font-medium text-secondary">Skipped</span>
          </div>
          <p className="text-2xl font-semibold text-red-600">{skipped}</p>
          <p className="text-xs text-secondary mt-1">Errors and duplicates; nothing from these rows saves</p>
        </div>
      </div>
      {ratesLocked && (
        <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
          <Lock className="w-4 h-4" /> Rates are locked. Rows that set a rate are skipped; remove the rate columns or ask an admin to unlock rates.
        </p>
      )}
      {ignored.length > 0 && (
        <p className="text-xs text-amber-700">Columns not recognised, ignored: {ignored.join(', ')}</p>
      )}
      <div className="max-h-96 overflow-auto rounded-lg border border-gray-200">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-gray-50 text-left text-secondary">
            <tr>
              <th className="p-2">Row</th>
              <th className="p-2">Product</th>
              <th className="p-2">Result</th>
              <th className="p-2">Rate</th>
              <th className="p-2 text-right">Per acre (T1 / T2 / T3)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => <ImportPreviewRow key={r.row} r={r} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function importStage(rows: Row[] | null, imported: number | null): 'choose' | 'preview' | 'done' {
  if (imported !== null) return 'done';
  return rows ? 'preview' : 'choose';
}

function ImportPreviewRow({ r }: { r: Row }) {
  const why = skipReason(r);
  const after = r.preview?.after;
  return (
    <tr className="border-t border-gray-100 align-top">
      <td className="p-2 text-gray-500">{r.row}</td>
      <td className="p-2">
        <p className="font-medium text-nav-dark">{r.insert.product_name || '(no name)'}</p>
        {r.insert.sku && <p className="text-gray-500">SKU {r.insert.sku}</p>}
        {r.fixes.map((f) => <p key={f} className="text-gray-500">Fixed {f}</p>)}
      </td>
      <td className={`p-2 ${why ? 'text-red-700' : 'text-green-700'}`}>
        {why ?? 'Ready'}
        {!why && r.preview?.epa_matches.length ? (
          <p className="text-gray-500">Same EPA number as {r.preview.epa_matches.map((m) => m.product_name).join(', ')} (another size is fine)</p>
        ) : null}
      </td>
      <td className="p-2">{after?.rate_per_acre != null ? `${after.rate_per_acre} ${after.rate_unit ?? ''}` : '—'}</td>
      <td className="p-2 text-right whitespace-nowrap">
        {after?.rate_per_acre != null
          ? `${money(after.tier1_price_per_acre)} / ${money(after.tier2_price_per_acre)} / ${money(after.tier3_price_per_acre)}`
          : '—'}
      </td>
    </tr>
  );
}

function UnconfirmedNotice({ count, foreign, expired }: { count: number; foreign: boolean; expired: boolean }) {
  return (
    <p role="alert" className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
      <AlertCircle className="w-4 h-4 shrink-0" />
      {foreign ? UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE
        : expired ? UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE
        : `An earlier import of ${count} product(s) was not confirmed. Press Finish Earlier Import to send it again safely: products it already added will not be added twice. Another file can be checked once it is confirmed.`}
    </p>
  );
}

function ImportActions({ stage, hasFile, parsing, saving, earlier, canRetry, ready, onClose, onParse, onChooseAgain, onImport }: {
  stage: 'choose' | 'preview' | 'done'; hasFile: boolean; parsing: boolean; saving: boolean;
  /** Products in an import whose save was not confirmed, or null when there is none. */
  earlier: number | null; canRetry: boolean; ready: number;
  onClose: () => void; onParse: () => void; onChooseAgain: () => void; onImport: () => void;
}) {
  const busy = parsing || saving;
  const finish = (
    <Button onClick={onImport} disabled={!canRetry || saving} loading={saving}>Finish Earlier Import ({earlier})</Button>
  );
  return (
    <div className="flex justify-end gap-2 pt-2">
      <Button variant="secondary" onClick={onClose} disabled={busy}>
        {stage === 'done' ? 'Close' : 'Cancel'}
      </Button>
      {stage === 'choose' && (earlier !== null ? finish : (
        <Button icon={<Upload className="w-4 h-4" />} onClick={onParse} disabled={!hasFile || parsing} loading={parsing}>
          {parsing ? 'Checking...' : 'Check File'}
        </Button>
      ))}
      {stage === 'preview' && (
        <>
          <Button variant="secondary" onClick={onChooseAgain} disabled={busy || earlier !== null}>Choose Different File</Button>
          {earlier !== null ? finish : (
            <Button onClick={onImport} disabled={ready === 0 || saving} loading={saving}>
              Import {ready} Product(s)
            </Button>
          )}
        </>
      )}
    </div>
  );
}

export default function BulkProductImport({ open, onClose, onSuccess }: BulkProductImportProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const userId = profile?.id ?? '';
  // A save whose reply was lost may have committed: its exact rows and retry key survive a reload until it is confirmed.
  const importIntent = useUncertainMutationIntent<ImportIntent>({ operation: 'apply_product_setup', userId, surface: 'bulk-product-import' });
  const earlier = importIntent.isIntentLocked ? (importIntent.unresolvedIntent?.count ?? 0) : null;
  const [file, setFile] = useState<File | null>(null);
  // The generation being checked (0 = none), so only that check can clear it.
  const [checking, setChecking] = useState(0);
  const parsing = checking !== 0;
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [ratesLocked, setRatesLocked] = useState(false);
  const [imported, setImported] = useState<number | null>(null);
  // Bumped whenever the file or preview changes; a reply from an older generation is ignored.
  const generation = useRef(0);
  const busy = parsing || saving;

  const reset = () => {
    generation.current += 1;
    setFile(null); setRows(null); setIgnored([]); setImported(null); setRatesLocked(false);
  };
  // Never wipe an import mid-check or mid-save, so a late reply lands on the import it belongs to.
  const resetIfSettled = () => { if (!busy) reset(); };
  useResetOnClose(open, resetIfSettled);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    if (selectedFile.size > 10 * 1024 * 1024) {
      toast('error', 'File too large. Maximum size is 10MB.');
      e.target.value = '';
      return;
    }
    if (!isCSVFile(selectedFile)) {
      toast('error', 'Invalid file type. Bulk Product Import accepts CSV files only.');
      e.target.value = '';
      return;
    }
    generation.current += 1;
    setFile(selectedFile);
    setRows(null);
    setImported(null);
  };

  const downloadTemplate = () => {
    const url = URL.createObjectURL(new Blob([PRODUCT_IMPORT_TEMPLATE], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'product-import-template.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleParse = async () => {
    if (!file) return;
    const gen = ++generation.current;
    setChecking(gen);
    setRatesLocked(false);
    try {
      const [header, ...data] = parseCsvRecords(await file.text());
      const headers = header?.cells ?? [];
      // A broken header would map a column the file did not cleanly name, so every row under it is suspect.
      if (header?.malformed) {
        if (gen !== generation.current) return;
        toast('error', 'The header row has text after a closing quote. Put each column name fully inside its quotes and try again.');
        return;
      }
      const pricingHeaders = headers.filter(isRetiredPricingColumn);
      if (pricingHeaders.length > 0) {
        toast('error', `Pricing columns are not allowed in Bulk Product Import: ${pricingHeaders.join(', ')}. Use the governed pricing worksheet or Product page instead.`);
        return;
      }
      if (data.length === 0) { toast('error', 'No valid data found in file'); return; }
      if (data.length > MAX_ROWS) {
        toast('error', `File has ${data.length} rows. Maximum is ${MAX_ROWS}. Please split your file into smaller batches.`);
        return;
      }
      const mapping = mapProductImportHeaders(headers);
      if (mapping.conflicts.length > 0) {
        toast('error', `Two columns mean the same thing: ${mapping.conflicts.join('; ')}. Remove one and try again.`);
        return;
      }
      if (mapping.ambiguous.length > 0) {
        toast('error', `These columns could mean more than one thing: ${mapping.ambiguous.join('; ')}. Rename them and try again.`);
        return;
      }
      if (!Object.values(mapping.byIndex).includes('product_name')) {
        toast('error', 'Could not find product name column. Ensure your CSV has a "product_name" or "product" column.');
        return;
      }
      const categories = (await listProductCategories()).filter((c) => c.is_active).map((c) => c.name);
      const built: Row[] = refuseInFileDuplicates(data.map((rec) => buildProductImportRow(rec.cells, mapping, rec.line, categories, csvRecordProblem(rec, headers.length))));
      const checkable = built.filter((r) => !r.error);
      if (checkable.length > 0) {
        const preview = await previewInBatches(checkable);
        if (gen !== generation.current) return;
        checkable.forEach((r, i) => { r.preview = preview.rows[i]; });
        setRatesLocked(preview.rates_locked);
      }
      if (gen !== generation.current) return;
      setIgnored(mapping.ignored);
      setRows(built);
    } catch (error) {
      Sentry.captureException(error);
      if (gen === generation.current) toast('error', `Could not check the file: ${sanitizeError(error)}`);
    } finally {
      setChecking((c) => (c === gen ? 0 : c));
    }
  };

  const stage = importStage(rows, imported);
  const ready = (rows ?? []).filter((r) => skipReason(r) === null);
  const skipped = (rows ?? []).filter((r) => skipReason(r) !== null);

  const handleImport = async () => {
    if (importIntent.isForeignIntentLocked) { toast('error', UNCERTAIN_MUTATION_OTHER_SURFACE_MESSAGE); return; }
    if (importIntent.isRetryExpired) { toast('error', UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE); return; }
    // An unconfirmed import is always re-sent exactly as it was, under its own key, before any new file.
    const candidate: ImportIntent | null = importIntent.getUnresolvedIntent() ?? (ready.length === 0 ? null : {
      rows: ready.map(({ insert, rates, preview }) => (rates
        ? { insert, rates, expected_prices: preview?.expected_prices }
        : { insert })) as unknown as Json,
      count: ready.length,
    });
    if (!candidate) return;
    // A new import too big for browser storage would lock the screen once its retry record failed to save.
    if (!importIntent.isIntentLocked && JSON.stringify(candidate.rows).length > MAX_IMPORT_CHARS) {
      toast('error', 'This file is too large to import safely in one go. Split it into smaller files and import each one.');
      return;
    }
    const gen = generation.current;
    setSaving(true);
    try {
      let request: ImportIntent;
      try {
        request = await importIntent.beginIntent(candidate);
      } catch (error) {
        Sentry.captureException(error, { extra: { context: 'Bulk product import: prepare' } });
        toast('error', 'This import could not be prepared, so nothing was sent. Reload the page and try again.');
        return;
      }
      let inserted: number;
      // Only the save itself is classified: a failure after it (resolve, onSuccess) must never read as "not saved".
      try {
        const { data, error } = await supabase.rpc('apply_product_setup', {
          p_rows: request.rows,
          p_performed_by: userId,
          p_idempotency_key: importIntent.getIdempotencyKey(),
        });
        if (error) throw error;
        inserted = assertRpcResult<{ inserted_count: number }>(data, 'apply_product_setup').inserted_count;
      } catch (error) {
        const disposition = await importIntent.classifyFailure(error);
        Sentry.captureException(error, { extra: { context: 'Bulk product import', disposition } });
        if (disposition === 'definitive') toast('error', sanitizeError(error));
        else if (disposition === 'uncertain') {
          toast('error', `The import was not confirmed (${sanitizeError(error)}). Press Finish Earlier Import: it will not add products twice.`);
        } else {
          toast('warning', 'This import already finished in another tab, so it was not sent again.');
          if (gen === generation.current) setImported(request.count);
          onSuccess();
        }
        return;
      }
      await importIntent.resolveIntent().catch((e: unknown) => Sentry.captureException(e, { extra: { context: 'Bulk product import: resolve' } }));
      if (gen === generation.current) setImported(inserted);
      toast('success', `Imported ${inserted} product(s)`);
      onSuccess();
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => { if (busy) return; resetIfSettled(); onClose(); };

  return (
    <Modal open={open} onClose={handleClose} closeDisabled={busy} title="Bulk Product" accent="Import" maxWidth="max-w-4xl">
      <div className="space-y-4">
        {stage === 'choose' && (
          <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
            <h4 className="text-sm font-medium text-nav-dark mb-2 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-600" />
              How to Import
            </h4>
            <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
              <li>Download the template, or use a CSV with a product_name column</li>
              <li>Check the preview: every row shows whether it will import, and why not</li>
              <li>Import: the ready rows save together, or none do</li>
            </ol>
            <div className="mt-3 p-2 bg-white rounded border border-gray-200">
              <p className="text-xs font-medium text-secondary mb-1">Supported Columns:</p>
              <p className="text-xs text-gray-500 font-mono">{PRODUCT_IMPORT_COLUMNS.join(', ')}</p>
              <p className="text-xs text-gray-500 mt-2">For several use timings, separate labels with a semicolon (for example, Pre-Emerge; Post-Emergence). RUP takes yes or no.</p>
              <p className="text-xs text-amber-700 mt-2">
                Pricing columns are rejected. Update cost, margins, and tier prices from the Product page or governed pricing worksheet.
              </p>
            </div>
            <Button variant="secondary" className="mt-3" icon={<Download className="w-4 h-4" />} onClick={downloadTemplate}>
              Download Template
            </Button>
          </div>
        )}

        {stage !== 'done' && earlier !== null && (
          <div>
            <UnconfirmedNotice count={earlier} foreign={importIntent.isForeignIntentLocked} expired={importIntent.isRetryExpired} />
            {/* After the retry window this is the only way to unlock imports in this browser (KI-27). */}
            <ClearExpiredIntentButton intent={importIntent} operation="apply_product_setup" />
          </div>
        )}

        {stage === 'choose' && (
          <div>
            <label className="block text-sm font-medium text-secondary mb-2">Select File</label>
            <input
              type="file"
              aria-label="Select File"
              accept=".csv,text/csv"
              onChange={handleFileChange}
              disabled={busy || earlier !== null}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-crx-green-light file:text-crx-green file:hover:bg-crx-green file:hover:text-white transition-colors cursor-pointer"
            />
            {file && (
              <div className="mt-2 flex items-center gap-2 text-xs text-secondary">
                <FileText className="w-4 h-4" />
                <span>{file.name} ({(file.size / 1024).toFixed(1)} KB)</span>
              </div>
            )}
          </div>
        )}

        {stage === 'preview' && rows && (
          <ImportPreview rows={rows} ready={ready.length} skipped={skipped.length} ratesLocked={ratesLocked} ignored={ignored} />
        )}

        {stage === 'done' && (
          <div className="p-4 bg-green-50 border border-green-100 rounded-lg text-center" role="status">
            <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-2" />
            <h4 className="text-sm font-medium text-nav-dark mb-1">Import Complete</h4>
            <p className="text-xs text-secondary">Imported {imported} product(s){skipped.length > 0 && `; ${skipped.length} row(s) skipped`}</p>
          </div>
        )}

        <ImportActions
          stage={stage} hasFile={!!file} parsing={parsing} saving={saving} ready={ready.length}
          earlier={earlier} canRetry={!importIntent.isForeignIntentLocked && !importIntent.isRetryExpired}
          onClose={handleClose} onParse={handleParse} onChooseAgain={reset} onImport={handleImport}
        />
      </div>
    </Modal>
  );
}
