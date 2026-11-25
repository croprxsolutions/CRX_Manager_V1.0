import { render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import BelowCostApprovalModal from './BelowCostApprovalModal';
import type { BelowCostApprovalDetail } from '../../lib/belowCostApproval';

const base: BelowCostApprovalDetail = {
  operation: 'create_invoice_from_blend_ticket',
  entity_type: 'blend_ticket',
  entity_id: 'tk-1',
  line_id: 'l1',
  product_id: 'p1',
  product_name: 'Atrazine 4L',
  unit_price_cents: 0,
  locked_unit_cost_cents: 500,
  zero_line_product_names: [],
  zero_lines: [],
  lines: [],
  more_count: 0,
  total_shortfall_cents: null,
};

function renderWith(detail: BelowCostApprovalDetail) {
  render(<BelowCostApprovalModal open detail={detail} onCancel={vi.fn()} onConfirm={vi.fn()} />);
  return screen.getByRole('dialog', { name: 'Approve a below-cost price?' });
}

describe('BelowCostApprovalModal — every below-cost line in the save (pricing audit fix 1)', () => {
  const listed: BelowCostApprovalDetail = {
    ...base,
    operation: 'save_invoice',
    unit_price_cents: 300,
    lines: [
      { product_name: 'Atrazine 4L', unit_price_cents: 300, locked_unit_cost_cents: 500, quantity: 10, line_shortfall_cents: 2000, per: 'unit' },
      { product_name: 'Roundup', unit_price_cents: 1000, locked_unit_cost_cents: 1050, quantity: 2.5005, line_shortfall_cents: 125, per: 'unit' },
      { product_name: 'Application fee', unit_price_cents: 4000, locked_unit_cost_cents: 4500, quantity: 1, line_shortfall_cents: 500, per: 'line' },
    ],
    more_count: 0,
    total_shortfall_cents: 2625,
  };

  it('lists each line with price, cost, quantity and shortfall, then the total', () => {
    const dialog = renderWith(listed);
    expect(within(dialog).getByText(/3 lines in this save are priced below today's cost/)).toBeInTheDocument();
    const rows = within(dialog).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell').map((cell) => cell.textContent));
    expect(rows).toEqual([
      ['Atrazine 4L', '$3.00', '$5.00', '10', '$20.00'],
      ['Roundup', '$10.00', '$10.50', '2.5005', '$1.25'], // all 4 stored decimals
      ['Application fee (line total)', '$40.00', '$45.00', '—', '$5.00'],
    ]);
    expect(within(dialog).getByText('Total shortfall for this save: $26.25')).toBeInTheDocument();
    expect(within(dialog).queryByText(/reported this line first/)).not.toBeInTheDocument();
  });

  it('counts the lines it could not list', () => {
    const dialog = renderWith({ ...listed, lines: listed.lines.slice(0, 1), more_count: 4, total_shortfall_cents: 9000 });
    expect(within(dialog).getByText(/5 lines in this save are priced below/)).toBeInTheDocument();
    expect(within(dialog).getByText(/and 4 more below-cost lines not listed here/)).toBeInTheDocument();
    expect(within(dialog).getByText('Total shortfall for this save: $90.00')).toBeInTheDocument();
  });

  it('says "1 line" for a single line', () => {
    const dialog = renderWith({ ...listed, lines: listed.lines.slice(0, 1), total_shortfall_cents: 2000 });
    expect(within(dialog).getByText(/1 line in this save is priced below/)).toBeInTheDocument();
  });
});

describe('BelowCostApprovalModal — blend-ticket $0 lines (20261021070000)', () => {
  it('does not call a grower-share chemical free of charge', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L'],
      zero_lines: [{ line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'grower_share', cost_cents: 500, basis: 'b1' }],
    });
    expect(within(dialog).getByText(/included in a grower-share per-acre price/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/free of charge/)).not.toBeInTheDocument();
  });

  it('says why each line is $0 when quoted and grower-share lines are mixed', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L', 'Roundup'],
      zero_lines: [
        { line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'quoted_zero', cost_cents: 500, basis: 'b1' },
        { line_id: 'l2', product_id: 'p2', product_name: 'Roundup', kind: 'grower_share', cost_cents: 700, basis: 'b2' },
      ],
    });
    expect(within(dialog).getByText(/quoted at \$0, or included in a grower-share per-acre price/)).toBeInTheDocument();
    expect(within(dialog).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Atrazine 4L — cost $5.00 per unit',
      'Roundup — cost $7.00 per unit (included in a grower-share per-acre price)',
    ]);
  });

  it('keeps the free-of-charge wording for a $0 quoted line', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L'],
      zero_lines: [{ line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'quoted_zero', cost_cents: 500, basis: 'b1' }],
    });
    expect(within(dialog).getByText(/billed free of charge/)).toBeInTheDocument();
  });

  it('gives both reasons for a line quoted at $0 on one share and in a grower-share price on another', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L'],
      zero_lines: [{ line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'quoted_zero_and_grower_share', cost_cents: 500, basis: 'b1' }],
    });
    expect(within(dialog).getByText(/quoted at \$0 on one share and included in a grower-share per-acre price on another/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/^It is included in a grower-share per-acre price/)).not.toBeInTheDocument();
  });

  it('notes both reasons on a mixed line in the list', () => {
    const dialog = renderWith({
      ...base,
      zero_line_product_names: ['Atrazine 4L', 'Roundup'],
      zero_lines: [
        { line_id: 'l1', product_id: 'p1', product_name: 'Atrazine 4L', kind: 'quoted_zero_and_grower_share', cost_cents: 500, basis: 'b1' },
        { line_id: 'l2', product_id: 'p2', product_name: 'Roundup', kind: 'grower_share', cost_cents: 700, basis: 'b2' },
      ],
    });
    expect(within(dialog).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Atrazine 4L — cost $5.00 per unit (quoted at $0 on one share, included in a grower-share per-acre price on another)',
      'Roundup — cost $7.00 per unit (included in a grower-share per-acre price)',
    ]);
  });

  it('keeps the first-line wording when the database sent no list (an older database)', () => {
    const dialog = renderWith({ ...base, operation: 'save_invoice', unit_price_cents: 300 });
    expect(within(dialog).getByText(/The database reported this line first/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('table')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/could not be shown/)).not.toBeInTheDocument();
  });

  it('says how many lines it could not show when none of the list could be shown', () => {
    const dialog = renderWith({ ...base, operation: 'save_invoice', unit_price_cents: 300, more_count: 2 });
    expect(within(dialog).getByText('2 below-cost lines could not be shown here.')).toBeInTheDocument();
  });

  it('has a green go-ahead that needs a reason, and a Go back button', () => {
    const dialog = renderWith({ ...base, zero_line_product_names: ['Atrazine 4L'] });
    const approve = within(dialog).getByRole('button', { name: 'Approve and Retry' });
    expect(approve).toBeDisabled();
    expect(approve.className).toContain('bg-crx-green');
    expect(approve.className).not.toMatch(/bg-red-/);
    expect(within(dialog).getByRole('button', { name: 'Go back' })).toBeEnabled();
  });
});
