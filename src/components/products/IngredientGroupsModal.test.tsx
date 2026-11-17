import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ rpc: vi.fn(), toast: vi.fn() }));
vi.mock('../../lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/db')>()),
  supabaseUntyped: { rpc: H.rpc },
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: H.toast }) }));
import IngredientGroupsModal from './IngredientGroupsModal';

const users = (modes: Array<{ scheme: string; group_code: string; source_note: string }>) => ({
  data: { ingredient_id: 'ing1', name: 'atrazine', status: 'active', modes, parents_affected: 2, products_affected: 3 }, error: null,
});
const HRAC5 = { scheme: 'HRAC', group_code: '5', source_note: 'HRAC 2024' };
const saveCalls = () => H.rpc.mock.calls.filter(([name]) => name === 'set_active_ingredient_modes');

function show(onSaved = vi.fn()) {
  render(<IngredientGroupsModal ingredientId="ing1" ingredientName="atrazine" acidName={null} profileId="u1" onClose={vi.fn()} onSaved={onSaved} />);
  return onSaved;
}

describe('IngredientGroupsModal', () => {
  beforeEach(() => {
    H.rpc.mockReset();
    H.toast.mockReset();
    window.localStorage.clear();
  });

  it('sends the list it loaded as the expected list, and says how many products change', async () => {
    H.rpc.mockImplementation(async (name: string) => (name === 'get_ingredient_mode_users' ? users([HRAC5])
      : { data: { ingredient_id: 'ing1', modes: [], unchanged: false, parents_affected: 2, products_affected: 3 }, error: null }));
    const onSaved = show();
    expect(await screen.findByText('Used by 3 products.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save groups' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Add a group' }));
    const codes = screen.getAllByLabelText('Group');
    fireEvent.change(codes[1], { target: { value: ' 9 ' } });
    fireEvent.change(screen.getAllByLabelText('Where is this from?')[1], { target: { value: 'label' } });
    fireEvent.change(screen.getByLabelText('Why are the groups changing?'), { target: { value: 'premix label' } });
    expect(screen.getByText('This changes the groups shown on 3 products.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save groups' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [, args] = saveCalls()[0];
    expect(args).toMatchObject({
      p_ingredient_id: 'ing1', p_expected_modes: [HRAC5], p_reason: 'premix label',
      p_modes: [HRAC5, { scheme: 'HRAC', group_code: '9', source_note: 'label' }],
    });
    expect(typeof args.p_idempotency_key).toBe('string');
  });

  it('a note-only change says "Used by", not "changes the groups"', async () => {
    H.rpc.mockResolvedValue(users([HRAC5]));
    show();
    fireEvent.change(await screen.findByLabelText('Where is this from?'), { target: { value: 'HRAC 2025' } });
    expect(screen.getByText('Used by 3 products.')).toBeInTheDocument();
  });

  it('a stale list is refused, reloaded, and the admin is told someone else changed it', async () => {
    let loads = 0;
    H.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_ingredient_mode_users') { loads += 1; return users(loads === 1 ? [] : [HRAC5]); }
      return { data: null, error: { code: 'P0001', message: 'MOA_LIST_STALE: the groups of "atrazine" changed since you opened them; reload' } };
    });
    const onSaved = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a group' }));
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: '27' } });
    fireEvent.change(screen.getByLabelText('Where is this from?'), { target: { value: 'label' } });
    fireEvent.change(screen.getByLabelText('Why are the groups changing?'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save groups' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('warning', expect.stringMatching(/Someone else just changed these groups/)));
    await waitFor(() => expect(screen.getByLabelText('Group')).toHaveValue('5'));
    expect(onSaved).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
  });

  it('an unconfirmed save locks the form and Finish save re-sends the identical request with the same key', async () => {
    let sends = 0;
    H.rpc.mockImplementation(async (name: string) => {
      if (name === 'get_ingredient_mode_users') return users([]);
      sends += 1;
      if (sends === 1) throw new TypeError('Failed to fetch');
      return { data: { ingredient_id: 'ing1', modes: [HRAC5], unchanged: false, parents_affected: 2, products_affected: 3 }, error: null };
    });
    const onSaved = show();
    fireEvent.click(await screen.findByRole('button', { name: 'Add a group' }));
    fireEvent.change(screen.getByLabelText('Group'), { target: { value: '5' } });
    fireEvent.change(screen.getByLabelText('Where is this from?'), { target: { value: 'HRAC 2024' } });
    fireEvent.change(screen.getByLabelText('Why are the groups changing?'), { target: { value: 'new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save groups' }));
    const finish = await screen.findByRole('button', { name: 'Finish save' });
    expect(screen.getByLabelText('Group')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save groups' })).toBeDisabled();
    fireEvent.click(finish);
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [first, second] = saveCalls().map(([, args]) => args);
    expect(second).toEqual(first);
  });

  it('an equivalent spelling refused by the database is shown and nothing is kept pending', async () => {
    H.rpc.mockImplementation(async (name: string) => (name === 'get_ingredient_mode_users' ? users([HRAC5])
      : { data: null, error: { code: 'P0001', message: 'CHEMISTRY_MOA_INVALID: HRAC 05 is already recorded as HRAC 5; retire the stored spelling before adding this spelling' } }));
    show();
    fireEvent.change(await screen.findByLabelText('Group'), { target: { value: '05' } });
    fireEvent.change(screen.getByLabelText('Why are the groups changing?'), { target: { value: 'typo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save groups' }));
    await waitFor(() => expect(H.toast).toHaveBeenCalledWith('error', expect.stringMatching(/already recorded as HRAC 5/)));
    expect(window.localStorage.length).toBe(0);
    expect(screen.getByLabelText('Group')).not.toBeDisabled();
  });
});
