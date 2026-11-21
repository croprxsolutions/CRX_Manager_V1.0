import { useRef, useState } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText, Sparkles } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import { useToast } from '../ui/Toast';
import { supabase, assertRpcResult, sanitizeError } from '../../lib/db';
import { processDocumentWithOCR, isCSVFile, isOCRSupported } from '../../lib/documentOCR';
import { Sentry } from '../../lib/sentry';
import { loadDefaultTier } from '../../lib/appSettingDefaults';
import { useAuth } from '../../contexts/AuthContext';
import { toSentryError } from '../../lib/sentryError';
import { ACRE_FIELDS, CsvError, cropAcresOverTotal, cropSplitWarning, parseCSVRecords, readAcres, type CsvRecord, type ParsedCustomer } from './bulkImportCsv';

interface BulkCustomerImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

// row = the file's line number (OCR: the item's position); key = this row's save_customer idempotency key.
type ImportRow = ParsedCustomer & { row: number; key: string };
// retry = the unanswered row itself, re-sent with its original key so a save that did land is not made twice.
type FailedRow = { row: number; farm_name: string; error: string; retry?: ImportRow };


interface ValidationResult {
  valid: ImportRow[];
  invalid: Array<{ row: number; error: string; data: Record<string, string> }>;
  /** Rows that still import but should be checked. */
  warnings?: Array<{ row: number; warning: string }>;
}

const UNCONFIRMED = 'No answer from the server: this customer may have saved. Use Retry below rather than importing the file again: Retry will not save it twice.';

const FIELD_MAPPINGS: Record<string, string[]> = {
  farm_name: ['farm_name', 'farm', 'farm_name', 'customer', 'customer_name', 'business_name'],
  contact_name: ['contact_name', 'contact', 'name', 'owner', 'primary_contact'],
  phone: ['phone', 'phone_number', 'telephone', 'mobile', 'cell'],
  email: ['email', 'email_address', 'e-mail'],
  billing_address: ['billing_address', 'address', 'billing', 'mailing_address', 'street_address'],
  assigned_tier: ['assigned_tier', 'tier', 'price_tier', 'pricing_tier', 'customer_tier'],
  total_acres: ['total_acres', 'acres', 'farm_acres', 'total_farm_acres'],
  corn_acres: ['corn_acres', 'corn', 'acres_corn'],
  soybean_acres: ['soybean_acres', 'soybeans', 'soybean', 'acres_soybeans'],
  other_acres: ['other_acres', 'other', 'misc_acres'],
  payment_terms: ['payment_terms', 'terms', 'payment', 'net_terms'],
  notes: ['notes', 'comments', 'note', 'description'],
};

export default function BulkCustomerImport({ open, onClose, onSuccess }: BulkCustomerImportProps) {
  const { toast } = useToast();
  // Price tiers are admin-only (Mason 2026-11-01): a rep's rows always start on the Default Tier.
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [uploadResults, setUploadResults] = useState<{ success: number; failed: FailedRow[]; skipped: number } | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  // Bumped when the file changes or the modal closes, so a slow parse of an older file is dropped.
  const parseRun = useRef(0);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      // Any new pick, even a rejected one, retires the old preview and any parse still running.
      parseRun.current++;
      setParsing(false);
      setValidation(null);
      setUploadResults(null);
      if (selectedFile.size > 10 * 1024 * 1024) {
        toast('error', 'File too large. Maximum size is 10MB.');
        e.target.value = '';
        setFile(null);
        return;
      }
      const isCSV = isCSVFile(selectedFile);
      const isOCR = isOCRSupported(selectedFile);
      if (!isCSV && !isOCR) {
        toast('error', 'Invalid file type. Please upload a CSV, PDF, or image file.');
        e.target.value = '';
        setFile(null);
        return;
      }
      setFile(selectedFile);
    }
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

  const MAX_ROWS = 500;

  const parseCSV = (text: string): { headers: string[]; rows: CsvRecord[] } => {
    // Only a fully empty record is skipped: a blank first cell is checked below, not dropped (KI-145).
    const [header, ...rows] = parseCSVRecords(text).filter((r) => r.cols.some(Boolean));
    return { headers: header?.cols ?? [], rows };
  };

  const parseWithVisionOCR = async (file: File, defaultTier: number, say: typeof toast): Promise<ValidationResult> => {
    const result = await processDocumentWithOCR(file, 'customer_list');

    if (!result.success || !result.parsed_data) {
      say('error', result.error || 'OCR processing failed. Try a clearer image or CSV instead.');
      return { valid: [], invalid: [] };
    }

    const data = result.parsed_data as {
      items?: Array<{
        farm_name: string;
        contact_name?: string;
        phone?: string;
        email?: string;
        address?: string;
        tier?: number;
      }>;
    };

    if (!data.items || data.items.length === 0) {
      say('error', 'No customers found in document.');
      return { valid: [], invalid: [] };
    }

    if (data.items.length > MAX_ROWS) {
      say('error', `Document has ${data.items.length} customers. Maximum is ${MAX_ROWS}. Please split it into smaller batches.`);
      return { valid: [], invalid: [] };
    }

    const valid: ImportRow[] = [];
    const invalid: ValidationResult['invalid'] = [];

    data.items.forEach((item, idx) => {
      if (!item.farm_name?.trim()) {
        invalid.push({ row: idx + 1, error: 'Missing farm name', data: { ...item } as unknown as Record<string, string> });
        return;
      }
      valid.push({
        row: idx + 1,
        key: crypto.randomUUID(),
        farm_name: item.farm_name.trim(),
        contact_name: item.contact_name,
        phone: item.phone,
        email: item.email,
        billing_address: item.address,
        // process-document never reads a tier from the page (its tier is always a filler 1).
        assigned_tier: defaultTier,
      });
    });

    return { valid, invalid };
  };

  const handleParse = async () => {
    if (!file) return;
    // The rep/admin rules below depend on who is signed in; never guess while the profile is loading.
    if (!profile?.id) {
      toast('error', 'Your profile is still loading. Try again in a moment.');
      return;
    }
    const run = ++parseRun.current;
    // A parse retired by a newer file pick (or by closing) stays silent.
    const say: typeof toast = (...args) => { if (run === parseRun.current) toast(...args); };
    setParsing(true);

    try {
      // A row without a tier starts on the Settings Default Tier.
      const defaultTier = await loadDefaultTier();
      // Route: CSV → client-side parser, PDF/Image → Vision OCR
      if (!isCSVFile(file)) {
        const ocrResult = await parseWithVisionOCR(file, defaultTier, say);
        if (run === parseRun.current) setValidation(ocrResult);
        if (run === parseRun.current) setParsing(false);
        return;
      }

      const text = await file.text();
      const { headers, rows } = parseCSV(text);

      if (rows.length === 0) {
        say('error', 'No valid data found in file');
        if (run === parseRun.current) setParsing(false);
        return;
      }

      if (rows.length > MAX_ROWS) {
        say('error', `File has ${rows.length} rows. Maximum is ${MAX_ROWS}. Please split your file into smaller batches.`);
        if (run === parseRun.current) setParsing(false);
        return;
      }

      const fieldMapping: Record<number, string> = {};
      headers.forEach((header, idx) => {
        const field = detectFieldMapping(header);
        if (field) {
          fieldMapping[idx] = field;
        }
      });

      if (!Object.values(fieldMapping).includes('farm_name')) {
        say('error', 'Could not find farm name column. Ensure your CSV has a "farm_name" or "farm" column.');
        if (run === parseRun.current) setParsing(false);
        return;
      }

      const valid: ImportRow[] = [];
      const invalid: ValidationResult['invalid'] = [];
      const warnings: NonNullable<ValidationResult['warnings']> = [];

      rows.forEach(({ line, cols, quoted }) => {
        const customer: Partial<ParsedCustomer> = {};
        const rowData: Record<string, string> = {};
        let badValue = '';
        let splitWarning = '';

        // An unquoted "1,200" splits into extra cells and shifts every later column.
        if (cols.length > headers.length) {
          invalid.push({ row: line, error: 'More values than column headers. Put quotes around numbers with commas, like "1,200"', data: rowData });
          return;
        }

        cols.forEach((value, colIdx) => {
          const field = fieldMapping[colIdx];
          if (field) {
            rowData[field] = value;

            if (field === 'farm_name' || field === 'contact_name' || field === 'phone' ||
                field === 'email' || field === 'billing_address' || field === 'payment_terms' ||
                field === 'notes') {
              if (value) customer[field] = value;
            } else if ((ACRE_FIELDS as readonly string[]).includes(field)) {
              if (value) {
                const acres = readAcres({ cols, quoted }, colIdx, field, fieldMapping[colIdx + 1]);
                if (typeof acres === 'string') badValue ||= acres;
                else customer[field as typeof ACRE_FIELDS[number]] = acres;
                splitWarning ||= cropSplitWarning({ cols, quoted }, colIdx, field, fieldMapping[colIdx + 1]);
              }
            } else if (field === 'assigned_tier' && isAdmin) {
              // The tier sets prices: an unclear one is an invalid row, never a guess or the default.
              if (/^[123]$/.test(value)) customer[field] = Number(value);
              else if (value) badValue ||= `Invalid tier: ${value}`;
            }
          }
        });

        if (!customer.farm_name) {
          invalid.push({
            row: line,
            error: 'Missing farm name',
            data: rowData,
          });
          return;
        }

        if (badValue) {
          invalid.push({ row: line, error: badValue, data: rowData });
          return;
        }

        // Validate email format if provided
        if (customer.email) {
          const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
          if (!emailRegex.test(customer.email)) {
            invalid.push({
              row: line,
              error: `Invalid email: ${customer.email}`,
              data: rowData,
            });
            return;
          }
        }

        if (!customer.assigned_tier) {
          customer.assigned_tier = defaultTier;
        }

        const overTotal = cropAcresOverTotal(customer);
        if (overTotal) warnings.push({ row: line, warning: overTotal });
        if (splitWarning) warnings.push({ row: line, warning: splitWarning });
        valid.push({ ...(customer as ParsedCustomer), row: line, key: crypto.randomUUID() });
      });

      if (run === parseRun.current) setValidation({ valid, invalid, warnings });
    } catch (e) {
      say('error', e instanceof CsvError ? e.message : 'Failed to parse file. Please ensure it is a valid CSV.');
    }
    if (run === parseRun.current) setParsing(false);
  };

  const saveRows = async (rows: ImportRow[]) => {
    let success = 0;
    const failed: FailedRow[] = [];

    // Each row goes through save_customer, as the New Customer page does: the server checks the
    // actor, role, a rep's self-assignment and tier, and writes the activity row (KI-145).
    for (const importRow of rows) {
      const { row, key, ...customer } = importRow;
      try {
        const { data, error } = await supabase.rpc('save_customer', {
          // save_customer accepts NULL p_customer_id to create (the generated type narrows it to string).
          p_customer_id: null as unknown as string,
          // A rep must assign the customer to themselves; an admin's import stays unassigned, as before.
          p_customer_payload: { ...customer, assigned_sales_rep: isAdmin ? null : profile?.id ?? null, is_active: true },
          p_addresses: [],
          p_performed_by: profile?.id as string,
          p_idempotency_key: key,
        });
        if (error) {
          // A database refusal has a code; without one the request may never have been answered.
          if (error.code) failed.push({ row, farm_name: customer.farm_name, error: sanitizeError(error) });
          else failed.push({ row, farm_name: customer.farm_name, error: UNCONFIRMED, retry: importRow });
          if (!error.code) Sentry.captureException(toSentryError(error), { extra: { context: 'Bulk customer import row' } });
          continue;
        }
        assertRpcResult(data, 'save_customer');
        success++;
      } catch (e) {
        Sentry.captureException(toSentryError(e), { extra: { context: 'Bulk customer import row' } });
        failed.push({ row, farm_name: customer.farm_name, error: UNCONFIRMED, retry: importRow });
      }
    }

    if (success > 0) {
      toast('success', `Successfully imported ${success} customer(s)`);
      onSuccess();
    }
    if (failed.length > 0) {
      toast('error', `Failed to import ${failed.length} customer(s)`);
    }
    return { success, failed };
  };

  const handleUpload = async () => {
    if (!validation || validation.valid.length === 0) return;
    setUploading(true);
    const { success, failed } = await saveRows(validation.valid);
    setUploadResults({ success, failed, skipped: validation.invalid.length });
    setUploading(false);
  };

  // Re-sends only the unanswered rows, each with its original key: one that did save comes back as saved.
  const handleRetry = async () => {
    if (!uploadResults) return;
    setUploading(true);
    const result = await saveRows(uploadResults.failed.flatMap((f) => (f.retry ? [f.retry] : [])));
    setUploadResults({
      success: uploadResults.success + result.success,
      failed: [...uploadResults.failed.filter((f) => !f.retry), ...result.failed].sort((a, b) => a.row - b.row),
      skipped: uploadResults.skipped,
    });
    setUploading(false);
  };

  const unanswered = uploadResults?.failed.filter((f) => f.retry).length ?? 0;

  const handleClose = () => {
    if (uploading) return; // closing mid-import would hide which rows saved
    // Closing drops the unanswered rows' keys; re-importing the file then gets new keys and can save them twice.
    if (unanswered > 0 && !confirmClose) {
      setConfirmClose(true);
      return;
    }
    setConfirmClose(false);
    parseRun.current++;
    setParsing(false);
    setFile(null);
    setValidation(null);
    setUploadResults(null);
    onClose();
  };

  return (
    <>
    {/* While the confirm is open, Escape, the X and the backdrop close only the confirm, never the import. */}
    <Modal open={open} onClose={handleClose} closeDisabled={confirmClose} title="Bulk Customer" accent="Import" maxWidth="max-w-3xl">
      <div className="space-y-4">
        <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
          <h4 className="text-sm font-medium text-nav-dark mb-2 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-600" />
            How to Import
          </h4>
          <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
            <li>Upload a CSV, PDF customer list, or photo of a customer sheet</li>
            <li>Ensure your file has farm/customer names</li>
            <li>PDF/image files are processed with Google Vision OCR</li>
            <li>Review detected customers and import</li>
          </ol>
          <div className="mt-3 p-2 bg-white rounded border border-gray-200">
            <p className="text-xs font-medium text-secondary mb-1">Supported Columns:</p>
            <p className="text-xs text-gray-500 font-mono">
              farm_name (required), contact_name, phone, email, billing_address, assigned_tier (1-3),
              total_acres, corn_acres, soybean_acres, other_acres, payment_terms, notes
            </p>
            <p className="text-xs text-green-600 mt-2">
              💡 <span className="font-medium">Tip:</span> Tier defaults to the Settings Default Tier if not specified. Valid tiers are 1, 2, or 3.
            </p>
            {!isAdmin && (
              <p className="text-xs text-secondary mt-1">
                Every customer you import starts on the Settings Default Tier: only an admin can set a customer&apos;s tier.
              </p>
            )}
          </div>
        </div>

        {!validation && !uploadResults && (
          <div>
            <label className="block text-sm font-medium text-secondary mb-2">Select File</label>
            <input
              type="file"
              accept=".csv,.pdf,.jpg,.jpeg,.png,.webp,image/*"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-crx-green-light file:text-crx-green file:hover:bg-crx-green file:hover:text-white transition-colors cursor-pointer"
            />
            {file && (
              <div className="mt-2 flex items-center gap-2 text-xs text-secondary">
                <FileText className="w-4 h-4" />
                <span>{file.name} ({(file.size / 1024).toFixed(1)} KB)</span>
                {!isCSVFile(file) && <span className="text-blue-600">(Vision OCR)</span>}
              </div>
            )}
          </div>
        )}

        {validation && !uploadResults && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 bg-green-50 border border-green-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-sm font-medium text-secondary">Valid Customers</span>
                </div>
                <p className="text-2xl font-semibold text-green-600">{validation.valid.length}</p>
                <p className="text-xs text-secondary mt-1">Ready to import</p>
              </div>
              <div className="p-4 bg-red-50 border border-red-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <AlertCircle className="w-5 h-5 text-red-600" />
                  <span className="text-sm font-medium text-secondary">Invalid Rows</span>
                </div>
                <p className="text-2xl font-semibold text-red-600">{validation.invalid.length}</p>
                <p className="text-xs text-secondary mt-1">Will be skipped</p>
              </div>
            </div>

            {validation.valid.length > 0 && (
              <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg max-h-48 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-2">Preview (first 5):</p>
                <div className="space-y-2">
                  {validation.valid.slice(0, 5).map((customer, idx) => (
                    <div key={idx} className="text-xs bg-white p-2 rounded border border-gray-100">
                      <p className="font-medium text-nav-dark">{customer.farm_name}</p>
                      {customer.contact_name && <p className="text-gray-500">Contact: {customer.contact_name}</p>}
                      {customer.phone && <p className="text-gray-500">Phone: {customer.phone}</p>}
                      {customer.email && <p className="text-gray-500">Email: {customer.email}</p>}
                      <p className="text-gray-500">Tier: {customer.assigned_tier}</p>
                      {customer.total_acres && <p className="text-gray-500">Acres: {customer.total_acres.toLocaleString()}</p>}
                    </div>
                  ))}
                  {validation.valid.length > 5 && (
                    <p className="text-xs text-secondary text-center pt-1">
                      + {validation.valid.length - 5} more customers
                    </p>
                  )}
                </div>
              </div>
            )}

            {validation.invalid.length > 0 && (
              <div className="p-3 bg-red-50 border border-red-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-1">Invalid Rows:</p>
                <div className="space-y-1">
                  {validation.invalid.map((inv, idx) => (
                    <p key={idx} className="text-xs text-secondary">
                      Row {inv.row}: {inv.error}
                    </p>
                  ))}
                </div>
              </div>
            )}

            {!!validation.warnings?.length && (
              <div className="p-3 bg-amber-50 border border-amber-100 rounded-lg max-h-32 overflow-y-auto">
                <p className="text-xs font-medium text-secondary mb-1">Will import, but check these rows:</p>
                <div className="space-y-1">
                  {validation.warnings.map((w, idx) => (
                    <p key={idx} className="text-xs text-secondary">
                      Row {w.row}: {w.warning}
                    </p>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {uploadResults && (
          <div className="p-4 bg-green-50 border border-green-100 rounded-lg text-center">
            {uploadResults.success > 0
              ? <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-2" />
              : <AlertCircle className="w-12 h-12 text-red-600 mx-auto mb-2" />}
            <h4 className="text-sm font-medium text-nav-dark mb-1">Import Complete</h4>
            <p className="text-xs text-secondary">
              Successfully imported {uploadResults.success} customer(s)
              {uploadResults.failed.length > 0 && `, ${uploadResults.failed.length} failed`}
              {uploadResults.skipped > 0 && `, ${uploadResults.skipped} invalid row(s) skipped`}
            </p>
            {uploadResults.failed.length > 0 && (
              <div className="mt-3 p-3 bg-red-50 border border-red-100 rounded-lg max-h-32 overflow-y-auto text-left space-y-1">
                {uploadResults.failed.map((f) => (
                  <p key={f.row} className="text-xs text-secondary">Row {f.row} ({f.farm_name}): {f.error}</p>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose} disabled={uploading}>
            {uploadResults ? 'Close' : 'Cancel'}
          </Button>
          {uploadResults?.failed.some((f) => f.retry) && (
            <Button onClick={handleRetry} disabled={uploading} loading={uploading}>
              Retry {unanswered} Unanswered Row(s)
            </Button>
          )}
          {!validation && !uploadResults && (
            <Button
              icon={<Upload className="w-4 h-4" />}
              onClick={handleParse}
              disabled={!file || parsing}
              loading={parsing}
            >
              {file && !isCSVFile(file) ? (parsing ? 'Processing with Vision OCR...' : 'Process with Vision OCR') : 'Parse File'}
            </Button>
          )}
          {validation && !uploadResults && (
            <>
              <Button
                variant="secondary"
                disabled={uploading}
                onClick={() => {
                  parseRun.current++;
                  setFile(null);
                  setValidation(null);
                }}
              >
                Choose Different File
              </Button>
              <Button
                onClick={handleUpload}
                disabled={validation.valid.length === 0 || uploading}
                loading={uploading}
              >
                Import {validation.valid.length} Customer(s)
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
    <ConfirmModal
      open={confirmClose}
      onClose={() => setConfirmClose(false)}
      onConfirm={handleClose}
      title="Close without retrying?"
      message={`${unanswered} row(s) got no answer from the server and may have saved. Retry is the safe way to finish them. If you close and import the file again, those customers can be saved twice.`}
      confirmLabel="Close anyway"
      cancelLabel="Go back"
      variant="warning"
    />
    </>
  );
}
