import { useState } from 'react';
import {
  pricingAcknowledgements,
  type PricingAcknowledgement,
  type PricingEffect,
  type PricingPreviewResult,
  type PricingPreviewRow,
} from '../../lib/productPricing';
import type { ProductCostBasisType } from '../../types';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import PricingWarningAcknowledgements from './PricingWarningAcknowledgements';

interface PricingChangePreviewModalProps {
  open: boolean;
  preview: PricingPreviewResult | null;
  applying: boolean;
  title?: string;
  onClose: () => void;
  /** Receives one acknowledgement per warned product; the caller approves, then applies. */
  onApprove: (acknowledgements: PricingAcknowledgement[]) => void;
}

const ERROR_MESSAGES: Record<string, string> = {
  PRICING_ROW_CONFLICT:
    'This product changed after the pricing data was loaded. Refresh the product and preview it again.',
  PRICING_REASON_REQUIRED:
    'Give a reason for this price or cost change (the change_reason column on a price sheet).',
  PRICING_SOURCE_REQUIRED:
    'Say where the new price or cost came from, such as a supplier quote (the price_source column on a price sheet).',
  // The database refuses these before saving anything; say which cell rule broke, not the code.
  PRICING_DOLLARS_INVALID:
    'A price or cost on this row is not a plain dollar amount. Type numbers only, with at most 2 decimals, like 12.34: no $ sign, commas, letters or minus sign. The cost and any tier price you change cannot be blank.',
  PRICING_PRICE_INVALID:
    'A tier price must be 0 or more, with at most 2 decimals.',
  PRICING_COST_INVALID:
    'The cost must be 0 or more, with at most 2 decimals. A margin-driven row needs a cost above 0.',
  PRICING_MARGIN_PERCENT_INVALID:
    'Each margin % must be a plain number from 0 up to, but not including, 100, like 18.5.',
  PRICING_MARGIN_INVALID:
    'Each margin % must be from 0 up to, but not including, 100.',
  PRICE_DRIVEN_FIELDS_INVALID:
    'A price-driven change needs all three tier prices filled in, and no margin % changes.',
  MARGIN_DRIVEN_FIELDS_INVALID:
    'A margin-driven change needs all three tier margin % values filled in, and no price changes.',
  PRICE_DRIVEN_COMPANION_FIELDS_CHANGED:
    'This row is price-driven, so its margin % cells must stay as downloaded. Change the prices, or set pricing_mode to margin_driven to change margins.',
  MARGIN_DRIVEN_COMPANION_FIELDS_CHANGED:
    'This row is margin-driven, so its price cells must stay as downloaded. Change the margins, or set pricing_mode to price_driven to change prices.',
  PRICING_MODE_INVALID:
    'Choose price_driven or margin_driven in the pricing_mode column.',
  PRICING_ZERO_PRICE_BELOW_COST:
    'A tier price of 0 is below this product\'s cost. Enter the real price.',
  PRICING_PRODUCT_INACTIVE:
    'This product is turned off, so its prices cannot be changed here.',
  WORKBOOK_UNKNOWN_PRODUCT:
    'This product was not in the price sheet you downloaded. Download a fresh price sheet to price it.',
  PRICING_REASON_TOO_LONG:
    'The reason is longer than 500 characters. Shorten it and try again.',
  PRICING_SOURCE_TOO_LONG:
    'The source is longer than 200 characters. Shorten it and try again.',
  WORKBOOK_FORMULA_REJECTED:
    'This row contains an Excel formula. Replace the formula with a plain value and upload the worksheet again.',
  WORKBOOK_IDENTITY_OR_BASELINE_TAMPERED:
    'Protected product or baseline pricing details no longer match the exported worksheet.',
  WORKBOOK_BLANK_MODE_CHANGED_VALUES:
    'Prices, costs or margin % changed on this row, but its pricing_mode cell is blank. Choose price_driven or margin_driven.',
  WORKBOOK_V2_EXPORT_REQUIRED:
    'This workbook is from an older template. Export a fresh Product pricing workbook and try again.',
  PRODUCT_INFO_FIELDS_REQUIRED:
    'This workbook is missing Product information columns. Export a fresh workbook and try again.',
  PRODUCT_RATE_PER_ACRE_INVALID:
    'Rate per acre must be blank or a non-negative number.',
  PRODUCT_RATE_UNIT_INVALID:
    'The selected rate unit is not compatible with this Product form.',
};

const STATUS_LABELS: Record<PricingPreviewRow['row_status'], string> = {
  ready: 'Ready',
  conflict: 'Conflict',
  invalid: 'Invalid',
  unchanged: 'Unchanged',
};

const STATUS_CLASSES: Record<PricingPreviewRow['row_status'], string> = {
  ready: 'bg-green-50 text-green-700 border-green-200',
  conflict: 'bg-amber-50 text-amber-800 border-amber-200',
  invalid: 'bg-red-50 text-red-700 border-red-200',
  unchanged: 'bg-gray-50 text-gray-600 border-gray-200',
};

function readableError(errorCode: string | null): string | null {
  if (!errorCode) return null;
  if (ERROR_MESSAGES[errorCode]) return ERROR_MESSAGES[errorCode];

  const words = errorCode.toLowerCase().split('_').join(' ');
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}.`;
}

function submittedValue(row: PricingPreviewRow, key: string): string | null {
  const value = row.submitted_row[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function productLabel(row: PricingPreviewRow): { name: string; detail: string | null } {
  const productName = row.effect?.product_name ?? submittedValue(row, 'product_name');
  const sku = row.effect?.sku ?? submittedValue(row, 'sku');
  const productId = row.product_id ?? submittedValue(row, 'product_id');

  return {
    name: productName ?? sku ?? productId ?? 'Unknown product',
    detail: productName && sku ? `SKU ${sku}` : productName && productId ? productId : null,
  };
}

const BASIS_TYPE_LABELS: Record<ProductCostBasisType, string> = {
  selected_supplier_price: 'Supplier price observation',
  actual_purchase: 'Received purchase order',
  manual_override: 'Manual replacement cost',
};

function BasisReviewDetails({ row }: { row: PricingPreviewRow }) {
  if (row.submitted_row.basis_selection !== true) return null;

  const basisType = submittedValue(row, 'basis_type');
  const reason = submittedValue(row, 'basis_reason');
  const supplierEvidenceId = submittedValue(row, 'supplier_price_observation_id');
  const purchaseEvidenceId = submittedValue(row, 'purchase_order_item_id');
  const evidence = supplierEvidenceId
    ? `Supplier observation ${supplierEvidenceId}`
    : purchaseEvidenceId
      ? `Purchase order item ${purchaseEvidenceId}`
      : 'Entered manually';

  return (
    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3" aria-label="Cost basis approval details">
      <div className="text-xs font-semibold uppercase tracking-wide text-blue-800">Cost basis approval</div>
      <dl className="mt-2 grid gap-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs text-blue-700">Basis type</dt>
          <dd className="font-medium text-nav-dark">
            {basisType ? (BASIS_TYPE_LABELS[basisType as ProductCostBasisType] ?? basisType) : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-blue-700">Audit reason</dt>
          <dd className="font-medium text-nav-dark">{reason ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-blue-700">Evidence</dt>
          <dd className="break-all font-mono text-xs text-nav-dark">{evidence}</dd>
        </div>
      </dl>
    </div>
  );
}

function ChangePair({ oldValue, newValue }: { oldValue: string; newValue: string }) {
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <span className="text-gray-500 line-through">{oldValue}</span>
      <span aria-hidden="true" className="text-gray-400">→</span>
      <span className="font-semibold text-nav-dark">{newValue}</span>
    </span>
  );
}

function displayDollars(value: string | null): string {
  return value === null ? '—' : `$${value}`;
}

function displayMargin(value: string | null): string {
  return value === null ? '—' : `${value}%`;
}

function displayPerAcre(value: bigint | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const wholeDollars = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cents = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}$${wholeDollars}.${cents} / acre`;
}

function PricingEffectDetails({ effect }: { effect: PricingEffect }) {
  const before = effect.before;
  const tiers = [
    {
      label: 'Tier 1',
      oldPrice: before?.tier1_price ?? null,
      price: effect.tier1_price,
      oldMarginPercent: before?.tier1_margin_percent ?? null,
      marginPercent: effect.tier1_margin_percent,
      margin: effect.tier1_margin,
      grossMargin: effect.tier1_gross_margin,
      oldPerAcreCents: before?.tier1_price_per_acre_cents,
      perAcreCents: effect.tier1_price_per_acre_cents,
    },
    {
      label: 'Tier 2',
      oldPrice: before?.tier2_price ?? null,
      price: effect.tier2_price,
      oldMarginPercent: before?.tier2_margin_percent ?? null,
      marginPercent: effect.tier2_margin_percent,
      margin: effect.tier2_margin,
      grossMargin: effect.tier2_gross_margin,
      oldPerAcreCents: before?.tier2_price_per_acre_cents,
      perAcreCents: effect.tier2_price_per_acre_cents,
    },
    {
      label: 'Tier 3',
      oldPrice: before?.tier3_price ?? null,
      price: effect.tier3_price,
      oldMarginPercent: before?.tier3_margin_percent ?? null,
      marginPercent: effect.tier3_margin_percent,
      margin: effect.tier3_margin,
      grossMargin: effect.tier3_gross_margin,
      oldPerAcreCents: before?.tier3_price_per_acre_cents,
      perAcreCents: effect.tier3_price_per_acre_cents,
    },
  ];

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-xs font-medium uppercase tracking-wide text-secondary">Cost</span>
        {before ? (
          <ChangePair oldValue={displayDollars(before.cost)} newValue={displayDollars(effect.cost)} />
        ) : (
          <span className="font-semibold text-nav-dark">{displayDollars(effect.cost)}</span>
        )}
      </div>
      <div className="grid gap-2 md:grid-cols-3">
        {tiers.map((tier) => {
          const belowCost = typeof tier.margin === 'number' && tier.margin < 0;
          const perAcre = displayPerAcre(tier.perAcreCents);
          const oldPerAcre = displayPerAcre(tier.oldPerAcreCents);
          const grossMargin = tier.grossMargin == null
            ? null
            : `${Number((tier.grossMargin * 100).toFixed(8))}%`;

          return (
            <div
              key={tier.label}
              className={`rounded-lg border bg-white p-3 ${
                belowCost ? 'border-amber-300 bg-amber-50' : 'border-gray-200'
              }`}
            >
              <div className="text-xs font-medium uppercase tracking-wide text-secondary">
                {tier.label}
              </div>
              <div className="mt-1 text-sm text-nav-dark">
                {before ? (
                  <ChangePair oldValue={displayDollars(tier.oldPrice)} newValue={displayDollars(tier.price)} />
                ) : displayDollars(tier.price)}
              </div>
              <div className={`text-xs ${belowCost ? 'font-semibold text-amber-800' : 'text-secondary'}`}>
                {before ? (
                  <><ChangePair oldValue={displayMargin(tier.oldMarginPercent)} newValue={displayMargin(tier.marginPercent)} /> <span>margin</span></>
                ) : <>{displayMargin(tier.marginPercent)} margin</>}
              </div>
              {grossMargin && (
                <div className="text-xs text-secondary">Markup %: {grossMargin}</div>
              )}
              {perAcre && (
                <div className="mt-1 text-xs text-secondary">
                  {before && oldPerAcre ? (
                    <ChangePair oldValue={oldPerAcre} newValue={perAcre} />
                  ) : perAcre}
                </div>
              )}
              {belowCost && (
                <div className="mt-2 text-xs font-semibold text-amber-800" role="note">
                  Warning: this price is below cost.
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PRODUCT_INFO_LABELS: Record<string, string> = {
  suggested_rate: 'Suggested rate',
  rate_per_acre: 'Rate per acre',
  rate_unit: 'Rate unit',
  use_timing: 'Use timing',
  internal_notes: 'Internal notes',
  quoting_notes: 'Quoting notes',
};

function displayInfoValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/** A new quote line shows the quoting note, or the product's description when the note is blank. */
function quoteLineText(note: unknown): string {
  return typeof note === 'string' && note.trim() ? note.trim() : "(the product's description)";
}

function ProductInfoEffectDetails({ effect }: { effect: PricingEffect }) {
  const changes = effect.product_info_changes;
  if (!changes || Object.keys(changes).length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3">
      <div className="text-xs font-semibold uppercase tracking-wide text-blue-800">Product information</div>
      <dl className="mt-2 space-y-2 text-sm">
        {Object.entries(changes).map(([field, change]) => (
          <div key={field} className="grid gap-1 sm:grid-cols-[10rem_1fr]">
            <dt className="text-xs font-medium text-blue-700">{PRODUCT_INFO_LABELS[field] ?? field}</dt>
            <dd className="text-nav-dark">
              <ChangePair
                oldValue={displayInfoValue(change.before)}
                newValue={displayInfoValue(change.after)}
              />
            </dd>
          </div>
        ))}
        {'quoting_notes' in changes && quoteLineText(changes.quoting_notes.before) !== quoteLineText(changes.quoting_notes.after) && (
          <div className="grid gap-1 sm:grid-cols-[10rem_1fr]">
            <dt className="text-xs font-medium text-amber-800">New quote lines show</dt>
            <dd className="text-nav-dark">
              <ChangePair
                oldValue={quoteLineText(changes.quoting_notes.before)}
                newValue={quoteLineText(changes.quoting_notes.after)}
              />
              <span className="block text-xs text-secondary">Existing quotes keep their notes.</span>
            </dd>
          </div>
        )}
      </dl>
    </div>
  );
}

const ROW_ORDER: Record<PricingPreviewRow['row_status'], number> = {
  invalid: 0,
  conflict: 1,
  ready: 2,
  unchanged: 3,
};

/** An unchanged row with nothing to approve; a basis-only selection is unchanged but still shown. */
function isFoldedRow(row: PricingPreviewRow): boolean {
  return row.row_status === 'unchanged' && row.submitted_row.basis_selection !== true;
}

function PreviewRow({ row }: { row: PricingPreviewRow }) {
  const product = productLabel(row);
  const errorMessage = readableError(row.error_code);
  const hasNegativeMargin = Boolean(
    row.effect && [
      row.effect.tier1_margin,
      row.effect.tier2_margin,
      row.effect.tier3_margin,
    ].some((margin) => typeof margin === 'number' && margin < 0),
  );

  return (
    <li className={`rounded-xl border p-4 ${hasNegativeMargin ? 'border-amber-300' : 'border-gray-200'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-nav-dark">{product.name}</div>
          {product.detail && <div className="mt-0.5 text-xs text-secondary">{product.detail}</div>}
        </div>
        <span
          className={`rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_CLASSES[row.row_status]}`}
        >
          {STATUS_LABELS[row.row_status]}
        </span>
      </div>
      {errorMessage && (
        <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">
          {errorMessage}
        </div>
      )}
      <BasisReviewDetails row={row} />
      {row.effect && <ProductInfoEffectDetails effect={row.effect} />}
      {row.effect && row.effect.pricing_changed !== false
        && <PricingEffectDetails effect={row.effect} />}
    </li>
  );
}

/** The whole preview is refused when any row is: say so, and say how to fix it. */
function NothingSavedNotice({ preview }: { preview: PricingPreviewResult }) {
  const problems = preview.invalid_count + preview.conflict_count;
  const sheet = preview.source === 'pricing_worksheet';
  if (problems === 0) return null;
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="status">
      Nothing was saved. {problems} row{problems === 1 ? ' needs' : 's need'} attention and {problems === 1 ? 'is' : 'are'} listed first below.
      {sheet && preview.invalid_count > 0 && ' Fix the Invalid rows in your Excel file, then upload it again.'}
      {sheet && preview.conflict_count > 0
        && ' A Conflict row changed in CRX after you downloaded the sheet: download a fresh price sheet and make that change there.'}
      {!sheet && ' Fix the problem shown below, then preview again.'}
    </p>
  );
}

export default function PricingChangePreviewModal({
  open,
  preview,
  applying,
  title = 'Review pricing changes',
  onClose,
  onApprove,
}: PricingChangePreviewModalProps) {
  // Reasons belong to one preview: a new preview starts with none.
  const [reasons, setReasons] = useState<{ changeSetId: string | null; byProduct: Record<string, string> }>(
    { changeSetId: null, byProduct: {} },
  );
  const changeSetId = preview?.change_set_id ?? null;
  const reasonsByProduct = reasons.changeSetId === changeSetId ? reasons.byProduct : {};
  const warnings = preview?.warnings ?? [];
  const acknowledgements = pricingAcknowledgements(warnings, reasonsByProduct);
  const canApprove = Boolean(
    preview?.apply_allowed
      && (preview.status === 'previewed' || preview.status === 'no_changes')
      && (preview.ready_count > 0 || (preview.basis_change_count ?? 0) > 0)
      && acknowledgements !== null,
  );
  const orderedRows = preview ? [...preview.rows].sort((a, b) => a.sequence - b.sequence) : [];
  // A full price sheet has ~1,200 rows: problems first, then ready rows; plain unchanged rows fold away.
  const shownRows = orderedRows
    .filter((row) => !isFoldedRow(row))
    .sort((a, b) => ROW_ORDER[a.row_status] - ROW_ORDER[b.row_status]);
  const foldedRows = orderedRows.filter(isFoldedRow);
  const [unchangedOpenFor, setUnchangedOpenFor] = useState<PricingPreviewResult | null>(null);
  const showUnchanged = preview !== null && unchangedOpenFor === preview;

  return (
    <Modal
      open={open}
      onClose={onClose}
      closeDisabled={applying}
      title={title}
      size="large"
      footer={
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <Button variant="secondary" onClick={onClose} disabled={applying}>
            Close
          </Button>
          {(preview?.status === 'previewed'
            || (preview?.status === 'no_changes' && (preview.basis_change_count ?? 0) > 0)) && (
            <Button onClick={() => acknowledgements && onApprove(acknowledgements)} disabled={!canApprove} loading={applying}>
              Apply approved changes
            </Button>
          )}
        </div>
      }
    >
      {!preview ? (
        <p className="text-sm text-secondary">No pricing preview is available.</p>
      ) : (
        <div className="space-y-5">
          <section aria-label="Preview summary">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-nav-dark">
                  {preview.status === 'previewed' && 'Ready for approval'}
                  {preview.status === 'invalid' && 'Some rows need attention'}
                  {preview.status === 'no_changes' && (preview.basis_change_count ?? 0) > 0
                    && 'Cost basis ready — sell prices stay unchanged'}
                  {preview.status === 'no_changes' && (preview.basis_change_count ?? 0) === 0
                    && 'No pricing changes found'}
                  {preview.status === 'applied' && 'Pricing changes applied'}
                  {preview.status === 'expired' && 'This preview expired'}
                </div>
                <div className="mt-1 text-xs text-secondary">
                  {preview.submitted_row_count} submitted row{preview.submitted_row_count === 1 ? '' : 's'}
                </div>
              </div>
              <span className="rounded-full border border-gray-200 bg-gray-50 px-3 py-1 text-xs font-medium text-secondary">
                {preview.source.split('_').join(' ')}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <div className="rounded-lg border border-green-200 bg-green-50 p-3">
                <div className="text-lg font-semibold text-green-700">{preview.ready_count}</div>
                <div className="text-xs text-green-700">Ready</div>
              </div>
              <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
                <div className="text-lg font-semibold text-gray-700">{preview.unchanged_count}</div>
                <div className="text-xs text-gray-600">Unchanged</div>
              </div>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <div className="text-lg font-semibold text-amber-800">{preview.conflict_count}</div>
                <div className="text-xs text-amber-800">Conflicts</div>
              </div>
              <div className="rounded-lg border border-red-200 bg-red-50 p-3">
                <div className="text-lg font-semibold text-red-700">{preview.invalid_count}</div>
                <div className="text-xs text-red-700">Invalid</div>
              </div>
            </div>
          </section>

          {preview.status === 'previewed' && (
            <PricingWarningAcknowledgements
              warnings={warnings}
              rows={orderedRows}
              reasons={reasonsByProduct}
              disabled={applying}
              onReasonChange={(productId, reason) => setReasons({
                changeSetId,
                byProduct: { ...reasonsByProduct, [productId]: reason },
              })}
            />
          )}

          {preview.status === 'invalid' && <NothingSavedNotice preview={preview} />}

          <ol className="space-y-3" aria-label="Pricing preview rows">
            {shownRows.map((row) => <PreviewRow key={`${row.sequence}-${row.product_id ?? 'unknown'}`} row={row} />)}
            {showUnchanged && foldedRows.map((row) => (
              <PreviewRow key={`${row.sequence}-${row.product_id ?? 'unknown'}`} row={row} />
            ))}
          </ol>
          {foldedRows.length > 0 && (
            <Button
              variant="secondary"
              aria-expanded={showUnchanged}
              onClick={() => setUnchangedOpenFor(showUnchanged ? null : preview)}
            >
              {showUnchanged ? 'Hide' : 'Show'} {foldedRows.length.toLocaleString()} unchanged row{foldedRows.length === 1 ? '' : 's'}
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}
