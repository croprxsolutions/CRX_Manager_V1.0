import { useState } from 'react';
import type { Customer, Product, SalesSheetFormat } from '../../types';
import { exportToCSV, fmtCSV } from '../../lib/csvExport';
import { sanitizeError } from '../../lib/db';
import { formatUSD } from '../../lib/money';
import { downloadReportPdf } from '../../lib/reportPdf';
import CustomerSearchPicker, {
  CUSTOMER_SEARCH_SELECT,
  type CustomerSearchResult,
} from '../customers/CustomerSearchPicker';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';

type SalesSheetProduct = Pick<
  Product,
  'id' | 'product_name' | 'sku' | 'category' | 'vendor' | 'container_size' | 'unit_size'
  | 'tier1_price' | 'tier2_price' | 'tier3_price'
>;

type SalesSheetCustomer = CustomerSearchResult & Pick<Customer, 'assigned_tier'>;

type Props = {
  format: SalesSheetFormat;
  /** Active products only: this is what the customer is handed. */
  products: readonly SalesSheetProduct[];
  onClose: () => void;
};

const CUSTOMER_SELECT = `${CUSTOMER_SEARCH_SELECT}, assigned_tier`;

/** The one price this customer pays; null means the product has no price at their level. */
function customerSheetPrice(product: SalesSheetProduct, tier: number): number | null {
  return tier === 1 ? product.tier1_price : tier === 2 ? product.tier2_price : tier === 3 ? product.tier3_price : null;
}

function sheetRows(products: readonly SalesSheetProduct[], tier: number) {
  // Named fields only, so the other prices never reach the file.
  return products.map((product) => ({
    product_name: product.product_name,
    sku: product.sku,
    category: product.category,
    vendor: product.vendor,
    container_size: product.container_size,
    unit_size: product.unit_size,
    price: customerSheetPrice(product, tier),
  }));
}

async function downloadSheet(format: SalesSheetFormat, customer: SalesSheetCustomer, tier: number, products: readonly SalesSheetProduct[]) {
  const rows = sheetRows(products, tier);
  const slug = customer.farm_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const fileName = slug ? `sales-sheet-${slug}` : 'sales-sheet';
  if (format === 'csv') {
    exportToCSV(rows, [
      { key: 'product_name', header: 'Product Name' },
      { key: 'sku', header: 'SKU' },
      { key: 'category', header: 'Category' },
      { key: 'vendor', header: 'Vendor' },
      { key: 'container_size', header: 'Container Size' },
      { key: 'unit_size', header: 'Unit' },
      { key: 'price', header: 'Price', format: (value) => value == null ? '' : fmtCSV(value) },
    ], fileName);
    return;
  }
  await downloadReportPdf({
    title: 'Product Sales Sheet',
    fileName,
    subtitle: `Prepared for ${customer.farm_name} — ${new Date().toLocaleDateString()}`,
    columns: [
      { header: 'Product', key: 'product_name' },
      { header: 'SKU', key: 'sku', format: (value) => String(value || '-') },
      { header: 'Category', key: 'category', format: (value) => String(value || '-') },
      { header: 'Size', key: 'container_size', format: (value) => value != null ? String(value) : '-' },
      { header: 'Unit', key: 'unit_size', format: (value) => String(value || '-') },
      { header: 'Price', key: 'price', align: 'right', format: (value) => value != null ? formatUSD(Number(value)) : '' },
    ],
    data: rows,
    orientation: 'landscape',
  });
}

/** Sales sheets are made for one customer, at that customer's price, and never name a tier. */
export default function CustomerSalesSheetModal({ format, products, onClose }: Props) {
  const { toast } = useToast();
  const [customer, setCustomer] = useState<SalesSheetCustomer | null>(null);
  const [downloading, setDownloading] = useState(false);

  const tier = customer && [1, 2, 3].includes(customer.assigned_tier) ? customer.assigned_tier : null;
  const unpriced = tier == null ? [] : products.filter((product) => customerSheetPrice(product, tier) == null).map((product) => product.product_name);
  // Name a few so a missing price is found before the sheet goes out (WP-PM-6b); a real $0 prints as $0.00.
  const unpricedNames = unpriced.length > 3 ? `${unpriced.slice(0, 3).join(', ')} and ${unpriced.length - 3} more` : unpriced.join(', ');

  const handleDownload = async () => {
    if (!customer || tier == null) return;
    setDownloading(true);
    try {
      await downloadSheet(format, customer, tier, products);
      toast('success', `Downloaded sales sheet for ${customer.farm_name}`);
      onClose();
    } catch (err) {
      toast('error', sanitizeError(err));
      setDownloading(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={downloading}
      title="Customer Sales Sheet"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={downloading}>Cancel</Button>
          <Button onClick={() => void handleDownload()} loading={downloading} disabled={tier == null}>
            Download {format === 'pdf' ? 'PDF' : 'CSV'}
          </Button>
        </>
      )}
    >
      <div className="min-h-64 space-y-3">
        <div>
          <label htmlFor="sales-sheet-customer" className="mb-1 block text-sm font-medium text-gray-700">Customer</label>
          <CustomerSearchPicker<SalesSheetCustomer>
            id="sales-sheet-customer"
            value={customer?.id ?? ''}
            selectedLabel={customer?.farm_name ?? ''}
            onSelect={setCustomer}
            select={CUSTOMER_SELECT}
            ariaLabel="Customer"
          />
        </div>
        {customer && tier == null ? (
          <p role="alert" className="text-sm text-red-600">
            {customer.farm_name} has no price level set. Set one on their customer page, then download the sheet.
          </p>
        ) : (
          <p className="text-sm text-secondary">
            {products.length} active product{products.length === 1 ? '' : 's'}, shown at this customer&apos;s price only.
            {unpriced.length > 0 && ` No price, so shown blank: ${unpricedNames}.`}
          </p>
        )}
      </div>
    </Modal>
  );
}
