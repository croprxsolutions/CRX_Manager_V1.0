import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  fetchProductWeights: vi.fn(),
  fetchWeightEvents: vi.fn(),
  saveWeight: vi.fn(),
  approveWeightDraft: vi.fn(),
}));

vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock('../../lib/productWeights', async () => {
  const actual = await vi.importActual<typeof import('../../lib/productWeights')>('../../lib/productWeights');
  return { ...actual, fetchProductWeights: mocks.fetchProductWeights, fetchWeightEvents: mocks.fetchWeightEvents,
    saveWeight: mocks.saveWeight, approveWeightDraft: mocks.approveWeightDraft };
});

import ProductWeightCard from './ProductWeightCard';

const units = { factors: {}, ambiguous: [] };
const result = (entry: Record<string, unknown>) => ({ read_at: 't', units, products: { p1: { product_id: 'p1', found: true, product_name: 'TEST Atrazine 2.5 Gal', ...entry } } });
const densitySubject = { kind: 'density', subject_id: 'par1', version: 2, parent_name: 'TEST Atrazine 4L' };
const formulation = { product_form: 'liquid', formulation_type: 'SC', safener: null, generic_epa_registration: null };

function show(entry: Record<string, unknown>, isAdmin = true) {
  mocks.fetchProductWeights.mockResolvedValue(result(entry));
  return render(<ProductWeightCard productId="p1" isAdmin={isAdmin} profileId="u1" busy={false} reloadKey="k" />);
}

describe('ProductWeightCard', () => {
  beforeEach(() => {
    Object.values(mocks).forEach((mock) => mock.mockReset());
    mocks.fetchWeightEvents.mockResolvedValue([]);
  });

  it('shows the approved weight per gallon with its source, approver and date', async () => {
    show({ product_form: 'liquid', subject: densitySubject, current_basis: formulation,
      weight: { kind: 'density', lb_per_unit: 9.5972, per_unit: 'Gal', source: 'sds', reviewed_by_name: 'Pat Admin', reviewed_at: '2026-11-07T15:00:00Z' } });
    expect(await screen.findByTestId('product-weight-summary')).toHaveTextContent(
      'Weight per gallon: 9.5972 lb/gal, from the SDS, approved by Pat Admin on 11/7/2026');
  });

  it('tells a liquid without a parent how to get a weight, with no editor', async () => {
    show({ product_form: 'liquid', subject: null, weight: { kind: 'none', none_reason: 'no_parent' } });
    expect(await screen.findByText('Put TEST Atrazine 2.5 Gal in a parent to record its weight')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /weight/i })).not.toBeInTheDocument();
  });

  it('says a dry size stocked in a weight unit gets its weight from the unit', async () => {
    show({ product_form: 'dry', inventory_unit: 'Lb', subject: null, weight: { kind: 'unit_weight', lb_per_unit: 1, per_unit: 'Lb', source: 'unit' } });
    expect(await screen.findByText('Weight comes from its stock unit (Lb)')).toBeInTheDocument();
  });

  it('shows nothing for seed and each products', async () => {
    const { container } = show({ product_form: 'seed', subject: null, weight: { kind: 'none', none_reason: 'seed_or_each' } });
    await waitFor(() => expect(mocks.fetchProductWeights).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('offers Approve draft only when the draft was entered for the current pack', async () => {
    const pack = { container_size: 5, container_type: 'bag', container_unit: 'Lb', inventory_unit: 'Ea', unit_size: null };
    const subject = { kind: 'net_weight', subject_id: 'p1', version: 4 };
    const draft = { id: 'd1', value: 5, entered_value: 5, entered_unit: 'lb', source: 'label', source_note: null, reason: null, evidence: null,
      created_by: null, created_by_name: null, created_at: 't', basis: pack };
    show({ product_form: 'dry', inventory_unit: 'Ea', subject, current_basis: pack, draft, weight: { kind: 'none', none_reason: 'no_approved_weight' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Approve draft' }));
    mocks.approveWeightDraft.mockResolvedValue({});
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mocks.approveWeightDraft).toHaveBeenCalledWith(subject, 'd1', expect.any(String)));
  });

  // Regression (PR #1646): the page re-reads cost per lb of active only if a save tells it.
  it('tells the page after a weight is saved', async () => {
    const pack = { container_size: 5, container_type: 'bag', container_unit: 'Lb', inventory_unit: 'Ea', unit_size: null };
    const draft = { id: 'd1', value: 5, entered_value: 5, entered_unit: 'lb', source: 'label', source_note: null, reason: null, evidence: null,
      created_by: null, created_by_name: null, created_at: 't', basis: pack };
    mocks.fetchProductWeights.mockResolvedValue(result({ product_form: 'dry', inventory_unit: 'Ea', subject: { kind: 'net_weight', subject_id: 'p1', version: 4 },
      current_basis: pack, draft, weight: { kind: 'none', none_reason: 'no_approved_weight' } }));
    const onSaved = vi.fn();
    render(<ProductWeightCard productId="p1" isAdmin profileId="u1" busy={false} reloadKey="k" onSaved={onSaved} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve draft' }));
    mocks.approveWeightDraft.mockResolvedValue({});
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('after a pack change, offers Set weight instead of Approve', async () => {
    const oldPack = { container_size: 5, container_type: 'bag', container_unit: 'Lb', inventory_unit: 'Ea', unit_size: null };
    const draft = { id: 'd1', value: 5, entered_value: 5, entered_unit: 'lb', source: 'label', source_note: null, reason: null, evidence: null,
      created_by: null, created_by_name: null, created_at: 't', basis: oldPack };
    show({ product_form: 'dry', inventory_unit: 'Ea', subject: { kind: 'net_weight', subject_id: 'p1', version: 5 },
      current_basis: { ...oldPack, container_size: 10 }, draft, weight: { kind: 'none', none_reason: 'no_approved_weight' } });
    expect(await screen.findByText('Pack changed: enter the weight again for the new pack.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve draft' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set weight' })).toBeInTheDocument();
  });

  it('enters a weight by specific gravity, showing the stored lb/gal before saving', async () => {
    show({ product_form: 'liquid', subject: densitySubject, current_basis: formulation, weight: { kind: 'none', none_reason: 'no_approved_weight' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Enter weight' }));
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '1.15' } });
    fireEvent.change(screen.getByLabelText('Entered as'), { target: { value: 'specific_gravity' } });
    expect(screen.getByText('Saves as 9.5972 lb/gal')).toBeInTheDocument();
    mocks.saveWeight.mockResolvedValue({});
    fireEvent.click(screen.getByRole('button', { name: 'Save weight' }));
    await waitFor(() => expect(mocks.saveWeight).toHaveBeenCalledWith(expect.objectContaining({
      subject: densitySubject, value: '1.15', unit: 'specific_gravity', source: 'sds', correction: undefined })));
    await waitFor(() => expect(mocks.fetchProductWeights).toHaveBeenCalledTimes(2));
  });

  it('holds Save back for a weight the database would refuse as out of range', async () => {
    show({ product_form: 'liquid', subject: densitySubject, current_basis: formulation, weight: { kind: 'none', none_reason: 'no_approved_weight' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Enter weight' }));
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '21' } });
    expect(screen.getByRole('status')).toHaveTextContent('more than 20 lb/gal; check the number');
    expect(screen.getByRole('button', { name: 'Save weight' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '20' } });
    expect(screen.getByRole('button', { name: 'Save weight' })).toBeEnabled();
  });

  it('loads 25 more history rows on Show older', async () => {
    const event = (id: number) => ({ id, event_type: 'approved', value_id: null, before_value: null, after_value: null, reason: null, evidence: null,
      actor_kind: 'user', changed_by_name: 'Pat Admin', changed_at: '2026-11-07T15:00:00Z' });
    mocks.fetchWeightEvents.mockResolvedValue(Array.from({ length: 25 }, (_, index) => event(index)));
    show({ product_form: 'liquid', subject: densitySubject, current_basis: formulation, weight: { kind: 'none', none_reason: 'no_approved_weight' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Show older' }));
    await waitFor(() => expect(mocks.fetchWeightEvents).toHaveBeenLastCalledWith(densitySubject, 50));
  });

  it('keeps the shown history when Show older fails, and offers to try again', async () => {
    const event = (id: number) => ({ id, event_type: 'approved', value_id: null, before_value: null, after_value: null, reason: null, evidence: null,
      actor_kind: 'user', changed_by_name: 'Pat Admin', changed_at: '2026-11-07T15:00:00Z' });
    mocks.fetchWeightEvents.mockResolvedValueOnce(Array.from({ length: 25 }, (_, index) => event(index))).mockRejectedValueOnce(new Error('offline'));
    show({ product_form: 'liquid', subject: densitySubject, current_basis: formulation, weight: { kind: 'none', none_reason: 'no_approved_weight' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Show older' }));
    expect(await screen.findByText('Older history could not be loaded.')).toBeInTheDocument();
    expect(screen.getAllByText('Pat Admin')).toHaveLength(25);
    mocks.fetchWeightEvents.mockResolvedValueOnce(Array.from({ length: 30 }, (_, index) => event(index)));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByText('Pat Admin')).toHaveLength(30));
  });

  it('turns a lower-trust entry into a correction that needs a reason and evidence', async () => {
    show({ product_form: 'liquid', subject: densitySubject, current_basis: formulation,
      weight: { kind: 'density', lb_per_unit: 9.5972, per_unit: 'Gal', source: 'sds', reviewed_by_name: 'Pat', reviewed_at: 't' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Enter new weight' }));
    fireEvent.change(screen.getByLabelText('Weight'), { target: { value: '9.6' } });
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'supplier' } });
    const save = screen.getByRole('button', { name: 'Save correction' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'supplier sheet newer' } });
    fireEvent.change(screen.getByLabelText('Evidence (what shows it) (required)'), { target: { value: 'sheet dated 2026-11' } });
    mocks.saveWeight.mockResolvedValue({});
    fireEvent.click(save);
    await waitFor(() => expect(mocks.saveWeight).toHaveBeenCalledWith(expect.objectContaining({
      source: 'supplier', correction: { reason: 'supplier sheet newer', evidence: 'sheet dated 2026-11' } })));
  });

  it('never shows the previous product\'s weight or buttons while the next product loads', async () => {
    const { rerender } = show({ product_form: 'liquid', subject: densitySubject, current_basis: formulation,
      weight: { kind: 'density', lb_per_unit: 9.5972, per_unit: 'Gal', source: 'sds', reviewed_by_name: 'Pat', reviewed_at: 't' } });
    expect(await screen.findByRole('button', { name: 'Enter new weight' })).toBeInTheDocument();
    mocks.fetchProductWeights.mockReturnValue(new Promise(() => {}));
    rerender(<ProductWeightCard productId="p2" isAdmin profileId="u1" busy={false} reloadKey="k" />);
    expect(screen.queryByRole('button', { name: 'Enter new weight' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('product-weight-summary')).not.toBeInTheDocument();
    expect(screen.getByText('Loading weight…')).toBeInTheDocument();
  });

  it('hides the editors from a non-admin', async () => {
    show({ product_form: 'liquid', subject: densitySubject, current_basis: formulation, weight: { kind: 'none', none_reason: 'no_approved_weight' } }, false);
    expect(await screen.findByText('TEST Atrazine 2.5 Gal has no approved weight yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enter weight/i })).not.toBeInTheDocument();
  });
});
