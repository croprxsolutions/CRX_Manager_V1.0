import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Prepay from './Prepay';

vi.mock('../components/prepay/PrepayWorkspacePanel', () => ({
  default: () => <p>Prepay workspace panel</p>,
}));
vi.mock('../components/prepay/PrepaymentManagerPanel', () => ({
  default: () => <p>Prepayment manager panel</p>,
}));

describe('Prepay', () => {
  it('renders the prepay tabs and switches their panels', () => {
    render(
      <MemoryRouter initialEntries={['/prepay?tab=workspace&customer=customer-1']}>
        <Prepay />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { name: 'Prepayments' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Apply to Invoices' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Prepay Credits' })).toBeInTheDocument();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Prepay workspace panel');

    fireEvent.click(screen.getByRole('tab', { name: 'Prepay Credits' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Prepayment manager panel');
  });

  it('opens the manager tab from a query-addressable link', () => {
    render(
      <MemoryRouter initialEntries={['/prepay?tab=manager']}>
        <Prepay />
      </MemoryRouter>
    );

    expect(screen.getByRole('tab', { name: 'Prepay Credits' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Prepayment manager panel');
  });

  it('falls back to the workspace for an unknown tab', () => {
    render(
      <MemoryRouter initialEntries={['/prepay?tab=unknown']}>
        <Prepay />
      </MemoryRouter>
    );

    expect(screen.getByRole('tab', { name: 'Apply to Invoices' })).toHaveAttribute('aria-selected', 'true');
  });
});
