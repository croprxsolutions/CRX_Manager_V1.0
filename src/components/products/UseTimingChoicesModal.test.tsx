import { StrictMode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CropOption, UseTimingOption } from '../../types';

const H = vi.hoisted(() => ({ add: vi.fn(), setActive: vi.fn(), toast: vi.fn() }));
vi.mock('../../lib/productUseTimings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/productUseTimings')>()),
  addUseTimingOption: H.add,
  setUseTimingOptionActive: H.setActive,
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
import UseTimingChoicesModal from './UseTimingChoicesModal';
import UseTimingPicker from './UseTimingPicker';

const crops: CropOption[] = [{ code: 'wheat', label: 'Wheat', sort_order: 30, is_active: true }];
const oldWheat: UseTimingOption = { code: 'post_emerge_wheet', label: 'Post-Emerge Wheet', timing_code: 'post_emergence', crop: 'wheat', category: 'Herbicide', sort_order: 80, is_active: false, option_version: 2 };
const newWheat: UseTimingOption = { code: 'post_emerge_wheat', label: 'Post-Emerge Wheat', timing_code: 'post_emergence', crop: 'wheat', category: 'Herbicide', sort_order: 90, is_active: true, option_version: 1 };
const burndown: UseTimingOption = { code: 'burndown_preplant', label: 'Burndown (preplant)', timing_code: 'burndown', crop: null, category: 'Herbicide', sort_order: 5, is_active: true, option_version: 1 };

beforeEach(() => vi.clearAllMocks());

describe('UseTimingPicker', () => {
  it('shows a held turned-off choice with Switch to its replacement, and swaps the code', () => {
    const onChange = vi.fn();
    render(<UseTimingPicker options={[burndown, oldWheat, newWheat]} crops={crops} category="Herbicide"
      selected={['burndown_preplant', 'post_emerge_wheet']} held={['burndown_preplant', 'post_emerge_wheet']} onChange={onChange} />);
    expect(screen.getByText('Any crop')).toBeTruthy();
    expect(screen.getByText('Wheat')).toBeTruthy();
    expect(screen.getByLabelText('Post-Emerge Wheet (retired)')).toBeTruthy();
    // The replacement is not offered as a second tick box for the same crop + timing.
    expect(screen.queryByLabelText('Post-Emerge Wheat')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Post-Emerge Wheat' }));
    expect(onChange).toHaveBeenCalledWith(['burndown_preplant', 'post_emerge_wheat']);
  });

  it('ticking a choice unticks another with the same crop and timing', () => {
    const onChange = vi.fn();
    render(<UseTimingPicker options={[burndown, oldWheat, newWheat]} crops={crops} category="Herbicide"
      selected={['burndown_preplant', 'post_emerge_wheat']} held={['post_emerge_wheet']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Post-Emerge Wheet (retired)'));
    expect(onChange).toHaveBeenCalledWith(['burndown_preplant', 'post_emerge_wheet']);
  });

  it('hides a turned-off choice nobody holds', () => {
    render(<UseTimingPicker options={[oldWheat, newWheat]} crops={crops} category="Herbicide" selected={[]} held={[]} onChange={vi.fn()} />);
    expect(screen.queryByText(/Wheet/)).toBeNull();
    expect(screen.getByLabelText('Post-Emerge Wheat')).toBeTruthy();
  });
});

describe('UseTimingChoicesModal', () => {
  const renderModal = (onReload = vi.fn(async () => [burndown, oldWheat, newWheat])) => {
    // StrictMode mounts twice, as the development build does; a reply must still unlock the form.
    render(<StrictMode><UseTimingChoicesModal options={[burndown, oldWheat, newWheat]} crops={crops} defaultCategory="Herbicide"
      profileId="admin-1" onReload={onReload} onClose={vi.fn()} /></StrictMode>);
    return onReload;
  };
  const rowOf = (label: string) => screen.getByText(label).closest('div')!.parentElement as HTMLElement;

  it('adds a choice with the exact request and a retry key, then reloads', async () => {
    H.add.mockResolvedValueOnce({ ...newWheat, code: 'post_emerge_milo', label: 'Post-Emerge Milo' });
    const onReload = renderModal();
    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'post_emergence' } });
    fireEvent.change(screen.getByLabelText('Name shown on products'), { target: { value: ' Post-Emerge Milo ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add choice' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('success', expect.stringContaining('Added "Post-Emerge Milo"')));
    expect(H.add).toHaveBeenCalledWith(expect.objectContaining({ category: 'Herbicide', timingCode: 'post_emergence', crop: null, label: 'Post-Emerge Milo', key: expect.any(String) }));
    expect(onReload).toHaveBeenCalled();
  });

  it('shows a refusal in plain words without reloading', async () => {
    H.add.mockRejectedValueOnce({ message: 'USE_TIMING_PAIR_EXISTS: "Burndown (preplant)" already offers this crop and timing' });
    const onReload = renderModal();
    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'burndown' } });
    fireEvent.change(screen.getByLabelText('Name shown on products'), { target: { value: 'Burndown' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add choice' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', 'Nothing was saved. "Burndown (preplant)" already offers this crop and timing'));
    expect(onReload).not.toHaveBeenCalled();
    // The form unlocks so the admin can fix the request.
    await waitFor(() => expect((screen.getByLabelText('Name shown on products') as HTMLInputElement).closest('fieldset')!.disabled).toBe(false));
  });

  it('after a dropped connection, checks the list before saying whether the add saved', async () => {
    H.add.mockRejectedValueOnce(new Error('Failed to fetch'));
    const milo = { ...newWheat, code: 'post_emerge_milo', label: 'Post-Emerge Milo', crop: null };
    renderModal(vi.fn(async () => [burndown, oldWheat, newWheat, milo]));
    fireEvent.change(screen.getByLabelText('Timing'), { target: { value: 'post_emergence' } });
    fireEvent.change(screen.getByLabelText('Name shown on products'), { target: { value: 'Post-Emerge Milo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add choice' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('success', expect.stringContaining('confirmed after the connection dropped')));
  });

  it('turns a choice off only after the confirm, sending its version, and reports holders', async () => {
    H.setActive.mockResolvedValueOnce({ ...burndown, is_active: false, option_version: 2, sizes_holding: 3, parents_holding: 1 });
    const onReload = renderModal();
    fireEvent.click(within(rowOf('Burndown (preplant)')).getByRole('button', { name: 'Turn off' }));
    expect(H.setActive).not.toHaveBeenCalled();
    const turnOff = screen.getAllByRole('button', { name: 'Turn off' });
    fireEvent.click(turnOff[turnOff.length - 1]);
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('success', expect.stringContaining('3 product size(s) and 1 parent(s) keep it')));
    expect(H.setActive).toHaveBeenCalledWith({ code: 'burndown_preplant', isActive: false, expectedVersion: 1, key: expect.any(String) });
    expect(onReload).toHaveBeenCalled();
  });

  it('says someone else changed it on a stale version, and reloads', async () => {
    H.setActive.mockRejectedValueOnce({ message: 'USE_TIMING_STALE: "Post-Emerge Wheet" changed since you loaded it; refresh and try again' });
    const onReload = renderModal();
    fireEvent.click(within(rowOf('Post-Emerge Wheet')).getByRole('button', { name: 'Turn on' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringContaining('Someone else just changed "Post-Emerge Wheet"')));
    expect(H.setActive).toHaveBeenCalledWith(expect.objectContaining({ code: 'post_emerge_wheet', isActive: true, expectedVersion: 2 }));
    expect(onReload).toHaveBeenCalled();
  });
});
