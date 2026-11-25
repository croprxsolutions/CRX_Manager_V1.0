import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { BrandDocumentLink } from '../../types';
import BrandDocuments from './BrandDocuments';

const hooks = vi.hoisted(() => ({ mutate: vi.fn(), history: vi.fn(), toast: vi.fn() }));
vi.mock('../../lib/brandDocuments', async (actual) => ({
  ...await actual<typeof import('../../lib/brandDocuments')>(),
  changeBrandDocumentLinks: hooks.mutate,
  readBrandDocumentHistory: hooks.history,
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: hooks.toast }) }));

const target = { id: 'brand-1', parent_brand: true, brand_version: 2 };
const label: BrandDocumentLink = {
  id: 'link-1', legacy_brand_id: null, parent_brand_id: target.id, document_kind: 'specimen',
  url: 'https://www.syngenta-us.com/current-label/dual_ii_magnum', state_code: null, expires_on: null,
  row_version: 1, hidden_at: null, reported_at: null,
};

describe('Brand documents on Product Detail', () => {
  it('shows who changed a link and lets admins open older history', async () => {
    const event = {
      id: 'recent', link_id: label.id, action: 'saved', changed_by: 'editor',
      created_at: '2026-11-24T14:00:00Z', before_value: null, after_value: { url: label.url },
    };
    hooks.history.mockResolvedValueOnce({ events: [event], hasOlder: true, names: new Map([['editor', 'Pat Editor']]) })
      .mockResolvedValueOnce({ events: [{ ...event, id: 'older', reason: 'Old report was verified' }], hasOlder: false, names: new Map() });
    render(<BrandDocuments target={target} brandName="Dual II Magnum" links={[label]}
      canEdit userId="admin" onReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Manage documents for Dual II Magnum' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show history' }));
    expect(await screen.findByText(/Pat Editor/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Older changes' }));
    expect(await screen.findByText('Old report was verified')).toBeVisible();
    expect(hooks.history).toHaveBeenCalledWith(target, 0);
    expect(hooks.history).toHaveBeenCalledWith(target, 1);
  });

  it('opens manufacturer documents and shows an expired supplement without an active link', () => {
    const sds: BrandDocumentLink = {
      ...label, id: 'link-2', document_kind: 'sds', url: 'https://www.syngenta-us.com/sds-label/dual_ii_magnum',
    };
    const expired: BrandDocumentLink = {
      ...label, id: 'link-3', document_kind: 'supplemental', state_code: 'IA', expires_on: '2001-01-01',
    };
    render(<BrandDocuments target={target} brandName="Dual II Magnum" links={[label, sds, expired]}
      canEdit={false} userId="staff" onReload={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Specimen label' })).toHaveAttribute('href', label.url);
    expect(screen.getByRole('link', { name: 'SDS' })).toHaveAttribute('href', sds.url);
    expect(screen.getByText('Supplemental / 24(c) · IA · Expired')).toBeVisible();
    expect(screen.queryByRole('link', { name: /Supplemental/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Manage documents/ })).not.toBeInTheDocument();
  });

  it('reports the displayed link and its exact version on the ordinary staff path', async () => {
    hooks.mutate.mockResolvedValue(undefined);
    const reload = vi.fn();
    render(<BrandDocuments target={target} brandName="Dual II Magnum" links={[label]}
      canEdit={false} userId="staff" onReload={reload} />);
    fireEvent.click(screen.getByRole('button', { name: /Report broken link for Dual II Magnum/ }));
    await waitFor(() => expect(reload).toHaveBeenCalledOnce());
    expect(hooks.mutate).toHaveBeenCalledWith(target, [{ action: 'report', id: label.id, version: label.row_version }], expect.any(String));
  });
});
