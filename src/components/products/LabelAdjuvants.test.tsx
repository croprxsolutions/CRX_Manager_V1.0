import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { RegistrationRow } from '../../lib/epaRegistrationStatus';

const H = vi.hoisted(() => ({ rpc: vi.fn(), getRegistrations: vi.fn(), toast: vi.fn() }));
vi.mock('../../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/db')>()),
  supabaseUntyped: { rpc: H.rpc },
}));
vi.mock('../../lib/epaRegistrationStatus', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/epaRegistrationStatus')>()),
  getRegistrations: H.getRegistrations,
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
import LabelAdjuvants from './LabelAdjuvants';
import EpaLabelLink from './EpaLabelLink';

const row = (over: Partial<RegistrationRow> = {}): RegistrationRow => ({
  epa_registration: '264-849', registration_status: 'active', cancelled_on: null, label_url: null,
  label_adjuvants: null, registration_version: 3, ...over,
});
const show = (r: RegistrationRow | undefined, props: Partial<Parameters<typeof LabelAdjuvants>[0]> = {}) => render(
  <LabelAdjuvants epaRegistration="264-849" row={r} lookup="done" canEdit={false} profileId="u1" onSaved={vi.fn()} {...props} />,
);
const receipt = { data: { epa_registration: '264-849', registration_version: 4, event_id: 9, event_type: 'updated' }, error: null };

beforeEach(() => vi.clearAllMocks());

describe('LabelAdjuvants display', () => {
  it('not reviewed, none, and no row', () => {
    const { unmount } = show(row());
    expect(screen.getByText('Label adjuvants: not reviewed')).toBeTruthy();
    unmount();
    const second = show(row({ label_adjuvants: [] }));
    expect(screen.getByText('Label adjuvants: none on the label')).toBeTruthy();
    second.unmount();
    const { container } = show(undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it('a choice with preferred, a condition shown first, and do not use in red', () => {
    show(row({ label_adjuvants: [
      { kind: 'required', adjuvant_types: ['HS-MSO', 'MSO', 'COC'], preferred: 'HS-MSO', note: '1% v/v' },
      { kind: 'required', adjuvant_types: ['COC'], when: 'tank mixed with atrazine' },
      { kind: 'do_not_use', adjuvant_types: ['UAN', 'COC'], when: 'corn after V8' },
    ] }));
    const items = screen.getAllByRole('listitem');
    expect(items[0].textContent).toBe('Requires one of: HS-MSO (preferred), MSO, COC1% v/v');
    expect(within(items[0]).getByText('HS-MSO').tagName).toBe('STRONG');
    expect(items[1].textContent).toBe('When tank mixed with atrazine: requires: COC');
    expect(items[2].textContent).toBe('When corn after V8: do not use: UAN or COC');
    expect(items[2]).toHaveClass('text-red-700');
  });

  it('a failed read says so, never "not reviewed"; checking shows nothing', () => {
    const { rerender, container } = show(row(), { lookup: 'failed' });
    expect(screen.getByText("Couldn't check the label; reload")).toBeTruthy();
    expect(screen.queryByText(/not reviewed/)).toBeNull();
    rerender(<LabelAdjuvants epaRegistration="264-849" row={row()} lookup="checking" canEdit onSaved={vi.fn()} profileId="u1" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('the edit button only for editors', () => {
    const { unmount } = show(row());
    expect(screen.queryByRole('button', { name: 'Edit adjuvants' })).toBeNull();
    unmount();
    show(row(), { canEdit: true });
    expect(screen.getByRole('button', { name: 'Edit adjuvants' })).toBeTruthy();
  });
});

describe('EpaLabelLink labelUrl', () => {
  it('View label when a link is stored, else the search', () => {
    const { rerender } = render(<EpaLabelLink epaRegistration="264-849" labelUrl="https://example.test/l.pdf" />);
    expect(screen.getByRole('link', { name: 'View the EPA label for 264-849' })).toHaveAttribute('href', 'https://example.test/l.pdf');
    rerender(<EpaLabelLink epaRegistration="264-849" labelUrl={null} />);
    expect(screen.getByRole('link', { name: 'Search EPA labels for 264-849' })).toBeTruthy();
  });
});

async function openEditor(r: RegistrationRow | undefined, onSaved = vi.fn()) {
  show(r, { canEdit: true, onSaved });
  fireEvent.click(screen.getByRole('button', { name: 'Edit adjuvants' }));
  return screen.findByRole('dialog');
}
const saveButton = () => screen.getByRole('button', { name: 'Save' });

describe('LabelAdjuvantsModal', () => {
  it('saves the statement with the loaded version, a reason and a key, then re-reads', async () => {
    const onSaved = vi.fn();
    H.rpc.mockResolvedValue(receipt);
    await openEditor(row(), onSaved);
    expect(screen.getByText('This applies to every product and brand with EPA number 264-849.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a statement' }));
    const types = screen.getByRole('group', { name: 'Statement 1 types' });
    fireEvent.click(within(types).getByLabelText('MSO'));
    fireEvent.click(within(types).getByLabelText('HS-MSO'));
    fireEvent.change(screen.getByLabelText('Statement 1 preferred'), { target: { value: 'HS-MSO' } });
    fireEvent.change(screen.getByLabelText('Statement 1 note'), { target: { value: ' 1% v/v ' } });
    fireEvent.click(saveButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('Say why');
    expect(H.rpc).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'from the label' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(H.rpc).toHaveBeenCalledWith('set_registration_adjuvants', expect.objectContaining({
      p_epa_registration: '264-849', p_expected_version: 3, p_reason: 'from the label',
      // List order, not click order.
      p_adjuvants: [{ kind: 'required', adjuvant_types: ['MSO', 'HS-MSO'], preferred: 'HS-MSO', note: '1% v/v' }],
    }));
    expect(H.rpc.mock.calls[0][1].p_idempotency_key).toEqual(expect.any(String));
  });

  it('no row yet: saves "none on the label" with version null (creates it)', async () => {
    H.rpc.mockResolvedValue(receipt);
    await openEditor(undefined);
    // A blank statement left behind does not block "none".
    fireEvent.click(screen.getByRole('button', { name: 'Add a statement' }));
    fireEvent.click(screen.getByLabelText('None on the label'));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'label has none' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('set_registration_adjuvants', expect.objectContaining({
      p_expected_version: null, p_adjuvants: [],
    })));
  });

  it('a dropped connection keeps the form; the retry sends the same key', async () => {
    let fail!: (e: Error) => void;
    H.rpc.mockReturnValueOnce(new Promise((_, reject) => { fail = reject; })).mockResolvedValueOnce(receipt);
    await openEditor(row({ label_adjuvants: [] }));
    fireEvent.click(screen.getByLabelText('None on the label'));
    fireEvent.click(screen.getByRole('button', { name: 'Add a statement' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Statement 1 types' })).getByLabelText('AMS'));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'r' } });
    fireEvent.click(saveButton());
    // Every input is locked while saving.
    await waitFor(() => expect(screen.getByLabelText('Why')).toBeDisabled());
    fail(new Error('Failed to fetch'));
    expect(await screen.findByRole('alert')).toHaveTextContent('Press Save again; it cannot save twice.');
    fireEvent.click(saveButton());
    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(2));
    expect(H.rpc.mock.calls[1][1].p_idempotency_key).toBe(H.rpc.mock.calls[0][1].p_idempotency_key);
  });

  it('a typed type with a comma survives a reopen and save unchanged', async () => {
    H.rpc.mockResolvedValue(receipt);
    await openEditor(row({ label_adjuvants: [{ kind: 'required', adjuvant_types: ['COC', 'oil, methylated'] }] }));
    fireEvent.change(screen.getByLabelText('Statement 1 note'), { target: { value: 'n' } });
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'r' } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(H.rpc).toHaveBeenCalledWith('set_registration_adjuvants', expect.objectContaining({
      p_adjuvants: [{ kind: 'required', adjuvant_types: ['COC', 'oil, methylated'], note: 'n' }],
    })));
  });

  it('stale: keeps the draft, shows their list, and saves again on the new version with a new key', async () => {
    H.rpc.mockResolvedValueOnce({ data: null, error: { message: 'EPA_REGISTRATION_STALE: EPA registration 264-849 changed since you opened it; reload and try again' } })
      .mockResolvedValueOnce(receipt);
    H.getRegistrations.mockResolvedValue(new Map([['264-849', row({ registration_version: 5, label_adjuvants: [{ kind: 'recommended', adjuvant_types: ['NIS'] }] })]]));
    const onSaved = vi.fn();
    await openEditor(row(), onSaved);
    fireEvent.click(screen.getByRole('button', { name: 'Add a statement' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Statement 1 types' })).getByLabelText('COC'));
    fireEvent.change(screen.getByLabelText('Why'), { target: { value: 'r' } });
    fireEvent.click(saveButton());
    expect(await screen.findByText('Just saved by someone else')).toBeTruthy();
    // The page re-reads, so a reopened editor would start from the new version.
    expect(onSaved).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Recommended:', { exact: false })).toBeTruthy();
    expect(within(screen.getByRole('group', { name: 'Statement 1 types' })).getByLabelText('COC')).toBeChecked();
    fireEvent.click(saveButton());
    await waitFor(() => expect(H.rpc).toHaveBeenCalledTimes(2));
    expect(H.rpc.mock.calls[1][1].p_expected_version).toBe(5);
    expect(H.rpc.mock.calls[1][1].p_idempotency_key).not.toBe(H.rpc.mock.calls[0][1].p_idempotency_key);
  });
});
