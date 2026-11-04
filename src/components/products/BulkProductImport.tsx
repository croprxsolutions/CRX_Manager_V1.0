import { useState } from 'react';
import { Upload, CheckCircle, AlertCircle, FileText, Sparkles } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';
import { supabase, checkMutationResult } from '../../lib/db';
import { isCSVFile } from '../../lib/documentOCR';
import { Sentry } from '../../lib/sentry';
import { sanitizeError } from '../../lib/errorSanitizer';
import { EPA_REGISTRATION_PATTERN } from '../../lib/productBrands';
import { listProductCategories } from '../../lib/productSetup';
import { loadProductRateLock } from '../../lib/productRateLock';
import {
  buildProductInsert,
  importRowSetsRates,
  isProductImportStringField,
  isRetiredPricingColumn,
  normalizeProductImportHeader,
  type ParsedProduct,
} from './bulkProductImportSafety';

interface BulkProductImportProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ValidationResult {
  valid: ParsedProduct[];
  invalid: Array<{ row: number; error: string; data: Record<string, string> }>;
}

const FIELD_MAPPINGS: Record<string, string[]> = {
  product_name: ['product_name', 'product', 'name', 'productname', 'item', 'item_name'],
  sku: ['sku', 'item_code', 'product_code', 'code'],
  category: ['category', 'type', 'product_type'],
  use_timing: ['use_timing', 'timing', 'application_timing', 'use timing'],
  vendor: ['vendor', 'supplier', 'distributor'],
  manufacturer: ['manufacturer', 'mfg', 'brand'],
  container_size: ['container_size', 'size', 'container', 'package_size'],
  unit_size: ['unit_size', 'unit', 'uom', 'units'],
  epa_registration: ['epa_registration', 'epa_reg', 'epa_number', 'epa', 'registration_number', 'reg_number'],
  suggested_rate: ['suggested_rate', 'rate', 'application_rate', 'use_rate'],
  rate_per_acre: ['rate_per_acre', 'acre_rate', 'per_acre', 'application_per_acre'],
  rate_unit: ['rate_unit', 'unit', 'rate_uom'],
  product_form: ['product_form', 'form', 'type_liquid_dry', 'liquid_or_dry'],
  inventory_unit: ['inventory_unit', 'inv_unit', 'pricing_unit'],
  container_unit: ['container_unit', 'pkg_unit', 'package_unit'],
  container_type: ['container_type', 'package_type', 'pkg_type'],
  notes: ['notes', 'description', 'comments', 'note'],
};

function validateImportRow(
  cols: string[], fieldMapping: Record<number, string>, allowedCategories: Set<string>, row: number,
): { product?: ParsedProduct; invalid?: ValidationResult['invalid'][number] } {
  const product: Partial<ParsedProduct> = {};
  const data: Record<string, string> = {};
  let numberError: string | null = null;
  cols.forEach((value, index) => {
    const field = fieldMapping[index];
    if (!field) return;
    data[field] = value;
    if (isProductImportStringField(field)) {
      if (value.trim()) product[field] = value;
    } else if (field === 'container_size' || field === 'rate_per_acre') {
      const trimmed = value.trim();
      if (!trimmed) return;
      const number = Number(trimmed);
      const valid = !/^0[xob]/i.test(trimmed) && Number.isFinite(number)
        && (field !== 'container_size' || number > 0) && (field !== 'rate_per_acre' || number >= 0);
      if (valid) product[field] = number;
      else numberError = field === 'container_size'
        ? 'Container size must be a number greater than 0.'
        : 'Rate Per Acre must be a number of zero or greater.';
    }
  });
  const error = !product.product_name?.trim() ? 'Missing product name'
    : numberError
      || (product.category && !allowedCategories.has(product.category.trim()) ? 'Choose an active category from the list.' : null)
      || (product.epa_registration && !EPA_REGISTRATION_PATTERN.test(product.epa_registration.trim())
        ? 'EPA number must look like 524-475 or 100-1234-5905. This checks format only.' : null);
  return error ? { invalid: { row, error, data } } : { product: product as ParsedProduct };
}

export default function BulkProductImport({ open, onClose, onSuccess }: BulkProductImportProps) {
  const { toast } = useToast();
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [uploadResults, setUploadResults] = useState<{ success: number; failed: number; errors: string[] } | null>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
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
      setValidation(null);
      setUploadResults(null);
    }
  };

  const detectFieldMapping = (header: string): string | null => {
    const normalized = normalizeProductImportHeader(header);
    for (const [field, aliases] of Object.entries(FIELD_MAPPINGS)) {
      if (aliases.includes(normalized)) {
        return field;
      }
    }
    return null;
  };

  const MAX_ROWS = 500;

  /** Parse a single CSV line respecting quoted fields (handles commas inside quotes) */
  const parseCSVLine = (line: string): string[] => {
    const result: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++; // skip escaped quote
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ',') {
          result.push(current.trim());
          current = '';
        } else {
          current += ch;
        }
      }
    }
    result.push(current.trim());
    return result;
  };

  const parseCSV = (text: string): { headers: string[]; rows: string[][] } => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return { headers: [], rows: [] };

    const headers = parseCSVLine(lines[0]);
    const rows: string[][] = [];

    for (let i = 1; i < lines.length; i++) {
      const cols = parseCSVLine(lines[i]);
      if (cols.some((value) => value.trim() !== '')) {
        rows.push(cols);
      }
    }

    return { headers, rows };
  };

  const handleParse = async () => {
    if (!file) return;
    setParsing(true);

    try {
      const text = await file.text();
      const { headers, rows } = parseCSV(text);

      const pricingHeaders = headers.filter(isRetiredPricingColumn);
      if (pricingHeaders.length > 0) {
        toast(
          'error',
          `Pricing columns are not allowed in Bulk Product Import: ${pricingHeaders.join(', ')}. Use the governed pricing worksheet or Product page instead.`,
        );
        setParsing(false);
        return;
      }

      if (rows.length === 0) {
        toast('error', 'No valid data found in file');
        setParsing(false);
        return;
      }

      if (rows.length > MAX_ROWS) {
        toast('error', `File has ${rows.length} rows. Maximum is ${MAX_ROWS}. Please split your file into smaller batches.`);
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

      if (!Object.values(fieldMapping).includes('product_name')) {
        toast('error', 'Could not find product name column. Ensure your CSV has a "product_name" or "product" column.');
        setParsing(false);
        return;
      }

      const categories = await listProductCategories();
      const allowedCategories = new Set(categories.filter((category) => category.is_active).map((category) => category.name));
      const valid: ParsedProduct[] = [];
      const invalid: Array<{ row: number; error: string; data: Record<string, string> }> = [];

      rows.forEach((cols, idx) => {
        const result = validateImportRow(cols, fieldMapping, allowedCategories, idx + 2);
        if (result.invalid) invalid.push(result.invalid);
        else if (result.product) valid.push(result.product);
      });

      setValidation({ valid, invalid });
    } catch (error) {
      Sentry.captureException(error);
      toast('error', 'Could not read the category list or parse the file. Try again.');
    }
    setParsing(false);
  };

  const handleUpload = async () => {
    if (!validation || validation.valid.length === 0) return;
    setUploading(true);

    // While rates are locked every row with a rate would be refused one by one, leaving half a file
    // imported, so check once and import nothing.
    const rated = validation.valid.filter(importRowSetsRates).length;
    if (rated > 0) {
      let locked: boolean;
      try {
        locked = (await loadProductRateLock()).is_locked;
      } catch (error) {
        Sentry.captureException(error);
        locked = true;
      }
      if (locked) {
        toast('error', `Nothing was imported: ${rated} row${rated === 1 ? ' sets' : 's set'} a rate, and rates are locked or could not be checked. Remove the rate columns, or ask an admin to unlock rates.`);
        setUploading(false);
        return;
      }
    }

    let success = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const product of validation.valid) {
      const productResult = await supabase.from('products').insert(buildProductInsert(product)).select('id');

      if (productResult.error) {
        Sentry.captureException(productResult.error instanceof Error ? productResult.error : new Error(String(productResult.error)), { extra: { context: 'Failed to insert product' } });
        failed++;
        errors.push(`${product.product_name}: ${sanitizeError(productResult.error)}`);
      } else {
        try { checkMutationResult(productResult, 'Insert product'); } catch (e) {
          Sentry.captureException(e instanceof Error ? e : new Error(String(e)));
          failed++;
          errors.push(`${product.product_name}: ${sanitizeError(e)}`);
          continue;
        }
        success++;
      }
    }

    setUploadResults({ success, failed, errors });
    setUploading(false);

    if (success > 0) {
      toast('success', `Successfully imported ${success} product(s)`);
      onSuccess();
    }
    if (failed > 0) {
      toast('error', `Failed to import ${failed} product(s)`);
    }
  };

  const handleClose = () => {
    setFile(null);
    setValidation(null);
    setUploadResults(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={handleClose} title="Bulk Product" accent="Import" maxWidth="max-w-3xl">
      <div className="space-y-4">
        <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg">
          <h4 className="text-sm font-medium text-nav-dark mb-2 flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-600" />
            How to Import
          </h4>
          <ol className="text-xs text-secondary space-y-1 list-decimal list-inside">
            <li>Upload a CSV containing product identity and catalog details</li>
            <li>Include a product_name column</li>
            <li>Review detected products and import</li>
          </ol>
          <div className="mt-3 p-2 bg-white rounded border border-gray-200">
            <p className="text-xs font-medium text-secondary mb-1">Supported Columns:</p>
            <p className="text-xs text-gray-500 font-mono">
              product_name, sku, category, vendor, manufacturer, container_size, unit_size,
              epa_registration, suggested_rate, rate_per_acre, rate_unit, product_form,
              inventory_unit, container_unit, container_type, use_timing, notes
            </p>
            <p className="text-xs text-gray-500 mt-2">For several use timings, separate labels with a semicolon (for example, Pre-Emerge; Post-Emergence).</p>
            <p className="text-xs text-amber-700 mt-2">
              Pricing columns are rejected. Update cost, margins, and tier prices from the Product page or governed pricing worksheet.
            </p>
          </div>
        </div>

        {!validation && !uploadResults && (
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

        {validation && !uploadResults && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="p-4 bg-green-50 border border-green-100 rounded-lg">
                <div className="flex items-center gap-2 mb-1">
                  <CheckCircle className="w-5 h-5 text-green-600" />
                  <span className="text-sm font-medium text-secondary">Valid Products</span>
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
                  {validation.valid.slice(0, 5).map((product, idx) => (
                    <div key={idx} className="text-xs bg-white p-2 rounded border border-gray-100">
                      <p className="font-medium text-nav-dark">{product.product_name}</p>
                      {product.sku && <p className="text-gray-500">SKU: {product.sku}</p>}
                      {product.category && <p className="text-gray-500">Category: {product.category}</p>}
                      {product.rate_per_acre && <p className="text-gray-500">Rate/Acre: {product.rate_per_acre} {product.rate_unit || ''}</p>}
                    </div>
                  ))}
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

          </div>
        )}

        {uploadResults && (
          <div className="p-4 bg-green-50 border border-green-100 rounded-lg text-center">
            <CheckCircle className="w-12 h-12 text-green-600 mx-auto mb-2" />
            <h4 className="text-sm font-medium text-nav-dark mb-1">Import Complete</h4>
            <p className="text-xs text-secondary">
              Successfully imported {uploadResults.success} product(s)
              {uploadResults.failed > 0 && `, ${uploadResults.failed} failed`}
            </p>
          </div>
        )}
        {uploadResults && uploadResults.errors.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded-lg border border-red-200 bg-red-50 p-3" role="status">
            <p className="text-sm font-medium text-red-800">Products that need a correction</p>
            {uploadResults.errors.map((error, index) => <p key={index} className="mt-1 text-xs text-red-800">{error}</p>)}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={handleClose}>
            {uploadResults ? 'Close' : 'Cancel'}
          </Button>
          {!validation && !uploadResults && (
            <Button
              icon={<Upload className="w-4 h-4" />}
              onClick={handleParse}
              disabled={!file || parsing}
              loading={parsing}
            >
              {parsing ? 'Parsing...' : 'Parse File'}
            </Button>
          )}
          {validation && !uploadResults && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
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
                Import {validation.valid.length} Product(s)
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}
