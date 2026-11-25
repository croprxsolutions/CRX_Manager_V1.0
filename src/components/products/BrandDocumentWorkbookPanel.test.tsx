import { render, screen } from '@testing-library/react';
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

it('blocks workbook saving until the server approves the link changes', async () => {
  const target = { id: 'brand-1', parent_brand: true, brand_version: 2 };
  const parsed: ParsedBrandDocuments = { issues: [], rows: [{
    target, ownerName: 'Product group', brandName: 'Trade brand',
    changes: [{ action: 'save', kind: 'sds', url: 'https://manufacturer.example/sds' }],
  }] };
  api.workspace.mockResolvedValue([{ ...target, owner_name: 'Product group', brand_name: 'Trade brand' }]);
  api.preview.mockRejectedValue({ message: 'BRAND_CHANGED: reload this brand before changing its document links' });
  render(<BrandDocumentWorkbookPanel parsed={parsed} profileId="admin" parentBusy={false} onBusyChange={vi.fn()} />);

  const save = screen.getByRole('button', { name: 'Save brand links' });
  expect(save).toBeDisabled();
  expect(await screen.findByText('Trade brand changed. Download a fresh workbook.')).toBeVisible();
  expect(api.preview).toHaveBeenCalledWith(target, parsed.rows[0].changes);
  expect(save).toBeDisabled();
  expect(api.save).not.toHaveBeenCalled();
});
