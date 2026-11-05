import { useRef, useState } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText, Sparkles, Download, Lock } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { useAuth } from '../../contexts/AuthContext';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
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
  importRefusalReason,
  isRetiredPricingColumn,
  mapProductImportHeaders,
  parseCsv,
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

const MAX_ROWS = 500;
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
  return null;
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

export default function BulkProductImport({ open, onClose, onSuccess }: BulkProductImportProps) {
  const { toast } = useToast();
  const { profile } = useAuth();
  const userId = profile?.id ?? '';
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('apply_product_setup', userId);
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [ratesLocked, setRatesLocked] = useState(false);
  const [imported, setImported] = useState<number | null>(null);
  // One retry key per previewed file: a double click or a retry after a lost reply saves once.
  const previewSeq = useRef(0);
  const [previewId, setPreviewId] = useState('');

  const reset = () => { setFile(null); setRows(null); setIgnored([]); setImported(null); setRatesLocked(false); };

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
    setParsing(true);
    setRatesLocked(false);
    try {
      const [headers = [], ...data] = parseCsv(await file.text());
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
      if (!Object.values(mapping.byIndex).includes('product_name')) {
        toast('error', 'Could not find product name column. Ensure your CSV has a "product_name" or "product" column.');
        return;
      }
      const categories = (await listProductCategories()).filter((c) => c.is_active).map((c) => c.name);
      const built: Row[] = data.map((cells, i) => buildProductImportRow(cells, mapping, i + 2, categories));
      const checkable = built.filter((r) => !r.error);
      if (checkable.length > 0) {
        const { data: res, error } = await supabase.rpc('preview_product_import', {
          p_rows: checkable.map(({ insert, rates }) => (rates ? { insert, rates } : { insert })) as unknown as Json,
        });
        if (error) throw error;
        const preview = assertRpcResult<{ rates_locked: boolean; rows: PreviewResult[] }>(res, 'preview_product_import');
        checkable.forEach((r, i) => { r.preview = preview.rows[i]; });
        setRatesLocked(preview.rates_locked);
      }
      previewSeq.current += 1;
      setPreviewId(`${file.name}:${file.lastModified}:${previewSeq.current}`);
      setIgnored(mapping.ignored);
      setRows(built);
    } catch (error) {
      Sentry.captureException(error);
      toast('error', `Could not check the file: ${sanitizeError(error)}`);
    } finally {
      setParsing(false);
    }
  };

  const stage = importStage(rows, imported);
  const ready = (rows ?? []).filter((r) => skipReason(r) === null);
  const skipped = (rows ?? []).filter((r) => skipReason(r) !== null);

  const handleImport = async () => {
    if (ready.length === 0) return;
    setSaving(true);
    try {
      const { data, error } = await supabase.rpc('apply_product_setup', {
        p_rows: ready.map(({ insert, rates, preview }) => (rates
          ? { insert, rates, expected_prices: preview?.expected_prices }
          : { insert })) as unknown as Json,
        p_performed_by: userId,
        p_idempotency_key: getKeyFor(previewId),
      });
      if (error) throw error;
      const result = assertRpcResult<{ inserted_count: number }>(data, 'apply_product_setup');
      resetKeyFor(previewId);
      setImported(result.inserted_count);
      toast('success', `Imported ${result.inserted_count} product(s)`);
      onSuccess();
    } catch (error) {
      Sentry.captureException(error, { extra: { context: 'Bulk product import' } });
      const message = sanitizeError(error);
      // A refusal saved nothing; anything else (a lost reply) may have saved, and the same key makes a retry safe.
      toast('error', message.startsWith('Nothing was saved.') ? message
        : `The import was not confirmed (${message}). Press Import again: it will not add products twice.`);
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => { reset(); onClose(); };

  return (
    <Modal open={open} onClose={handleClose} title="Bulk Product" accent="Import" maxWidth="max-w-4xl">
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

        {stage === 'choose' && (
          <div>
            <label className="block text-sm font-medium text-secondary mb-2">Select File</label>
            <input
              type="file"
              aria-label="Select File"
              accept=".csv,text/csv"
              onChange={handleFileChange}
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

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {stage === 'done' ? 'Close' : 'Cancel'}
          </Button>
          {stage === 'choose' && (
            <Button icon={<Upload className="w-4 h-4" />} onClick={handleParse} disabled={!file || parsing} loading={parsing}>
              {parsing ? 'Checking...' : 'Check File'}
            </Button>
          )}
          {stage === 'preview' && rows && (
            <>
              <Button variant="secondary" onClick={reset}>Choose Different File</Button>
              <Button onClick={handleImport} disabled={ready.length === 0 || saving} loading={saving}>
                Import {ready.length} Product(s)
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
