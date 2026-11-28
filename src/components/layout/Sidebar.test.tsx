import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mockProfile = vi.fn();
const mockDeniedPages = vi.fn();

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    profile: mockProfile(),
    deniedPages: mockDeniedPages(),
    signOut: vi.fn(),
  }),
}));

vi.mock('../../lib/pagePermissions', () => ({
  hasPageAccess: vi.fn(() => true),
  getPageKeyFromPath: vi.fn((path: string) => path.replace('/', '')),
}));

import Sidebar from './Sidebar';
import { hasPageAccess } from '../../lib/pagePermissions';
import { recordPageVisit } from '../../lib/recentPages';

function renderSidebar(mobileOpen = false) {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Sidebar mobileOpen={mobileOpen} onClose={vi.fn()} />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDeniedPages.mockReturnValue([]);
  localStorage.clear();
});

describe('Sidebar', () => {
  it('renders Sell & Deliver category for admin', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    // Desktop + mobile + tooltip can produce multiple matches
    expect(screen.getAllByText('Sell & Deliver').length).toBeGreaterThan(0);
  });

  it('renders Today and the Load-Out Board as the office standalones', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByText('Today').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Load-Out Board').length).toBeGreaterThan(0);
  });

  it('uses plain menu names with no parentheses', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar(true);
    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    for (const link of within(drawer).getAllByRole('link')) {
      expect(link.textContent).not.toMatch(/[()]/);
    }
  });

  it('renders Team Board for all roles', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
    renderSidebar();
    expect(screen.getAllByText('Team Board').length).toBeGreaterThan(0);
  });

  it('renders Settings for admin only', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByText('Settings').length).toBeGreaterThan(0);
  });

  it('hides Settings for non-admin roles', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
    renderSidebar();
    expect(screen.queryAllByText('Settings')).toHaveLength(0);
  });

  it('renders Sign Out button', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar(true);
    expect(screen.getAllByText('Sign Out').length).toBeGreaterThan(0);
  });

  it('lists the Billing group in the order of the bookkeeper\'s day, Prepayments once', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar(true);
    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    const billing = within(drawer).getByText('Billing').closest('div')?.parentElement as HTMLElement;
    expect(within(billing).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Chemical Invoices',
      'Field Invoices',
      'Record Payments',
      'Prepayments',
      'Accounts Receivable',
      'Aging & Statements',
      'Payment History',
      'Commissions',
      'Month-End Close',
    ]);
    expect(within(drawer).getAllByText('Prepayments')).toHaveLength(1);
    expect(screen.queryAllByText('Money')).toHaveLength(0);
  });

  it('shows a sales rep only the Billing pages that role can open', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    renderSidebar(true);
    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    const billing = within(drawer).getByText('Billing').closest('div')?.parentElement as HTMLElement;
    expect(within(billing).getAllByRole('link').map((a) => a.textContent)).toEqual([
      'Chemical Invoices',
      'Field Invoices',
      'Record Payments',
    ]);
  });

  it('keeps Setup folded on the phone drawer until tapped', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar(true);
    const drawer = screen.getByRole('dialog', { name: 'Navigation menu' });
    const setup = within(drawer).getByText('Setup').closest('details') as HTMLDetailsElement;
    expect(setup).not.toBeNull();
    expect(setup.open).toBe(false);
    // Its links are still in the menu, behind the fold.
    expect(within(setup).getByText('Data Integrity').closest('a')).toHaveAttribute('href', '/integrity');
  });

  it('renders Customers & Fields category for sales_rep', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    renderSidebar();
    expect(screen.getAllByText('Customers & Fields').length).toBeGreaterThan(0);
  });

  it('shows only the driver phone menu, not office categories', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
    renderSidebar();
    expect(screen.getAllByText('My Route').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Deliveries').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Team Board').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Help').length).toBeGreaterThan(0);
    expect(screen.queryByText('Sell & Deliver')).not.toBeInTheDocument();
  });

  it('has navigation landmark', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    renderSidebar();
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0);
  });

  it('closes the mobile drawer with Escape', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    const onClose = vi.fn();
    render(
      <MemoryRouter initialEntries={['/']}>
        <Sidebar mobileOpen onClose={onClose} />
      </MemoryRouter>
    );

    expect(screen.getByRole('dialog', { name: 'Navigation menu' })).toHaveAttribute('aria-modal', 'true');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps a workspace entry visible when only its lead page is denied, linking to the first allowed sibling', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    vi.mocked(hasPageAccess).mockImplementation(
      (_role, _denied, pageKey) => pageKey !== 'products' && pageKey !== 'supplier-pricing'
    );
    renderSidebar(true);

    const links = screen.getAllByText('Products & Pricing').map((el) => el.closest('a'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/brand-vs-generic');
    }
  });

  it('hides a workspace entry when every sibling page is denied', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    const denied = new Set(['products', 'supplier-pricing', 'brand-vs-generic', 'group-products']);
    vi.mocked(hasPageAccess).mockImplementation((_role, _denied, pageKey) => !denied.has(pageKey));
    renderSidebar(true);

    expect(screen.queryAllByText('Products & Pricing')).toHaveLength(0);
  });

  it('keeps the Insights standalone visible when only /dashboard is denied, linking to Reports', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'sales_rep', full_name: 'Sales Rep' });
    vi.mocked(hasPageAccess).mockImplementation((_role, _denied, pageKey) => pageKey !== 'dashboard');
    renderSidebar(true);

    const links = screen.getAllByText('Insights').map((el) => el.closest('a'));
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link).toHaveAttribute('href', '/reports');
    }
  });

  it('credits sibling-page visits to the condensed workspace entry in Frequent', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    // Visits landed on the siblings the condensed entry fronts, not on /products itself
    localStorage.setItem(
      'crx-page-visit-counts',
      JSON.stringify({ 'supplier-pricing': 2, 'brand-vs-generic': 2 })
    );
    renderSidebar(true);

    expect(screen.getAllByText('Frequent').length).toBeGreaterThan(0);
    const frequentSection = screen.getAllByText('Frequent')[0].closest('div')?.parentElement;
    expect(frequentSection?.textContent).toContain('Products & Pricing');
  });

  it('surfaces an entry in Frequent immediately when a visit crosses the threshold', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'admin', full_name: 'Admin User' });
    // One visit short of the threshold of 3 for the Products & Pricing entry
    localStorage.setItem('crx-page-visit-counts', JSON.stringify({ 'supplier-pricing': 2 }));
    renderSidebar(true);
    expect(screen.queryAllByText('Frequent')).toHaveLength(0);

    // The threshold-crossing visit must refresh the already-rendered sidebar
    // via the change event, without waiting for another navigation.
    act(() => {
      recordPageVisit('/brand-vs-generic', 'Brand vs Generic');
    });

    expect(screen.getAllByText('Frequent').length).toBeGreaterThan(0);
    const frequentSection = screen.getAllByText('Frequent')[0].closest('div')?.parentElement;
    expect(frequentSection?.textContent).toContain('Products & Pricing');
  });

  it('traps focus within the open mobile drawer', () => {
    mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
    renderSidebar(true);

    const closeButton = screen.getByRole('button', { name: 'Close navigation menu' });
    const signOutButton = screen.getAllByRole('button', { name: 'Sign Out' })[0];
    signOutButton.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(closeButton).toHaveFocus();
  });

  describe('pinning links to the top', () => {
    function expandSidebar() {
      // The desktop rail starts collapsed; opening a group expands it.
      fireEvent.click(screen.getByRole('button', { name: 'Expand Sell & Deliver navigation' }));
    }

    it('pins a link into a Pinned section and saves it for that user only', () => {
      mockProfile.mockReturnValue({ id: 'user-a', role: 'admin', full_name: 'Admin User' });
      renderSidebar();
      expandSidebar();

      fireEvent.click(screen.getByRole('button', { name: 'Pin Orders to top' }));

      const pinnedHeading = screen.getAllByText('Pinned')[0];
      const pinnedSection = pinnedHeading.closest('div')?.parentElement as HTMLElement;
      expect(within(pinnedSection).getByText('Orders').closest('a')).toHaveAttribute('href', '/orders');
      expect(JSON.parse(localStorage.getItem('crx-sidebar-pins:user-a') ?? '[]')).toEqual(['/orders']);
      expect(localStorage.getItem('crx-sidebar-pins:user-b')).toBeNull();
    });

    it('unpins from the Pinned section', () => {
      localStorage.setItem('crx-sidebar-pins:user-a', JSON.stringify(['/orders']));
      mockProfile.mockReturnValue({ id: 'user-a', role: 'admin', full_name: 'Admin User' });
      renderSidebar();
      expandSidebar();

      fireEvent.click(screen.getAllByRole('button', { name: 'Unpin Orders' })[0]);

      expect(screen.queryAllByText('Pinned')).toHaveLength(0);
      expect(JSON.parse(localStorage.getItem('crx-sidebar-pins:user-a') ?? '[]')).toEqual([]);
    });

    it('never shows a pinned page the role cannot open', () => {
      // A shared computer: these pins were saved for an id that is now a sales rep.
      localStorage.setItem('crx-sidebar-pins:user-a', JSON.stringify(['/settings', '/month-end', '/orders']));
      mockProfile.mockReturnValue({ id: 'user-a', role: 'sales_rep', full_name: 'Sales Rep' });
      renderSidebar();
      expandSidebar();

      const pinnedSection = screen.getAllByText('Pinned')[0].closest('div')?.parentElement as HTMLElement;
      expect(Array.from(pinnedSection.querySelectorAll('a'), (a) => a.textContent)).toEqual(['Orders']);
    });

    it('drops a pinned page that is on the person\'s deny list', () => {
      localStorage.setItem('crx-sidebar-pins:user-a', JSON.stringify(['/orders']));
      mockProfile.mockReturnValue({ id: 'user-a', role: 'sales_rep', full_name: 'Sales Rep' });
      vi.mocked(hasPageAccess).mockImplementation((_role, _denied, pageKey) => pageKey !== 'orders');
      renderSidebar();
      expandSidebar();

      expect(screen.queryAllByText('Pinned')).toHaveLength(0);
    });

    it('ignores unreadable saved pins', () => {
      localStorage.setItem('crx-sidebar-pins:user-a', '{not json');
      mockProfile.mockReturnValue({ id: 'user-a', role: 'admin', full_name: 'Admin User' });
      renderSidebar();
      expect(screen.queryAllByText('Pinned')).toHaveLength(0);
    });

    it('offers no pin control on the driver menu', () => {
      mockProfile.mockReturnValue({ id: '1', role: 'driver', full_name: 'Driver User' });
      renderSidebar();
      expect(screen.queryAllByRole('button', { name: /^Pin / })).toHaveLength(0);
    });
  });
});
