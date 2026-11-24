import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PricingPreviewResult } from '../../lib/productPricing';
import PricingChangePreviewModal from './PricingChangePreviewModal';

function makePreview(overrides: Partial<PricingPreviewResult> = {}): PricingPreviewResult {
  return {
    change_set_id: 'change-set-1',
    request_fingerprint: 'fingerprint-1',
    source: 'product_page',
    status: 'previewed',
    expires_at: '2026-07-16T22:00:00Z',
    submitted_row_count: 2,
    ready_count: 1,
    unchanged_count: 0,
    conflict_count: 1,
    invalid_count: 0,
    apply_allowed: true,
    rows: [
      {
        sequence: 2,
        product_id: 'product-2',
        submitted_row: { product_name: 'Later Product', sku: 'SKU-2' },
        row_status: 'conflict',
        error_code: 'PRICING_ROW_CONFLICT',
        effect: null,
      },
      {
        sequence: 1,
        product_id: 'product-1',
        submitted_row: { product_name: 'Untrusted Client Label', sku: 'CLIENT-SKU' },
        row_status: 'ready',
        error_code: null,
        effect: {
          product_id: 'product-1',
          product_name: 'First Product',
          sku: 'SKU-1',
          pricing_mode: 'price_driven',
          before: {
            cost: '10.00',
            cost_cents: 1000n,
            tier1_margin_percent: '20', tier1_margin: 0.2, tier1_price: '12.50', tier1_price_cents: 1250n,
            tier2_margin_percent: '25', tier2_margin: 0.25, tier2_price: '13.33', tier2_price_cents: 1333n,
            tier3_margin_percent: '30', tier3_margin: 0.3, tier3_price: '14.29', tier3_price_cents: 1429n,
            tier1_price_per_acre_cents: 625n,
            tier2_price_per_acre_cents: null,
            tier3_price_per_acre_cents: null,
          },
          cost: '12.00',
          cost_cents: 1200n,
          tier1_margin_percent: '-4.35',
           tier1_margin: -0.0435,
          tier1_gross_margin: -0.0417,
          tier1_price: '11.50',
          tier1_price_cents: 1150n,
          tier2_margin_percent: '20',
           tier2_margin: 0.2,
          tier2_gross_margin: 0.25,
          tier2_price: '15.00',
          tier2_price_cents: 1500n,
          tier3_margin_percent: '25',
           tier3_margin: 0.25,
          tier3_gross_margin: 0.33333333,
          tier3_price: '16.00',
          tier3_price_cents: 1600n,
          tier1_price_per_acre_cents: 575n,
          tier2_price_per_acre_cents: null,
          tier3_price_per_acre_cents: null,
        },
      },
    ],
    warnings: [],
    ...overrides,
  };
}

const belowCostWarning = {
  product_id: 'product-1',
  warning_codes: ['PRICE_BELOW_COST', 'MARGIN_UNDER_FLOOR'] as const,
  details: {
    cost_before_cents: 1000n,
    cost_after_cents: 1200n,
    margin_floor: 0.15,
    tiers: [],
    open_quote_count: 0,
    open_quote_numbers: [],
  },
};

describe('PricingChangePreviewModal warnings (To-Do 0.1)', () => {
  it('lists each warned product and keeps approval locked until it has a reason', () => {
    const onApprove = vi.fn();
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({ warnings: [{ ...belowCostWarning, warning_codes: [...belowCostWarning.warning_codes] }] })}
        applying={false}
        onClose={vi.fn()}
        onApprove={onApprove}
      />,
    );
    const panel = screen.getByRole('region', { name: 'Warnings to acknowledge' });
    expect(within(panel).getByText('First Product')).toBeTruthy();
    expect(within(panel).getByText('A price is below cost')).toBeTruthy();
    expect(within(panel).getByText(/floor 15%/)).toBeTruthy();
    const apply = screen.getByRole('button', { name: 'Apply approved changes' });
    expect(apply).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Reason for First Product'), { target: { value: 'Clearance of old stock' } });
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    expect(onApprove).toHaveBeenCalledWith([{
      product_id: 'product-1',
      warning_codes: ['PRICE_BELOW_COST', 'MARGIN_UNDER_FLOOR'],
      reason: 'Clearance of old stock',
    }]);
  });

  it('starts a new preview with no reasons, so an old reason never carries over', () => {
    const preview = makePreview({ warnings: [{ ...belowCostWarning, warning_codes: [...belowCostWarning.warning_codes] }] });
    const { rerender } = render(
      <PricingChangePreviewModal open preview={preview} applying={false} onClose={vi.fn()} onApprove={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText('Reason for First Product'), { target: { value: 'Clearance' } });
    rerender(
      <PricingChangePreviewModal
        open
        preview={{ ...preview, change_set_id: 'change-set-2' }}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Reason for First Product')).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Apply approved changes' })).toBeDisabled();
  });

  it('explains a missing source or reason on a row in plain English', () => {
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({
          status: 'invalid',
          rows: [{
            sequence: 1, product_id: 'product-3', submitted_row: { product_name: 'No Source' },
            row_status: 'invalid', error_code: 'PRICING_SOURCE_REQUIRED', effect: null,
          }],
        })}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.getByText(/the price_source column on a price sheet/)).toBeTruthy();
  });

  it('lists problem rows on a price sheet first, folds unchanged rows, and says nothing was saved', () => {
    const sheetPreview = makePreview({
          source: 'pricing_worksheet',
          status: 'invalid',
          apply_allowed: false,
          submitted_row_count: 3,
          ready_count: 1,
          unchanged_count: 1,
          conflict_count: 0,
          invalid_count: 1,
          rows: [
            {
              sequence: 1, product_id: 'product-u', submitted_row: { product_name: 'Untouched Product' },
              row_status: 'unchanged', error_code: null, effect: null,
            },
            { ...makePreview().rows[1], sequence: 2 },
            {
              sequence: 3, product_id: 'product-x', submitted_row: { product_name: 'Bad Cell Product' },
              row_status: 'invalid', error_code: 'PRICING_DOLLARS_INVALID', effect: null,
            },
          ],
        });
    const modal = (open: boolean) => (
      <PricingChangePreviewModal
        open={open}
        preview={sheetPreview}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />
    );
    const { rerender } = render(modal(true));

    expect(screen.getByText(/^Nothing was saved\. 1 row needs attention and is listed first below\./))
      .toHaveTextContent('Fix the Invalid rows in your Excel file, then upload it again.');
    const list = screen.getByRole('list', { name: 'Pricing preview rows' });
    let rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('Bad Cell Product')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/not a plain dollar amount.*at most 2 decimals, like 12\.34/)).toBeInTheDocument();
    // Sorting moves problem rows up, so each names its sheet row (sequence 3 -> row 4; the header is row 1).
    expect(within(rows[0]).getByText('Excel row 4')).toBeInTheDocument();
    expect(within(rows[1]).getByText('First Product')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Excel row 3')).toBeInTheDocument();
    expect(screen.queryByText('Untouched Product')).not.toBeInTheDocument();

    const showButton = screen.getByRole('button', { name: 'Show 1 unchanged row' });
    fireEvent.click(showButton);
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    rows = within(screen.getByRole('list', { name: 'Unchanged pricing preview rows' })).getAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText('Untouched Product')).toBeInTheDocument();
    expect(within(rows[0]).getByText('Excel row 2')).toBeInTheDocument();
    // Reading order: the revealed rows come after the button, so moving forward from it reaches them.
    expect(showButton.compareDocumentPosition(rows[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Hide 1 unchanged row' })).toHaveAttribute('aria-expanded', 'true');

    // Closing and reopening the same preview folds the unchanged rows again.
    rerender(modal(false));
    rerender(modal(true));
    expect(screen.getByRole('button', { name: 'Show 1 unchanged row' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Untouched Product')).not.toBeInTheDocument();
  });
});

describe('PricingChangePreviewModal', () => {
  it('renders Product information old-to-new values without a pricing card for info-only rows', () => {
    const preview = makePreview({ submitted_row_count: 1, conflict_count: 0 });
    preview.rows = [{
      ...preview.rows[1],
      effect: {
        ...preview.rows[1].effect!,
        pricing_changed: false,
        product_info_changes: {
          quoting_notes: { before: null, after: 'Prefer early-season placement' },
          rate_per_acre: { before: 12, after: 16 },
        },
      },
    }];

    render(
      <PricingChangePreviewModal
        open preview={preview} applying={false}
        onClose={vi.fn()} onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText('Product information')).toBeInTheDocument();
    expect(screen.getByText('Quoting notes')).toBeInTheDocument();
    // Once as the quoting note, once as what new quote lines show (blank before: the description).
    expect(screen.getAllByText('Prefer early-season placement')).toHaveLength(2);
    expect(screen.getByText('New quote lines show')).toBeInTheDocument();
    expect(screen.getByText("(the product's description)")).toBeInTheDocument();
    expect(screen.getByText('Existing quotes keep their notes.')).toBeInTheDocument();
    expect(screen.queryByText('Cost')).not.toBeInTheDocument();
  });

  it('tells a mode-companion refusal to restore the edited cells before switching mode', () => {
    const invalidRow = (sequence: number, errorCode: string) => ({
      sequence, product_id: `product-${sequence}`, submitted_row: { product_name: `Product ${sequence}` },
      row_status: 'invalid' as const, error_code: errorCode, effect: null,
    });
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({
          source: 'pricing_worksheet', status: 'invalid', apply_allowed: false,
          ready_count: 0, conflict_count: 0, invalid_count: 2,
          rows: [
            invalidRow(1, 'PRICE_DRIVEN_COMPANION_FIELDS_CHANGED'),
            invalidRow(2, 'MARGIN_DRIVEN_COMPANION_FIELDS_CHANGED'),
          ],
        })}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );
    // The server allows each companion cell only blank or as downloaded, so switching mode alone
    // would refuse the edited cells again.
    expect(screen.getByText(
      'This row is price-driven, so its margin % cells must stay as downloaded. To change margins instead, first put all three tier price cells back as downloaded, then set pricing_mode to margin_driven.',
    )).toBeInTheDocument();
    expect(screen.getByText(
      'This row is margin-driven, so its tier price cells must stay as downloaded. To change prices instead, first put all three margin % cells back as downloaded, then set pricing_mode to price_driven.',
    )).toBeInTheDocument();
  });

  it('renders summary, ordered rows, effects, warnings, and plain-English errors', () => {
    // As the server returns it: any conflict makes the whole preview invalid and not applyable.
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({ source: 'pricing_worksheet', status: 'invalid', apply_allowed: false })}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText('Some rows need attention')).toBeInTheDocument();
    expect(screen.getByText('2 submitted rows')).toBeInTheDocument();
    // A sheet with only conflicts still says nothing was saved, and how to fix a conflict.
    const notice = screen.getByText(/^Nothing was saved\. 1 row needs attention and is listed first below\./);
    expect(notice).toHaveTextContent('A Conflict row changed in CRX after you downloaded the sheet');
    expect(notice).not.toHaveTextContent('Fix the Invalid rows');
    expect(screen.queryByRole('button', { name: 'Apply approved changes' })).not.toBeInTheDocument();

    // Problem rows come first, so the conflict sorts ahead of the ready row.
    const rows = within(screen.getByRole('list', { name: 'Pricing preview rows' })).getAllByRole('listitem');
    expect(within(rows[1]).getByText('First Product')).toBeInTheDocument();
    expect(within(rows[1]).getByText('SKU SKU-1')).toBeInTheDocument();
    expect(within(rows[1]).getByText('$10.00')).toBeInTheDocument();
    expect(within(rows[1]).getByText('$12.00')).toBeInTheDocument();
    expect(within(rows[1]).getByText('$12.50')).toBeInTheDocument();
    expect(within(rows[1]).getByText('$5.75 / acre')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Markup %: 25%')).toBeInTheDocument();
    expect(within(rows[1]).getByText('Warning: this price is below cost.')).toBeInTheDocument();

    expect(within(rows[0]).getByText('Later Product')).toBeInTheDocument();
    expect(
      within(rows[0]).getByText(/changed after the pricing data was loaded/i),
    ).toBeInTheDocument();
  });

  it('formats per-acre cents exactly beyond JavaScript safe-integer precision', () => {
    const preview = makePreview();
    preview.rows[1].effect!.tier2_price_per_acre_cents = 9_007_199_254_740_993n;

    render(
      <PricingChangePreviewModal
        open
        preview={preview}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText('$90,071,992,547,409.93 / acre')).toBeInTheDocument();
  });

  it('disables approval unless the preview is applyable with ready rows', () => {
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({ apply_allowed: false })}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: 'Apply approved changes' })).toBeDisabled();
  });

  it('calls onApprove for an approved preview and shows the loading state', () => {
    const onApprove = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <PricingChangePreviewModal
        open
        preview={makePreview()}
        applying={false}
        onClose={onClose}
        onApprove={onApprove}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));
    expect(onApprove).toHaveBeenCalledTimes(1);

    rerender(
      <PricingChangePreviewModal
        open
        preview={makePreview()}
        applying
        onClose={onClose}
        onApprove={onApprove}
      />,
    );
    expect(screen.getByRole('button', { name: 'Apply approved changes' })).toBeDisabled();
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    closeButtons.forEach((button) => expect(button).toBeDisabled());
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.querySelector('[data-modal-panel]')).toHaveFocus();
  });

  it('allows a basis-only selection when the dollar cost is unchanged', () => {
    const onApprove = vi.fn();
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({
          status: 'no_changes',
          ready_count: 0,
          unchanged_count: 1,
          conflict_count: 0,
          apply_allowed: true,
          basis_change_count: 1,
          rows: [{
            sequence: 1,
            product_id: 'product-1',
            submitted_row: {
              product_name: 'First Product',
              basis_selection: true,
              basis_type: 'selected_supplier_price',
              basis_reason: 'Current confirmed supplier quote',
              supplier_price_observation_id: 'observation-1',
            },
            row_status: 'unchanged',
            error_code: null,
            effect: null,
          }],
        })}
        applying={false}
        onClose={vi.fn()}
        onApprove={onApprove}
      />,
    );

    expect(screen.getByText('Cost basis ready — sell prices stay unchanged')).toBeInTheDocument();
    const basisDetails = screen.getByLabelText('Cost basis approval details');
    expect(within(basisDetails).getByText('Supplier price observation')).toBeInTheDocument();
    expect(within(basisDetails).getByText('Current confirmed supplier quote')).toBeInTheDocument();
    expect(within(basisDetails).getByText('Supplier observation observation-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply approved changes' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      basisType: 'actual_purchase',
      reason: 'Most recent received inventory cost',
      evidenceKey: 'purchase_order_item_id',
      evidenceId: 'po-item-1',
      expectedType: 'Received purchase order',
      expectedEvidence: 'Purchase order item po-item-1',
    },
    {
      basisType: 'manual_override',
      reason: 'Owner-entered replacement cost',
      evidenceKey: null,
      evidenceId: null,
      expectedType: 'Manual replacement cost',
      expectedEvidence: 'Entered manually',
    },
  ])('shows $expectedType approval metadata', ({
    basisType,
    reason,
    evidenceKey,
    evidenceId,
    expectedType,
    expectedEvidence,
  }) => {
    const submittedRow: Record<string, unknown> = {
      product_name: 'First Product',
      basis_selection: true,
      basis_type: basisType,
      basis_reason: reason,
    };
    if (evidenceKey) submittedRow[evidenceKey] = evidenceId;

    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({
          submitted_row_count: 1,
          ready_count: 1,
          conflict_count: 0,
          basis_change_count: 1,
          rows: [{
            sequence: 1,
            product_id: 'product-1',
            submitted_row: submittedRow,
            row_status: 'ready',
            error_code: null,
            effect: null,
          }],
        })}
        applying={false}
        onClose={vi.fn()}
        onApprove={vi.fn()}
      />,
    );

    const basisDetails = screen.getByLabelText('Cost basis approval details');
    expect(within(basisDetails).getByText(expectedType)).toBeInTheDocument();
    expect(within(basisDetails).getByText(reason)).toBeInTheDocument();
    expect(within(basisDetails).getByText(expectedEvidence)).toBeInTheDocument();
  });

  it.each([
    ['invalid', 'Some rows need attention'],
    ['no_changes', 'No pricing changes found'],
  ] as const)('shows no approval path for %s previews', (status, statusLabel) => {
    const onClose = vi.fn();
    render(
      <PricingChangePreviewModal
        open
        preview={makePreview({ status, apply_allowed: false, ready_count: 0 })}
        applying={false}
        onClose={onClose}
        onApprove={vi.fn()}
      />,
    );

    expect(screen.getByText(statusLabel)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apply approved changes' })).not.toBeInTheDocument();
    const closeButtons = screen.getAllByRole('button', { name: 'Close' });
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
