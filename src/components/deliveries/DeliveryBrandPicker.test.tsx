import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import DeliveryBrandPicker from './DeliveryBrandPicker';
import { OTHER_BRAND, type DeliveryBrands, type DraftLines } from '../../lib/deliveryBrands';

const brands: DeliveryBrands = {
  delivery_id: 'D1', status: 'in_progress', event_seq: 1,
  lines: [
    {
      delivery_item_id: 'L1', product_id: 'P1', product_name: 'Glyphosate 2.5', quantity: 10, quantity_delivered: null, unit_size: 'gal',
      brand_list: [
        { source: 'size', parent_id: null, brand_id: 'b1', brand_name: 'Roundup', epa_registration: '524-475', manufacturer: null, is_currently_sourced: true },
        { source: 'size', parent_id: null, brand_id: 'b2', brand_name: 'Old Brand', epa_registration: null, manufacturer: null, is_currently_sourced: false },
      ],
      picks: [],
    },
    { delivery_item_id: 'L2', product_id: 'P2', product_name: 'Unbranded seed', quantity: 5, quantity_delivered: null, unit_size: 'bag', brand_list: [], picks: [] },
  ],
};

let latest: DraftLines = {};
function Harness() {
  const [drafts, setDrafts] = useState<DraftLines>({});
  return <DeliveryBrandPicker brands={brands} drafts={drafts} disabled={false} fullQuantity={(l) => l.quantity}
    onChange={(id, d) => { latest = { ...latest, [id]: d }; setDrafts((prev) => ({ ...prev, [id]: d })); }} />;
}

describe('DeliveryBrandPicker', () => {
  it('shows only branded lines, lists current then old stock, takes a typed brand, and splits with the full amount first', () => {
    latest = {};
    render(<Harness />);
    expect(screen.queryByText('Unbranded seed')).toBeNull();
    expect(screen.getByText('No brand picked yet.')).toBeTruthy();
    const select = screen.getByLabelText('Brand for Glyphosate 2.5') as HTMLSelectElement;
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Currently bought', 'Not currently bought (old stock)']);

    fireEvent.change(select, { target: { value: 'b1' } });
    expect(latest.L1).toEqual([expect.objectContaining({ brandId: 'b1', quantity: '' })]);

    fireEvent.click(screen.getByText(/Split: add another brand/));
    expect(latest.L1.map((p) => p.quantity)).toEqual(['10', '']);
    fireEvent.change(screen.getByLabelText('Brand for Glyphosate 2.5 (2)'), { target: { value: OTHER_BRAND } });
    fireEvent.change(screen.getByLabelText('Brand name on the jug for Glyphosate 2.5'), { target: { value: 'Credit' } });
    expect(latest.L1[1]).toEqual(expect.objectContaining({ brandId: OTHER_BRAND, typedName: 'Credit' }));

    fireEvent.click(screen.getByLabelText('Remove Brand for Glyphosate 2.5 (2)'));
    expect(latest.L1).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('Brand for Glyphosate 2.5'), { target: { value: '' } });
    expect(latest.L1).toEqual([]);
  });
});
