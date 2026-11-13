import { useId, useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Printer } from 'lucide-react';
import type { InvoicePrintOptions } from '../../types';

interface InvoicePrintDialogProps {
  open: boolean;
  onClose: () => void;
  /** Invoice numbers being printed: one for a single print, the selection for a batch. Each becomes a file name. */
  invoiceNumbers?: string[];
  invoiceType: string;
  hasShares: boolean;
  /** A Bill Split invoice prints its payer table unless someone unticks it. */
  sharesOnByDefault?: boolean;
  onPrint: (options: InvoicePrintOptions) => void;
  loading?: boolean;
}

export default function InvoicePrintDialog({
  open,
  onClose,
  invoiceNumbers = [],
  invoiceType,
  hasShares,
  sharesOnByDefault = false,
  onPrint,
  loading = false,
}: InvoicePrintDialogProps) {
  const layoutName = `print-layout-${useId()}`;
  const count = invoiceNumbers.length;
  const isBatch = count > 1;
  const title = isBatch ? `Print ${count} invoices` : count === 1 ? `Print ${invoiceNumbers[0]}` : 'Print invoice';
  const files = invoiceNumbers.map((n) => `${n}.pdf`);
  const batchNote = isBatch
    ? `You will get ${count} files: ${count === 2 ? `${files[0]} and ${files[1]}` : `${files[0]}, ${files[1]} and ${count - 2} more`}.`
    : null;
  const isFieldApp = invoiceType === 'field_application';

  const [showShares, setShowShares] = useState(sharesOnByDefault || (isFieldApp && hasShares));
  const [showPricePerAcre, setShowPricePerAcre] = useState(isFieldApp);
  const [showEpa, setShowEpa] = useState(true);
  // Field-app parity #30: ChemMan "Print" (current) vs "Old Print" (legacy).
  const [format, setFormat] = useState<'current' | 'legacy'>('current');

  const handlePrint = () => {
    onPrint({
      show_shares: showShares,
      show_price_per_acre: showPricePerAcre,
      show_epa_registration: showEpa,
      format,
    });
  };

  return (
    <Modal open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          {isBatch ? 'Downloads one PDF for each invoice.' : 'Downloads a PDF you can print or send.'}
        </p>

        {/* Layout: current vs legacy "Old print" (field-app parity #30) */}
        <fieldset>
          <legend className="text-xs font-medium text-secondary mb-1.5">Layout</legend>
          <div role="radiogroup" aria-label="Layout" className="grid gap-2 sm:grid-cols-2">
            {([
              ['current', 'Current', 'The CRX invoice, same style as quotes'],
              ['legacy', 'Old print', 'Plain black and white, for growers who expect it'],
            ] as const).map(([value, label, hint]) => (
              <label
                key={value}
                className="flex min-h-11 md:min-h-0 cursor-pointer items-start gap-3 rounded-lg border border-gray-200 p-3 transition hover:bg-gray-50 has-[:checked]:border-crx-green has-[:checked]:bg-crx-green-tint has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-crx-green"
              >
                <input
                  type="radio"
                  name={layoutName}
                  value={value}
                  checked={format === value}
                  onChange={() => setFormat(value)}
                  className="mt-0.5 h-4 w-4 border-gray-300 text-crx-green focus:ring-crx-green"
                />
                <span>
                  <span className="block text-sm font-medium text-nav-dark">{label}</span>
                  <span className="block text-xs text-secondary">{hint}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-xs font-medium text-secondary mb-1.5">Include</legend>
          {hasShares && (
            <label className="flex min-h-11 md:min-h-0 items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={showShares}
                onChange={(e) => setShowShares(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
              />
              <div>
                {/* Only a Bill Split prints its shares by default; its payers may be landlords, not growers. */}
                <div className="text-sm font-medium text-nav-dark">{sharesOnByDefault ? 'Show who pays' : 'Show grower shares'}</div>
                <div className="text-xs text-secondary">{sharesOnByDefault ? 'Each payer, their share and amount' : 'Split percentages, acres, and amounts per grower'}</div>
              </div>
            </label>
          )}

          {isFieldApp && (
            <label className="flex min-h-11 md:min-h-0 items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={showPricePerAcre}
                onChange={(e) => setShowPricePerAcre(e.target.checked)}
                className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
              />
              <div>
                <div className="text-sm font-medium text-nav-dark">Show price per acre</div>
                <div className="text-xs text-secondary">The total cost divided by acres treated</div>
              </div>
            </label>
          )}

          <label className="flex min-h-11 md:min-h-0 items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={showEpa}
              onChange={(e) => setShowEpa(e.target.checked)}
              className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
            />
            <div>
              <div className="text-sm font-medium text-nav-dark">Show EPA registration numbers</div>
              <div className="text-xs text-secondary">A column in the product table</div>
            </div>
          </label>
        </fieldset>

        {batchNote && <p className="text-sm text-secondary">{batchNote}</p>}

        <div className="flex flex-col-reverse gap-2 pt-2 md:flex-row md:justify-end md:gap-3">
          <Button variant="ghost" className="min-h-11 md:min-h-0" onClick={onClose}>Cancel</Button>
          <Button
            className="min-h-11 md:min-h-0"
            icon={<Printer className="w-4 h-4" />}
            onClick={handlePrint}
            loading={loading}
          >
            {isBatch ? `Download ${count} PDFs` : 'Download PDF'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
