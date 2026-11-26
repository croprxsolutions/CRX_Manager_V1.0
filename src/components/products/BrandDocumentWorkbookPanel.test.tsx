import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { ParsedBrandDocuments } from '../../lib/productSetupBrandDocumentsWorkbook';
import BrandDocumentWorkbookPanel from './BrandDocumentWorkbookPanel';

const api = vi.hoisted(() => ({ preview: vi.fn(), workspace: vi.fn(), save: vi.fn() }));
vi.mock('../../lib/brandDocuments', async (actual) => ({
  ...await actual<typeof import('../../lib/brandDocuments')>(),
  previewBrandDocumentLinks: api.preview,
  readBrandDocumentWorkspace: api.workspace,
  changeBrandDocumentLinks: api.save,
}));

it.each([
  ['BRAND_CHANGED: reload this brand before changing its document links', 'Trade brand changed. Download a fresh workbook.'],
  ['BRAND_DOCUMENT_CHANGED: a matching document link already exists; reload this brand',
    'A matching link already exists for Trade brand. Review it on Product Detail or clear the duplicate in the workbook.'],
])('blocks workbook saving and explains the server refusal (%s)', async (error, message) => {
  const target = { id: 'brand-1', parent_brand: true, brand_version: 2 };
  const parsed: ParsedBrandDocuments = { issues: [], rows: [{
    target, ownerName: 'Product group', brandName: 'Trade brand',
    changes: [{ action: 'save', kind: 'sds', url: 'https://manufacturer.example/sds' }],
  }] };
  api.workspace.mockResolvedValue([{ ...target, owner_name: 'Product group', brand_name: 'Trade brand' }]);
  api.preview.mockRejectedValue({ message: error });
  render(<BrandDocumentWorkbookPanel parsed={parsed} profileId="admin" parentBusy={false} onBusyChange={vi.fn()} />);

  const save = screen.getByRole('button', { name: 'Save brand links' });
  expect(save).toBeDisabled();
  expect(await screen.findByText(message)).toBeVisible();
  expect(api.preview).toHaveBeenCalledWith(target, parsed.rows[0].changes);
  expect(save).toBeDisabled();
  expect(api.save).not.toHaveBeenCalled();
});

it.each([false, true])('keeps confirmed brands saved after a partial failure (workbook stale: %s)', async (stale) => {
  const changes = [{ action: 'save', kind: 'supplemental', url: 'https://manufacturer.example/supplement',
    state: 'IA', expires_on: '2027-12-31' }] as const;
  const rows: ParsedBrandDocuments['rows'] = ['brand-1', 'brand-2'].map((id) => ({
    target: { id, parent_brand: true, brand_version: 2 }, ownerName: 'Product group', brandName: id,
    changes: [...changes],
  }));
  api.save.mockReset().mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error(stale ? 'BRAND_DOCUMENT_CHANGED: reload before changing' : 'Connection dropped'))
    .mockResolvedValueOnce(undefined);
  api.workspace.mockResolvedValue(rows.map((row) => ({ ...row.target, owner_name: row.ownerName, brand_name: row.brandName })));
  api.preview.mockResolvedValue(undefined);
  render(<BrandDocumentWorkbookPanel parsed={{ issues: [], rows }} profileId="admin" parentBusy={false} onBusyChange={vi.fn()} />);

  const save = screen.getByRole('button', { name: 'Save brand links' });
  await waitFor(() => expect(save).toBeEnabled());
  expect(screen.getAllByText(/State IA · Expires 2027-12-31/)).toHaveLength(2);
  fireEvent.click(save);
  expect(await screen.findByText(/Earlier confirmed brands remain saved/)).toBeVisible();
  expect(screen.getByText('Saved links for 1 brand.')).toBeVisible();
  expect(api.save).toHaveBeenNthCalledWith(1, rows[0].target, rows[0].changes, expect.any(String));
  expect(api.save).toHaveBeenNthCalledWith(2, rows[1].target, rows[1].changes, expect.any(String));
  expect(api.save.mock.calls[0][2]).not.toBe(api.save.mock.calls[1][2]);
  if (stale) {
    expect(screen.getByRole('alert')).toHaveTextContent('Download a fresh workbook');
    expect(save).toBeDisabled();
    return;
  }
  fireEvent.click(save);
  expect(await screen.findByText('Saved links for 2 brands.')).toBeVisible();
  expect(api.save.mock.calls[2]).toEqual(api.save.mock.calls[1]);
});
