import { Fragment, useId, useRef, useState } from 'react';
import { parseQuoteOrderCsv, parseQuoteOrderCsvNumber, QuoteOrderCsvError } from '../../lib/quoteOrderCsv';
import { Upload, CheckCircle, AlertCircle, FileText, Check, ChevronDown, Download, Loader2 } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase, assertRpcResult } from '../../lib/db';
import { useAuth } from '../../contexts/AuthContext';
import { useBelowCostApproval } from '../../contexts/BelowCostApprovalContext';
import { isBelowCostApprovalHandledError, withBelowCostReason } from '../../lib/belowCostApproval';
import { processDocumentWithOCR, isCSVFile, isOCRSupported } from '../../lib/documentOCR';
import { generateIdempotencyKey } from '../../lib/idempotency';
import { Sentry } from '../../lib/sentry';
import { withAdminCosts } from '../../lib/costFields';
import { fetchAllRows, pageWithList } from '../../lib/pagedRead';
import { logActivity } from '../../lib/activityLogger';
import type { Json } from '../../types/supabase';
import { resolveExactProductIdentity } from '../../lib/productIdentityResolver';
import { isWholeCentPurchaseOrderCost, purchaseOrderUnitCostCents } from '../../lib/purchaseOrderMoney';
import { quoteImportAmounts } from '../../lib/quoteImportMath';
import { formatUSD } from '../../lib/money';
import { useIsPhone } from '../../hooks/useIsPhone';

interface BulkQuoteImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ParsedQuoteItem {
  quote_number: string;
  customer_farm_name: string;
  section_name?: string;
  product_name: string;
  acres?: number;
  price_per_unit?: number;
  oz_per_acre?: number;
  actual_rate?: number;
  rate_unit?: string;
  notes?: string;
  tier?: number;
  status?: string;
  valid_days?: number;
  header_notes?: string;
  footer_notes?: string;
}

interface ValidationResult {
  valid: ParsedQuoteItem[];
  invalid: Array<{ row: number; error: string; data: Record<string, string> }>;
}

type InvalidQuoteRow = ValidationResult['invalid'][number];

interface ValidQuoteRow {
  row: number;
  item: ParsedQuoteItem;
  data: Record<string, string>;
}

const FIELD_MAPPINGS: Record<string, string[]> = {
  quote_number: ['quote_number', 'quote_num', 'quote_id', 'quote', 'quote#'],
  customer_farm_name: ['customer_farm_name', 'customer', 'farm_name', 'farm', 'customer_name'],
  section_name: ['section_name', 'section', 'category', 'group'],
  product_name: ['product_name', 'product', 'product_code', 'item', 'sku'],
  acres: ['acres', 'acre', 'acreage'],
  price_per_unit: ['price_per_unit', 'price', 'unit_price', 'cost'],
  oz_per_acre: ['oz_per_acre', 'oz/acre', 'oz_acre', 'ounces_per_acre'],
  actual_rate: ['actual_rate', 'rate', 'application_rate'],
  rate_unit: ['rate_unit', 'unit', 'rate_uom'],
  notes: ['notes', 'note', 'item_notes', 'comments'],
  tier: ['tier', 'price_tier', 'pricing_tier'],
  status: ['status', 'quote_status'],
  valid_days: ['valid_days', 'validity', 'expiry_days'],
  header_notes: ['header_notes', 'header', 'quote_header'],
  footer_notes: ['footer_notes', 'footer', 'quote_footer'],
};

const IMPORTABLE_QUOTE_STATUSES = new Set(['draft']);

const normalizeQuoteNumber = (quoteNumber?: string | null): string =>
  quoteNumber?.trim().toUpperCase() ?? '';

const escapeIlikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`);

const normalizeUnitName = (unit?: string | null): string =>
  unit?.toLowerCase().trim() ?? '';

const checkedCents = (value: number): bigint => {
  if (!Number.isSafeInteger(value)) throw new Error('Imported money exceeds the supported whole-cent range. Reduce the values and retry.');
  return BigInt(value);
};

const toMoneyCents = (value: number | null | undefined): bigint => {
  if (value != null && !Number.isFinite(value)) throw new Error('Imported money must be finite. Correct the values and retry.');
  return checkedCents(purchaseOrderUnitCostCents(value ?? 0));
};

const centsToDollars = (cents: bigint): number => Number(checkedCents(Number(cents))) / 100;

const stableStringify = (value: unknown): string => {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
};

const payloadFingerprint = (value: unknown): string => {
  let hash = 2166136261;
  const serialized = stableStringify(value);
  for (let i = 0; i < serialized.length; i++) {
    hash ^= serialized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
};

const importRowFingerprint = (quoteNumber: string, items: ParsedQuoteItem[]): string =>
  payloadFingerprint({
    quote_number: quoteNumber,
    items: items.map((item) => ({
      quote_number: normalizeQuoteNumber(item.quote_number),
      customer_farm_name: item.customer_farm_name.trim(),
      section_name: item.section_name?.trim() || null,
      product_name: item.product_name.trim(),
      acres: item.acres ?? null,
      price_per_unit: item.price_per_unit ?? null,
      oz_per_acre: item.oz_per_acre ?? null,
      actual_rate: item.actual_rate ?? null,
      rate_unit: normalizeUnitName(item.rate_unit) || null,
      notes: item.notes ?? null,
      tier: item.tier ?? null,
      status: item.status ?? null,
      valid_days: item.valid_days ?? null,
      header_notes: item.header_notes ?? null,
      footer_notes: item.footer_notes ?? null,
    })),
  });

const rejectPartiallyInvalidQuoteGroups = (
  candidates: ValidQuoteRow[],
  invalid: InvalidQuoteRow[]
): ValidationResult => {
  const blockedQuoteNumbers = new Set(
    invalid
      .map((row) => normalizeQuoteNumber(row.data.quote_number))
      .filter(Boolean)
  );

  if (blockedQuoteNumbers.size === 0) {
    return {
      valid: candidates.map(({ item }) => ({
        ...item,
        quote_number: normalizeQuoteNumber(item.quote_number),
      })),
      invalid,
    };
  }

  const valid: ParsedQuoteItem[] = [];
  const normalizedInvalid = [...invalid];

  candidates.forEach(({ row, item, data }) => {
    if (blockedQuoteNumbers.has(normalizeQuoteNumber(item.quote_number))) {
      normalizedInvalid.push({
        row,
        error: `Quote ${item.quote_number} has another invalid row; fix all rows for this quote before importing.`,
        data,
      });
      return;
    }

    valid.push({
      ...item,
      quote_number: normalizeQuoteNumber(item.quote_number),
    });
  });

  return { valid, invalid: normalizedInvalid };
};

const REQUIRED_COLUMNS: Array<[string, string]> = [
  ['quote_number', 'Your quote ID. Rows with the same number become one quote.'],
  ['customer_farm_name', 'Must match a customer already in CRX.'],
  ['product_name', 'Must match a product already in CRX.'],
];

const OPTIONAL_COLUMN_LABELS = [
  'section_name', 'acres', 'price_per_unit', 'oz_per_acre', 'actual_rate', 'rate_unit', 'notes',
  'tier (1 to 3)', 'status (draft)', 'valid_days', 'header_notes', 'footer_notes',
];

// Every column the parser reads, required first. Synthetic values only: the repo is public.
const SAMPLE_COLUMNS = [
  ...REQUIRED_COLUMNS.map(([column]) => column),
  ...Object.keys(FIELD_MAPPINGS).filter((field) => !REQUIRED_COLUMNS.some(([column]) => column === field)),
];

const SAMPLE_ROWS: Array<Record<string, string>> = [
  { quote_number: 'SAMPLE-001', customer_farm_name: 'Sample Farms', product_name: 'Sample Herbicide A', section_name: 'Corn', acres: '120', price_per_unit: '12.40', actual_rate: '32', rate_unit: 'oz', notes: 'Apply before planting', tier: '1', status: 'draft', valid_days: '15', header_notes: 'Spring program', footer_notes: 'Prices hold for 15 days' },
  { quote_number: 'SAMPLE-001', customer_farm_name: 'Sample Farms', product_name: 'Sample Fungicide B', section_name: 'Corn', acres: '120', price_per_unit: '38.00', actual_rate: '8', rate_unit: 'oz', tier: '1', status: 'draft', valid_days: '15', header_notes: 'Spring program', footer_notes: 'Prices hold for 15 days' },
  { quote_number: 'SAMPLE-002', customer_farm_name: 'Sample Grain Co', product_name: 'Sample Adjuvant C', section_name: 'Soybeans', acres: '80', price_per_unit: '9.25', oz_per_acre: '16', tier: '2', status: 'draft', valid_days: '30' },
  { quote_number: 'SAMPLE-002', customer_farm_name: 'Sample Grain Co', product_name: 'Sample Insecticide D', section_name: 'Soybeans', acres: '80', oz_per_acre: '4', notes: 'No price uses the price list', tier: '2', status: 'draft', valid_days: '30' },
];

const SAMPLE_CSV = [SAMPLE_COLUMNS, ...SAMPLE_ROWS.map((row) => SAMPLE_COLUMNS.map((column) => row[column] ?? ''))]
  .map((cells) => cells.join(','))
  .join('\n') + '\n';

const downloadSampleCsv = () => {
  const url = URL.createObjectURL(new Blob([SAMPLE_CSV], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'crx-quote-import-sample.csv';
  a.click();
  URL.revokeObjectURL(url);
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const fileSize = (file: File) => `${(file.size / 1024).toFixed(1)} KB`;
const CREATED_DETAIL = /: Created with \d+ items$/;
const STEP_NAMES = ['Upload', 'Review', 'Import'] as const;
const STEP_BAR_WIDTH = ['w-1/3', 'w-2/3', 'w-full'];

function ImportSteps({ current, finished, busy }: { current: 1 | 2 | 3; finished: boolean; busy: boolean }) {
  return (
    <>
      <ol aria-label="Steps" className="hidden items-center gap-2 rounded-lg bg-cream px-4 py-2.5 text-sm md:flex">
        {STEP_NAMES.map((name, index) => {
          const step = index + 1;
          const done = finished || step < current;
          const active = !finished && step === current;
          return (
            <Fragment key={name}>
              {index > 0 && <li aria-hidden="true" className={`h-px w-8 ${step <= current ? 'bg-crx-green' : 'bg-gray-300'}`} />}
              <li
                aria-current={active ? 'step' : undefined}
                className={`inline-flex items-center gap-2 ${done || active ? 'text-crx-green' : 'text-secondary'} ${active ? 'font-semibold' : ''}`}
              >
                <span
                  className={`inline-flex h-5.5 w-5.5 items-center justify-center rounded-full text-xs ${
                    done ? 'bg-crx-green-light' : active ? 'bg-crx-green text-white' : 'border border-gray-300'
                  }`}
                >
                  {done ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : active && busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : step}
                </span>
                {name}
                {done && <span className="sr-only"> (done)</span>}
              </li>
            </Fragment>
          );
        })}
      </ol>
      <div className="flex items-center gap-2.5 rounded-lg bg-cream px-3 py-2.5 text-sm md:hidden">
        <span className="font-semibold text-crx-green">Step {current} of 3 · {STEP_NAMES[current - 1]}</span>
        <span aria-hidden="true" className="h-1 flex-1 overflow-hidden rounded-full bg-gray-200">
          <span className={`block h-full bg-crx-green ${STEP_BAR_WIDTH[current - 1]}`} />
        </span>
      </div>
    </>
  );
}

function FileRow({ file, detail, action }: { file: File; detail: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-gray-200 px-3.5 py-2.5">
      <span className="inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg bg-cream-dark text-secondary">
        <FileText className="h-4.5 w-4.5" aria-hidden="true" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-semibold text-nav-dark">{file.name}</span>
        <span className="text-sm text-secondary">{detail}</span>
      </span>
      {action}
    </div>
  );
}

// The board's short label on phone keeps the file name readable.
const CHANGE_FILE_LABEL = (
  <>
    <span className="md:hidden">Change file</span>
    <span className="hidden md:inline">Choose a different file</span>
  </>
);

const TEXT_ACTION = 'inline-flex min-h-11 flex-none items-center rounded-lg px-2 text-sm font-medium text-crx-green hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green md:min-h-9';

function ReviewRows({ validation, quoteCount, leftOutQuotes }: { validation: ValidationResult; quoteCount: number; leftOutQuotes: number }) {
  const { valid, invalid } = validation;
  // Opens on what needs attention only when nothing can be imported.
  const [view, setView] = useState<'ready' | 'fix'>(valid.length === 0 && invalid.length > 0 ? 'fix' : 'ready');
  const quotes = new Map<string, ParsedQuoteItem[]>();
  valid.forEach((item) => quotes.set(item.quote_number, [...(quotes.get(item.quote_number) ?? []), item]));
  const segment = (active: boolean) =>
    `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md px-3.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green md:min-h-9 ${
      active ? 'bg-white font-semibold text-nav-dark shadow-sm' : 'font-medium text-secondary hover:text-nav-dark'
    }`;

  return (
    <div className="space-y-3.5">
      <div role="status" className="flex flex-col gap-1.5 md:flex-row md:flex-wrap md:items-center md:gap-3.5">
        <span className="font-heading text-[22px] font-semibold leading-tight text-nav-dark">
          {plural(quoteCount, 'quote', 'quotes')} ready to import
        </span>
        <span className="flex flex-wrap gap-1.5 text-[13px] font-semibold">
          <span className="rounded-full bg-crx-green-light px-2.5 py-0.5 text-crx-green">{plural(valid.length, 'row', 'rows')} ready</span>
          {invalid.length > 0 && (
            <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-amber-800">
              {invalid.length === 1 ? '1 row needs fixing' : `${invalid.length} rows need fixing`}
            </span>
          )}
        </span>
      </div>
      {invalid.length > 0 && (
        <p className="text-sm text-secondary">
          {leftOutQuotes > 0
            ? `${leftOutQuotes === 1 ? '1 quote is left out because one of its rows has' : `${leftOutQuotes} quotes are left out because one of their rows has`} a problem.`
            : 'Rows that need fixing are left out.'}{' '}
          Fix those rows in your file and import it again.
        </p>
      )}

      <div role="group" aria-label="Rows" className="grid grid-cols-2 gap-0.5 rounded-lg bg-cream-dark p-0.5 md:inline-grid">
        <button type="button" aria-pressed={view === 'ready'} onClick={() => setView('ready')} className={segment(view === 'ready')}>
          Ready <span className="font-medium text-secondary tabular-nums">{quoteCount}</span>
        </button>
        <button type="button" aria-pressed={view === 'fix'} onClick={() => setView('fix')} className={segment(view === 'fix')}>
          Needs fixing
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 text-xs font-semibold text-amber-800 tabular-nums">
            {invalid.length}
          </span>
        </button>
      </div>

      {view === 'ready' && (quotes.size === 0 ? (
        <p className="rounded-xl border border-gray-200 px-3.5 py-3 text-sm text-secondary">No rows are ready to import.</p>
      ) : (
        <div className="space-y-2.5">
          {Array.from(quotes, ([quoteNumber, items], index) => (
            <details key={quoteNumber} open={index === 0} className="group overflow-hidden rounded-xl border border-gray-200">
              <summary className="flex min-h-11 cursor-pointer list-none items-center gap-x-2.5 bg-cream px-3.5 py-2 group-open:border-b group-open:border-cream-dark [&::-webkit-details-marker]:hidden">
                <span className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-2.5">
                  <span className="break-words font-semibold text-nav-dark md:flex-none">{quoteNumber}</span>
                  <span className="min-w-0 truncate text-secondary">{Array.from(new Set(items.map((item) => item.customer_farm_name))).join(', ')}</span>
                </span>
                <span className="flex-none text-[13px] text-secondary">{plural(items.length, 'product', 'products')}</span>
                <ChevronDown className="h-4 w-4 flex-none text-secondary transition-transform group-open:rotate-180" aria-hidden="true" />
              </summary>
              <div aria-hidden="true" className="hidden grid-cols-[minmax(0,1fr)_9rem_4.5rem_7rem] gap-3 px-3.5 pt-2 text-[13px] text-secondary md:grid">
                <span>Product</span><span>Section</span><span className="text-right">Acres</span><span className="text-right">Price</span>
              </div>
              <ul className="divide-y divide-cream-dark text-sm">
                {items.map((item, rowIndex) => {
                  const price = typeof item.price_per_unit === 'number' ? formatUSD(item.price_per_unit) : 'Price list';
                  const acres = item.acres != null ? String(item.acres) : '';
                  return (
                    <li key={rowIndex} className="grid gap-0.5 px-3.5 py-2.5 md:grid-cols-[minmax(0,1fr)_9rem_4.5rem_7rem] md:gap-3 md:py-2">
                      <span className="min-w-0 break-words font-medium text-nav-dark md:font-normal">{item.product_name}</span>
                      <span className="text-secondary md:hidden">
                        {[item.section_name, acres && `${acres} ac`, price].filter(Boolean).join(' · ')}
                      </span>
                      <span className="hidden min-w-0 truncate text-secondary md:block"><span className="sr-only">Section </span>{item.section_name}</span>
                      <span className="hidden text-right tabular-nums md:block"><span className="sr-only">Acres </span>{acres}</span>
                      <span className={`hidden text-right tabular-nums md:block ${typeof item.price_per_unit === 'number' ? '' : 'text-secondary'}`}><span className="sr-only">Price </span>{price}</span>
                    </li>
                  );
                })}
              </ul>
            </details>
          ))}
        </div>
      ))}

      {view === 'fix' && (invalid.length === 0 ? (
        <p className="rounded-xl border border-gray-200 px-3.5 py-3 text-sm text-secondary">No rows need fixing.</p>
      ) : (
        <ul className="divide-y divide-cream-dark overflow-hidden rounded-xl border border-gray-200">
          {[...invalid].sort((a, b) => a.row - b.row).map((inv, index) => (
            <li key={index} className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 px-3.5 py-2.5 md:grid-cols-[4.5rem_minmax(0,1fr)] md:gap-x-3">
              <span className="font-semibold text-amber-800 tabular-nums">Row {inv.row}</span>
              <span className={`break-words font-medium ${String(inv.data.quote_number ?? '').trim() ? 'text-nav-dark' : 'text-secondary'}`}>
                {String(inv.data.quote_number ?? '').trim() || 'no quote number'}
              </span>
              <span className="col-span-2 break-words text-sm text-secondary md:col-span-1 md:col-start-2">{inv.error}</span>
            </li>
          ))}
        </ul>
      ))}
    </div>
  );
}

export default function BulkQuoteImport({ open, onClose, onSuccess }: BulkQuoteImportProps) {
  const { toast } = useToast();
  const { profile, role } = useAuth();
  const isAdmin = role === 'admin';
  const { runWithBelowCostApproval } = useBelowCostApproval();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [uploadResults, setUploadResults] = useState<{ success: number; failed: number; details: string[] } | null>(null);
  const importIdempotencyKeysRef = useRef(new Map<string, string>());
  // Bumped when the file changes or the dialog closes, so a check of the old file that finishes late is dropped.
  const parseRunRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileInputId = useId();
  const isPhone = useIsPhone();

  const importIdempotencyScope = (quoteNumber: string, payloadScope: string): string =>
    `${profile?.id ?? 'unknown'}:${normalizeQuoteNumber(quoteNumber)}:${payloadScope}`;

  const hasImportIdempotencyKey = (quoteNumber: string, payloadScope: string): boolean =>
    importIdempotencyKeysRef.current.has(importIdempotencyScope(quoteNumber, payloadScope));

  const getImportIdempotencyKey = (quoteNumber: string, payloadScope: string): string => {
    const scope = importIdempotencyScope(quoteNumber, payloadScope);
    const cached = importIdempotencyKeysRef.current.get(scope);
    if (cached) return cached;
    const key = generateIdempotencyKey('save_quote_bulk_import', scope);
    importIdempotencyKeysRef.current.set(scope, key);
    return key;
  };

  const clearImportIdempotencyKey = (quoteNumber: string, payloadScope: string): void => {
    importIdempotencyKeysRef.current.delete(importIdempotencyScope(quoteNumber, payloadScope));
  };

  const cancelParse = () => {
    parseRunRef.current += 1;
    setParsing(false);
  };

  // One handler for the file input and the drop zone. Returns false when the file is refused.
  const selectFile = (selectedFile: File | undefined): boolean => {
    if (selectedFile) {
      if (selectedFile.size > 10 * 1024 * 1024) {
        toast('error', 'File too large. Maximum size is 10MB.');
        return false;
      }
      const isCSV = isCSVFile(selectedFile);
      const isOCR = isOCRSupported(selectedFile);
      if (!isCSV && !isOCR) {
        toast('error', 'Invalid file type. Please upload a CSV, PDF, or image file.');
        return false;
      }
      cancelParse();
      setFile(selectedFile);
      setValidation(null);
      setUploadResults(null);
    }
    return true;
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectFile(e.target.files?.[0])) e.target.value = '';
  };

  const handleDrop = (e: React.DragEvent<HTMLElement>) => {
    e.preventDefault();
    selectFile(e.dataTransfer.files?.[0]);
  };

  const detectFieldMapping = (header: string): string | null => {
    const normalized = header.toLowerCase().trim().replace(/\s+/g, '_');
    for (const [field, aliases] of Object.entries(FIELD_MAPPINGS)) {
      if (aliases.includes(normalized)) {
        return field;
      }
    }
    return null;
  };

  const parseWithVisionOCR = async (file: File): Promise<{ valid: ParsedQuoteItem[]; invalid: Array<{ row: number; error: string; data: Record<string, string> }> }> => {
    const result = await processDocumentWithOCR(file, 'quote_list');

    if (!result.success || !result.parsed_data) {
      toast('error', result.error || 'OCR processing failed. Try a clearer image or CSV instead.');
      return { valid: [], invalid: [] };
    }

    const data = result.parsed_data as {
      items?: Array<{
        quote_number?: string;
        customer_name?: string;
        product_name?: string;
        acres?: number;
        price?: number;
        rate?: number;
      }>;
    };

    if (!data.items || data.items.length === 0) {
      toast('error', 'No quote items found in document.');
      return { valid: [], invalid: [] };
    }

    const candidates: ValidQuoteRow[] = [];
    const invalid: InvalidQuoteRow[] = [];

    data.items.forEach((item, idx) => {
      if (!item.quote_number || !item.customer_name || !item.product_name) {
        invalid.push({
          row: idx + 1,
          error: 'Missing required fields (quote_number, customer_name, or product_name)',
          data: { ...item } as unknown as Record<string, string>,
        });
        return;
      }
      candidates.push({
        row: idx + 1,
        data: { ...item } as unknown as Record<string, string>,
        item: {
          quote_number: item.quote_number,
          customer_farm_name: item.customer_name,
          product_name: item.product_name,
          acres: item.acres,
          price_per_unit: item.price,
          actual_rate: item.rate,
        },
      });
    });

    return rejectPartiallyInvalidQuoteGroups(candidates, invalid);
  };

  const handleParse = async () => {
    if (!file) return;
    const parseRun = ++parseRunRef.current;
    const isStale = () => parseRun !== parseRunRef.current;
    setValidation(null);
    setParsing(true);

    try {
      // Route: CSV → client-side parser, PDF/Image → Vision OCR
      if (!isCSVFile(file)) {
        const ocrResult = await parseWithVisionOCR(file);
        if (isStale()) return;
        setValidation(ocrResult);
        setParsing(false);
        return;
      }

      const text = await file.text();
      if (isStale()) return;
      const { headers, rows, rowNumbers } = parseQuoteOrderCsv(text);

      if (rows.length === 0) {
        toast('error', 'No valid data found in file');
        setParsing(false);
        return;
      }

      const fieldMapping: Record<number, string> = {};
      headers.forEach((header, idx) => {
        const field = detectFieldMapping(header);
        if (field) {
          fieldMapping[idx] = field;
        }
      });

      const requiredFields = ['quote_number', 'customer_farm_name', 'product_name'];
      const missingFields = requiredFields.filter(
        (field) => !Object.values(fieldMapping).includes(field)
      );

      if (missingFields.length > 0) {
        toast('error', `Missing required columns: ${missingFields.join(', ')}`);
        setParsing(false);
        return;
      }

      const validRows: ValidQuoteRow[] = [];
      const invalid: InvalidQuoteRow[] = [];

      rows.forEach((cols, idx) => {
        const item: Partial<ParsedQuoteItem> = {};
        const rowData: Record<string, string> = {};
        const invalidNumbers: string[] = [];

        cols.forEach((value, colIdx) => {
          const field = fieldMapping[colIdx];
          if (field) {
            rowData[field] = value;

            if (
              field === 'quote_number' ||
              field === 'customer_farm_name' ||
              field === 'section_name' ||
              field === 'product_name' ||
              field === 'rate_unit' ||
              field === 'notes' ||
              field === 'status' ||
              field === 'header_notes' ||
              field === 'footer_notes'
            ) {
              if (value) item[field] = value;
            } else if (
              field === 'acres' ||
              field === 'price_per_unit' ||
              field === 'oz_per_acre' ||
              field === 'actual_rate'
            ) {
              const num = parseQuoteOrderCsvNumber(value);
              if (value && (!Number.isFinite(num) || num < 0 || (field === 'price_per_unit' && !isWholeCentPurchaseOrderCost(num)))) {
                invalidNumbers.push(field);
              } else if (value) {
                item[field] = num;
              }
            } else if (field === 'tier') {
              const tier = parseQuoteOrderCsvNumber(value);
              if ([1, 2, 3].includes(tier)) {
                item[field] = tier;
              } else if (value) {
                invalidNumbers.push(field);
              }
            } else if (field === 'valid_days') {
              const days = parseQuoteOrderCsvNumber(value);
              const expiry = new Date(Date.now() + days * 86400000);
              if (Number.isInteger(days) && days > 0 && Number.isFinite(expiry.getTime()) && expiry.getUTCFullYear() <= 9999) {
                item[field] = days;
              } else if (value) {
                invalidNumbers.push(field);
              }
            }
          }
        });

        const normalizedStatus = item.status?.toLowerCase().trim();
        if (normalizedStatus) item.status = normalizedStatus;

        if (invalidNumbers.length > 0) {
          invalid.push({
            row: rowNumbers[idx],
            error: `Invalid numeric fields: ${invalidNumbers.join(', ')}. Use plain numbers without thousands separators, negative values, or lost digits; prices must have no more than two decimal places, tier must be 1, 2, or 3, and valid_days must produce an expiry no later than year 9999.`,
            data: rowData,
          });
          return;
        }

        if (!item.quote_number || !item.customer_farm_name || !item.product_name) {
          invalid.push({
            row: rowNumbers[idx],
            error: 'Missing required fields (quote_number, customer_farm_name, or product_name)',
            data: rowData,
          });
          return;
        }

        if (item.status && !IMPORTABLE_QUOTE_STATUSES.has(item.status)) {
          invalid.push({
            row: rowNumbers[idx],
            error: 'Unsupported status. Bulk quote imports may only create draft quotes.',
            data: rowData,
          });
          return;
        }

        validRows.push({ row: rowNumbers[idx], item: item as ParsedQuoteItem, data: rowData });
      });

      setValidation(rejectPartiallyInvalidQuoteGroups(validRows, invalid));
    } catch (error) {
      if (isStale()) return;
      if (!(error instanceof QuoteOrderCsvError)) {
        Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
          extra: { context: 'BulkQuoteImport.parseCSVFile' },
        });
      }
      toast('error', error instanceof QuoteOrderCsvError ? error.message : 'Failed to parse file. Please ensure it is a valid CSV.');
    }
    setParsing(false);
  };

  const handleUpload = async () => {
    if (!validation || validation.valid.length === 0 || !profile) return;
    setUploading(true);

    const details: string[] = [];
    let successCount = 0;
    let failCount = 0;

    try {
      // Customers and products page by page: one read stops at the server's 1,000-row cap, and a
      // product or customer past it could never be matched (S12b).
      const custRes = await fetchAllRows((from, to) => pageWithList(supabase.from('customers')
        .select('id, farm_name', { count: 'exact' }).order('farm_name').order('id').range(from, to)));
      const prodRes = await fetchAllRows((from, to) => pageWithList(supabase.from('products')
        .select('id, product_name, sku, inventory_unit, unit_size, is_active', { count: 'exact' })
        .eq('is_active', true).order('product_name').order('id').range(from, to)));
      const convRes = await supabase.from('unit_conversions').select('*');

      if (custRes.error || prodRes.error || convRes.error) {
        const errMsg = custRes.error?.message || prodRes.error?.message || convRes.error?.message;
        toast('error', `Failed to load reference data: ${errMsg}`);
        setUploading(false);
        return;
      }

      const customers = custRes.data;
      // Cost is admin-only (Mason, 2026-10-15): a non-admin's lines carry 0 cost and
      // save_quote derives it; cost is never displayed here.
      type ImportProduct = NonNullable<typeof prodRes.data>[number] & { current_cost?: number | null };
      let productsWithCost: ImportProduct[] | null;
      try {
        productsWithCost = prodRes.data ? await withAdminCosts('products', prodRes.data as ImportProduct[], isAdmin) : null;
      } catch (costError) {
        Sentry.captureException(costError instanceof Error ? costError : new Error(String(costError)), {
          extra: { context: 'BulkQuoteImport.loadProductCosts' },
        });
        toast('error', 'Failed to load reference data');
        setUploading(false);
        return;
      }
      const products = productsWithCost;
      const unitConversions = convRes.data || [];

      if (!customers || !products) {
        toast('error', 'Failed to load reference data');
        setUploading(false);
        return;
      }

      // A name shared by two customers matches neither, so a quote never goes to the wrong one.
      const customerIdsByName = new Map<string, string[]>();
      for (const c of customers) {
        const key = c.farm_name.toLowerCase().trim();
        customerIdsByName.set(key, [...(customerIdsByName.get(key) ?? []), c.id]);
      }
      const productDetailsById = new Map(products.map((p) => [p.id, p]));

      const quoteGroups = new Map<string, ParsedQuoteItem[]>();
      validation.valid.forEach((item) => {
        const key = normalizeQuoteNumber(item.quote_number);
        if (!quoteGroups.has(key)) {
          quoteGroups.set(key, []);
        }
        quoteGroups.get(key)!.push(item);
      });

      for (const [quoteNumber, items] of quoteGroups) {
        try {
          const firstItem = items[0];
          const customerMatches = items.map((item) => {
            const ids = customerIdsByName.get(item.customer_farm_name.toLowerCase().trim()) ?? [];
            return { name: item.customer_farm_name, id: ids.length === 1 ? ids[0] : undefined, shared: ids.length > 1 };
          });
          const sharedNames = Array.from(new Set(customerMatches.filter((c) => c.shared).map((c) => c.name)));
          if (sharedNames.length > 0) {
            details.push(`Quote ${quoteNumber}: More than one customer is named "${sharedNames.join('", "')}". Give each a different name (for example add the town), then retry.`);
            failCount++;
            continue;
          }
          const missingCustomers = Array.from(new Set(
            customerMatches
              .filter((customer) => !customer.id)
              .map((customer) => customer.name)
          )).sort((a, b) => a.localeCompare(b));
          if (missingCustomers.length > 0) {
            details.push(`Quote ${quoteNumber}: Customer(s) not found - ${missingCustomers.join(', ')}`);
            failCount++;
            continue;
          }

          const customerIds = Array.from(new Set(customerMatches.map((customer) => customer.id!)));
          if (customerIds.length > 1) {
            const customerNames = Array.from(new Set(customerMatches.map((customer) => customer.name)))
              .sort((a, b) => a.localeCompare(b));
            details.push(`Quote ${quoteNumber}: Rows reference multiple customers - ${customerNames.join(', ')}`);
            failCount++;
            continue;
          }
          const customerId = customerIds[0];

          const productByItem = new Map<ParsedQuoteItem, (typeof products)[number]>();
          const missingProducts: string[] = [];
          const ambiguousProducts: string[] = [];
          for (const item of items) {
            const resolution = resolveExactProductIdentity(item.product_name, products);
            if (resolution.status === 'unique') productByItem.set(item, resolution.product);
            else if (resolution.status === 'ambiguous') ambiguousProducts.push(item.product_name);
            else missingProducts.push(item.product_name);
          }
          if (missingProducts.length > 0) {
            details.push(`Quote ${quoteNumber}: Product(s) not found - ${[...new Set(missingProducts)].sort().join(', ')}`);
            failCount++;
            continue;
          }
          if (ambiguousProducts.length > 0) {
            details.push(`Quote ${quoteNumber}: Product(s) ambiguous - ${[...new Set(ambiguousProducts)].sort().join(', ')}. Use a unique SKU.`);
            failCount++;
            continue;
          }

          const idemPayloadScope = importRowFingerprint(quoteNumber, items);
          if (!hasImportIdempotencyKey(quoteNumber, idemPayloadScope)) {
            const existingQuoteResult = await supabase
              .from('quotes')
              .select('quote_number')
              .ilike('quote_number', escapeIlikePattern(quoteNumber));
            if (existingQuoteResult.error) {
              Sentry.captureException(new Error(`Failed to check existing quote numbers: ${existingQuoteResult.error.message}`), {
                extra: { context: 'BulkQuoteImport existing quote check', quoteNumber },
              });
              details.push(`Quote ${quoteNumber}: Failed to check existing quote numbers - ${existingQuoteResult.error.message}`);
              failCount++;
              continue;
            }

            const existingQuoteNumbers = (existingQuoteResult.data || [])
              .map((quote: { quote_number?: string | null }) => quote.quote_number)
              .filter((value): value is string => Boolean(value));
            if (existingQuoteNumbers.length > 0) {
              const caseVariants = existingQuoteNumbers.filter((value) => value !== quoteNumber);
              const suffix = caseVariants.length > 0
                ? ` Existing case variant(s): ${caseVariants.join(', ')}.`
                : '';
              details.push(`Quote ${quoteNumber}: Quote number already exists.${suffix}`);
              failCount++;
              continue;
            }
          }

          const sectionGroups = new Map<string, ParsedQuoteItem[]>();
          items.forEach((item) => {
            const sectionName = item.section_name || 'Default';
            if (!sectionGroups.has(sectionName)) {
              sectionGroups.set(sectionName, []);
            }
            sectionGroups.get(sectionName)!.push(item);
          });

          let totalPriceCents = 0n;
          let totalCostCents = 0n;
          let totalProfitCents = 0n;

          const sectionsPayload = Array.from(sectionGroups.entries()).map(([sectionName, sectionItems], sectionIndex) => {
            const sectionItemsPayload = sectionItems
              .map((item, itemIndex) => {
              const productId = productByItem.get(item)!.id;
              const product = productDetailsById.get(productId);
              const inventoryUnit = product?.inventory_unit || product?.unit_size;
              const hasPriceOverride = typeof item.price_per_unit === 'number';
              const pricePerUnitCents = toMoneyCents(hasPriceOverride ? item.price_per_unit! : 0);
              const currentCostCents = toMoneyCents(product?.current_cost);
              const price_per_unit = centsToDollars(pricePerUnitCents);
              const current_cost = centsToDollars(currentCostCents);
              const acres = item.acres || 0;
              const hasActualRate = typeof item.actual_rate === 'number';
              const hasOzPerAcre = typeof item.oz_per_acre === 'number';
              if (hasActualRate && !normalizeUnitName(item.rate_unit)) {
                throw new Error(`Rate unit is required when actual_rate is supplied for product ${item.product_name}`);
              }
              const actualRate = hasActualRate ? item.actual_rate! : hasOzPerAcre ? item.oz_per_acre! : null;
              const rateUnit = hasActualRate ? item.rate_unit! : hasOzPerAcre ? 'oz' : null;
              const rateConv = rateUnit
                ? unitConversions.find((c: { unit: string; factor_oz: number }) => normalizeUnitName(c.unit) === normalizeUnitName(rateUnit))
                : null;
              if (actualRate !== null && (!rateConv || rateConv.factor_oz <= 0)) {
                throw new Error(`Unsupported rate unit "${rateUnit || 'blank'}" for product ${item.product_name}`);
              }
              const conv = inventoryUnit
                ? unitConversions.find((c: { unit: string; factor_oz: number }) => normalizeUnitName(c.unit) === normalizeUnitName(inventoryUnit))
                : null;
              if (acres > 0 && (actualRate ?? 0) > 0 && (!conv || conv.factor_oz <= 0)) {
                throw new Error(`Unsupported inventory unit "${inventoryUnit || 'blank'}" for product ${item.product_name}`);
              }
              const conversionFactor = conv?.factor_oz ?? 1;
              const amounts = quoteImportAmounts({ acres, rate: actualRate ?? 0, rateFactor: rateConv?.factor_oz ?? 1,
                inventoryFactor: conversionFactor, priceCents: pricePerUnitCents, costCents: currentCostCents });
              const oz_per_acre = amounts.ouncesPerAcre;
              const total_units_needed = amounts.totalUnits;
              const lineTotalPriceCents = amounts.priceCents;
              const lineTotalCostCents = amounts.costCents;
              const profitCents = lineTotalPriceCents - lineTotalCostCents;
              const total_price = centsToDollars(lineTotalPriceCents);
              const profit = centsToDollars(profitCents);
              const net_margin = total_price > 0 ? (profit / total_price) * 100 : 0;

              totalPriceCents += lineTotalPriceCents;
              totalCostCents += lineTotalCostCents;
              totalProfitCents += profitCents;

              return {
                product_id: productId,
                sort_order: itemIndex,
                price_per_unit,
                price_override: hasPriceOverride ? price_per_unit : null,
                current_cost,
                suggested_rate: null,
                actual_rate: actualRate,
                rate_unit: rateUnit,
                oz_per_acre: oz_per_acre || null,
                acres: acres || null,
                total_units_needed: total_units_needed || null,
                price_per_acre: acres > 0 ? total_price / acres : null,
                total_price,
                profit,
                net_margin,
                calc_mode: 'rate_acres',
                price_unit: null,
                unit_size: null,
                notes: item.notes || null,
              };
            });

            return {
              section_name: sectionName,
              sort_order: sectionIndex,
              section_notes: null,
              section_header_notes: null,
              needed_by_date: null,
              field_id: null,
              items: sectionItemsPayload,
            };
          });

          const itemsCreated = sectionsPayload.reduce((sum, section) => sum + section.items.length, 0);

          if (itemsCreated > 0) {
            const validDays = firstItem.valid_days || 15;
            const totalPrice = centsToDollars(totalPriceCents);
            const totalCost = centsToDollars(totalCostCents);
            const totalProfit = centsToDollars(totalProfitCents);
            const quotePayload = {
              quote_number: quoteNumber,
              customer_id: customerId,
              created_by: profile.id,
              tier: firstItem.tier || 1,
              status: 'draft',
              total_price: totalPrice,
              total_cost: totalCost,
              total_profit: totalProfit,
              total_margin_pct: totalPrice > 0 ? (totalProfit / totalPrice) * 100 : 0,
              valid_days: validDays,
              expires_at: new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toISOString(),
              header_notes: firstItem.header_notes || null,
              footer_notes: firstItem.footer_notes || null,
              is_planned: false,
            };

            const idemKey = getImportIdempotencyKey(quoteNumber, idemPayloadScope);
            const { data, error } = await runWithBelowCostApproval((reason) => supabase.rpc('save_quote', withBelowCostReason('save_quote', {
              p_quote_id: null as unknown as string,
              p_quote_payload: quotePayload as Json,
              p_sections: sectionsPayload as Json,
              p_performed_by: profile.id,
              p_idempotency_key: idemKey,
            }, reason)));

            if (error) {
              details.push(`Quote ${quoteNumber}: Failed to create quote - ${error.message}`);
              failCount++;
              continue;
            }

            const result = assertRpcResult<{ quote_id: string }>(data, 'save_quote');
            clearImportIdempotencyKey(quoteNumber, idemPayloadScope);
            try {
              await logActivity({
                event: 'quote_bulk_imported',
                description: `Bulk imported quote ${quoteNumber} with ${itemsCreated} item(s)`,
                performedBy: profile.id,
                entityType: 'quote',
                entityId: result.quote_id,
                customerId,
              });
            } catch (logError) {
              Sentry.captureException(logError instanceof Error ? logError : new Error(String(logError)), {
                extra: { context: 'BulkQuoteImport.logActivity', quoteNumber, quoteId: result.quote_id },
              });
            }
            details.push(`Quote ${quoteNumber}: Created with ${itemsCreated} items`);
            successCount++;
          } else {
            details.push(`Quote ${quoteNumber}: No items could be created`);
            failCount++;
          }
        } catch (error) {
          if (!isBelowCostApprovalHandledError(error)) {
            Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
              extra: { context: 'BulkQuoteImport.createQuote', quoteNumber },
            });
          }
          details.push(`Quote ${quoteNumber}: ${isBelowCostApprovalHandledError(error) ? 'Below-cost save cancelled or requires an admin' : error instanceof Error ? error.message : 'Unexpected error'}`);
          failCount++;
        }
      }

      setUploadResults({ success: successCount, failed: failCount, details });

      if (successCount > 0) {
        toast('success', `Successfully imported ${successCount} quote(s)`);
        onSuccess();
      }
      if (failCount > 0) {
        toast('error', `Failed to import ${failCount} quote(s)`);
      }
    } catch (error) {
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)), {
        extra: { context: 'BulkQuoteImport.import' },
      });
      toast('error', 'Import failed');
    }
    setUploading(false);
  };

  const handleClose = () => {
    cancelParse();
    setFile(null);
    setValidation(null);
    setUploadResults(null);
    onClose();
  };

  const step: 1 | 2 | 3 = uploadResults || uploading ? 3 : validation ? 2 : 1;
  const quoteCount = validation ? new Set(validation.valid.map((v) => v.quote_number)).size : 0;
  const leftOutQuotes = validation
    ? new Set(validation.invalid.map((row) => normalizeQuoteNumber(String(row.data.quote_number ?? ''))).filter(Boolean)).size
    : 0;
  const createdCount = uploadResults?.success ?? 0;

  const footer = (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-2.5">
      {validation && !uploadResults && (
        <p className="hidden text-[13px] text-secondary md:block">Imported quotes are saved as drafts.</p>
      )}
      <span aria-hidden="true" className="hidden flex-1 md:block" />
      {!uploadResults && (
        <span className="hidden md:contents">
          <Button variant="secondary" onClick={handleClose}>Cancel</Button>
        </span>
      )}
      {!validation && !uploadResults && (
        <Button
          icon={<Upload className="w-4 h-4" />}
          onClick={handleParse}
          disabled={!file || parsing}
          loading={parsing}
          className="h-12 w-full md:h-10 md:w-auto"
        >
          {file && !isCSVFile(file) ? (parsing ? 'Reading file' : 'Read file') : 'Check file'}
        </Button>
      )}
      {validation && !uploadResults && (
        <>
          <Button
            onClick={handleUpload}
            disabled={validation.valid.length === 0 || uploading}
            loading={uploading}
            className="h-12 w-full md:h-10 md:w-auto"
          >
            Import {plural(quoteCount, 'quote', 'quotes')}
          </Button>
          <p className="text-center text-[13px] text-secondary md:hidden">
            Saved as drafts.
            {leftOutQuotes > 0 && ` The ${leftOutQuotes === 1 ? 'quote with problems is' : `${leftOutQuotes} quotes with problems are`} skipped.`}
          </p>
        </>
      )}
      {uploadResults && (
        <Button onClick={handleClose} className="h-12 w-full md:h-10 md:w-auto">Done</Button>
      )}
    </div>
  );

  return (
    <Modal open={open} onClose={handleClose} title="Import" accent="quotes" maxWidth="max-w-2xl" footer={footer}>
      <div className="space-y-4">
        <ImportSteps current={step} finished={!!uploadResults} busy={uploading} />

        {!validation && !uploadResults && (
          <>
            <p className="text-secondary">Bring in quotes from a spreadsheet, a PDF, or a photo of a quote sheet.</p>
            <div>
              <input
                ref={fileInputRef}
                id={fileInputId}
                type="file"
                accept=".csv,.pdf,.jpg,.jpeg,.png,.webp,image/*"
                onChange={handleFileChange}
                aria-label="Choose a file"
                tabIndex={file ? -1 : undefined}
                className="peer sr-only"
              />
              {file ? (
                <FileRow
                  file={file}
                  detail={isCSVFile(file) ? fileSize(file) : `${fileSize(file)} · Read automatically`}
                  action={
                    <button type="button" onClick={() => fileInputRef.current?.click()} className={TEXT_ACTION}>
                      {CHANGE_FILE_LABEL}
                    </button>
                  }
                />
              ) : (
                <label
                  htmlFor={fileInputId}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  className="flex cursor-pointer flex-col items-center gap-2.5 rounded-xl border-2 border-dashed border-gray-300 bg-cream px-4 py-5 text-center transition-colors hover:border-crx-green peer-focus-visible:ring-2 peer-focus-visible:ring-crx-green md:px-5 md:py-7"
                >
                  <span className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-crx-green-light text-crx-green">
                    <Upload className="h-6 w-6" aria-hidden="true" />
                  </span>
                  <span className="hidden text-[15px] font-semibold text-nav-dark md:block">
                    Drop a file here, or <span className="text-crx-green underline">choose a file</span>
                  </span>
                  <span className="flex h-12 w-full items-center justify-center rounded-lg bg-crx-green text-base font-semibold text-white md:hidden">
                    Choose a file
                  </span>
                  <span className="flex flex-wrap justify-center gap-1.5 text-xs">
                    {['CSV', 'PDF', 'Photo (JPG, PNG)'].map((type) => (
                      <span key={type} className="rounded-full border border-gray-200 bg-white px-2.5 py-0.5 text-secondary">{type}</span>
                    ))}
                    <span className="px-1 py-0.5 text-secondary">Up to 10 MB</span>
                  </span>
                </label>
              )}
            </div>

            <div className="flex flex-col gap-3 rounded-xl border border-gray-200 p-3.5 sm:flex-row sm:items-center">
              <span className="hidden h-9 w-9 flex-none items-center justify-center rounded-lg bg-cream-dark text-secondary sm:inline-flex">
                <FileText className="h-4.5 w-4.5" aria-hidden="true" />
              </span>
              <span className="flex flex-1 flex-col">
                <span className="font-semibold text-nav-dark">Start from the sample spreadsheet</span>
                <span className="text-[13px] text-secondary">Every column filled in with an example. Replace the rows with your own.</span>
              </span>
              <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={downloadSampleCsv} className="min-h-11 w-full sm:w-auto md:min-h-10">
                Download sample CSV
              </Button>
            </div>

            <details open={!isPhone} className="group rounded-xl border border-gray-200">
              <summary className="flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-xl px-3.5 font-semibold text-nav-dark focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green md:min-h-11 [&::-webkit-details-marker]:hidden">
                <ChevronDown className="h-4 w-4 text-secondary transition-transform group-open:rotate-180" aria-hidden="true" />
                What the file needs
              </summary>
              <div className="space-y-3 px-3.5 pb-3.5 text-sm">
                <div>
                  <p className="mb-1 text-[13px] text-secondary">Required columns</p>
                  <dl className="divide-y divide-cream-dark">
                    {REQUIRED_COLUMNS.map(([column, meaning]) => (
                      <div key={column} className="grid gap-1 py-2 md:grid-cols-[11rem_minmax(0,1fr)] md:gap-3">
                        <dt><code className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-nav-dark">{column}</code></dt>
                        <dd className="text-secondary md:text-nav-dark">{meaning}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
                <div>
                  <p className="mb-1.5 text-[13px] text-secondary">Optional columns</p>
                  <div className="flex flex-wrap gap-1.5">
                    {OPTIONAL_COLUMN_LABELS.map((column) => (
                      <code key={column} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-nav-dark">{column}</code>
                    ))}
                  </div>
                </div>
                <p className="text-[13px] text-secondary">
                  Prices can have at most two decimal places. If any row of a quote has a problem, that whole quote is left out so nothing half-imports. PDFs and photos are read automatically, so check the results before importing.
                </p>
              </div>
            </details>
          </>
        )}

        {validation && !uploadResults && (
          <>
            <p className="text-secondary">Check what was found before anything is saved.</p>
            {file && (
              <FileRow
                file={file}
                detail={`${plural(validation.valid.length + validation.invalid.length, 'row', 'rows')} · ${fileSize(file)}`}
                action={
                  <button
                    type="button"
                    onClick={() => {
                      setFile(null);
                      setValidation(null);
                    }}
                    className={TEXT_ACTION}
                  >
                    {CHANGE_FILE_LABEL}
                  </button>
                }
              />
            )}
            <ReviewRows validation={validation} quoteCount={quoteCount} leftOutQuotes={leftOutQuotes} />
          </>
        )}

        {uploadResults && (
          <div className="space-y-4">
            <div role="status" className="flex flex-col items-center gap-2 py-2 text-center">
              <span
                className={`inline-flex h-12 w-12 items-center justify-center rounded-full ${
                  createdCount > 0 ? 'bg-crx-green-light text-crx-green' : 'bg-amber-100 text-amber-800'
                }`}
              >
                {createdCount > 0 ? <CheckCircle className="h-6 w-6" aria-hidden="true" /> : <AlertCircle className="h-6 w-6" aria-hidden="true" />}
              </span>
              <p className={`font-heading text-2xl font-semibold ${createdCount > 0 ? 'text-crx-green' : 'text-nav-dark'}`}>
                {plural(createdCount, 'quote', 'quotes')} imported
              </p>
              {uploadResults.failed > 0 && (
                <p className="text-sm font-medium text-amber-800">
                  {uploadResults.failed} could not be imported. The reasons are below.
                </p>
              )}
            </div>
            {uploadResults.details.length > 0 && (
              <ul className="divide-y divide-cream-dark overflow-hidden rounded-xl border border-gray-200 text-sm">
                {uploadResults.details.map((detail, idx) => {
                  const created = CREATED_DETAIL.test(detail);
                  return (
                    <li key={idx} className={`flex gap-2.5 px-3.5 py-2.5 ${created ? '' : 'bg-amber-50'}`}>
                      {created
                        ? <CheckCircle className="mt-0.5 h-4 w-4 flex-none text-crx-green" aria-hidden="true" />
                        : <AlertCircle className="mt-0.5 h-4 w-4 flex-none text-amber-700" aria-hidden="true" />}
                      <span className={`min-w-0 break-words ${created ? 'text-nav-dark' : 'text-amber-900'}`}>{detail}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
