import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import InvoiceActionsBar from './InvoiceActionsBar';

const act = () => ({ onClick: vi.fn() });
const isPrimary = (el: HTMLElement) => el.className.includes('bg-crx-green');
const buttonNames = () => screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent);
const openMore = () => fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
const menuNames = () => screen.getAllByRole('menuitem').map((el) => el.textContent);

describe('InvoiceActionsBar', () => {
  it('draft: Save changes, Print…, and Post invoice… as the one main button', () => {
    const post = act();
    render(<InvoiceActionsBar save={act()} print={act()} post={{ ...post, dirty: false }} />);
    expect(buttonNames()).toEqual(['Save changes', 'Print…', 'Post invoice…']);
    expect(isPrimary(screen.getByRole('button', { name: 'Post invoice…' }))).toBe(true);
    expect(isPrimary(screen.getByRole('button', { name: 'Save changes' }))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Post invoice…' }));
    expect(post.onClick).toHaveBeenCalledTimes(1);
  });

  it('draft with unsaved edits: Post waits for Save and says so on hover', () => {
    render(<InvoiceActionsBar save={act()} print={act()} post={{ ...act(), dirty: true }} />);
    const post = screen.getByRole('button', { name: 'Post invoice…' });
    expect(post).toBeDisabled();
    expect(post).toHaveAttribute('title', 'Save your changes first');
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled();
  });

  it('field-application draft: Transfer to scheduling… sits in More', () => {
    const transfer = act();
    render(<InvoiceActionsBar save={act()} print={act()} post={{ ...act(), dirty: false }} transfer={transfer} />);
    openMore();
    expect(menuNames()).toEqual(['Transfer to scheduling…']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Transfer to scheduling…' }));
    expect(transfer.onClick).toHaveBeenCalledTimes(1);
  });

  it('posted, admin: Print…, Email, More, and Record payment as the main button; Void is red and last', () => {
    const handlers = { applyCredit: act(), writeOff: act(), unpost: act(), voidInvoice: act() };
    render(<InvoiceActionsBar print={act()} email={act()} recordPayment={act()} {...handlers} />);
    expect(buttonNames()).toEqual(['Print…', 'Email', 'More actions', 'Record payment']);
    expect(isPrimary(screen.getByRole('button', { name: 'Record payment' }))).toBe(true);
    openMore();
    expect(menuNames()).toEqual(['Apply credit…', 'Write off…', 'Unpost…', 'Void invoice…']);
    expect(screen.getByRole('menuitem', { name: 'Void invoice…' }).className).toContain('text-red-700');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Void invoice…' }));
    expect(handlers.voidInvoice.onClick).toHaveBeenCalledTimes(1);
  });

  it('posted, sales rep: Print…, More with Unpost…, and Apply credit… as the main button', () => {
    render(<InvoiceActionsBar print={act()} applyCredit={act()} unpost={act()} />);
    expect(buttonNames()).toEqual(['Print…', 'More actions', 'Apply credit…']);
    expect(isPrimary(screen.getByRole('button', { name: 'Apply credit…' }))).toBe(true);
    openMore();
    expect(menuNames()).toEqual(['Unpost…']);
  });

  it('a new invoice has only Save changes, as the main button', () => {
    render(<InvoiceActionsBar save={act()} />);
    expect(buttonNames()).toEqual(['Save changes']);
    expect(isPrimary(screen.getByRole('button', { name: 'Save changes' }))).toBe(true);
  });

  it('a busy action in More is disabled', () => {
    render(<InvoiceActionsBar print={act()} unpost={{ ...act(), loading: true }} />);
    openMore();
    expect(screen.getByRole('menuitem', { name: 'Unpost…' })).toHaveAttribute('aria-disabled', 'true');
  });
});
