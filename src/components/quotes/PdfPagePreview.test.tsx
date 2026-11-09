import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getDocument, destroy, cancel } = vi.hoisted(() => ({
  getDocument: vi.fn(),
  destroy: vi.fn(() => Promise.resolve()),
  cancel: vi.fn(),
}));

vi.mock('pdfjs-dist', () => ({ GlobalWorkerOptions: { workerSrc: '' }, getDocument }));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }));

import PdfPagePreview from './PdfPagePreview';

function pdfWithPages(numPages: number) {
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    render: vi.fn(() => ({ promise: Promise.resolve(), cancel })),
  };
  getDocument.mockReturnValue({ promise: Promise.resolve({ numPages, getPage: () => Promise.resolve(page) }), destroy });
  return page;
}

afterEach(() => vi.clearAllMocks());

describe('PdfPagePreview', () => {
  it('renders one canvas per page', async () => {
    const page = pdfWithPages(3);
    render(<PdfPagePreview blob={new Blob(['%PDF'])} title="Quote Q-1" />);

    await waitFor(() => expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument());
    const pages = screen.getAllByRole('img', { name: /^Quote Q-1, page \d of 3$/ });
    expect(pages).toHaveLength(3);
    expect(pages.every((el) => el.tagName === 'CANVAS')).toBe(true);
    expect(screen.getByRole('img', { name: 'Quote Q-1, page 2 of 3' })).toBeInTheDocument();
    expect(page.render).toHaveBeenCalledTimes(3);
  });

  it('shows a plain error when the PDF cannot be read', async () => {
    getDocument.mockReturnValue({ promise: Promise.reject(new Error('bad pdf')), destroy });
    render(<PdfPagePreview blob={new Blob(['x'])} title="Quote Q-1" />);
    expect(await screen.findByText(/preview could not be shown/i)).toBeInTheDocument();
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('destroys the loading task and frees canvas memory on unmount', async () => {
    pdfWithPages(1);
    const { unmount } = render(<PdfPagePreview blob={new Blob(['%PDF'])} title="Quote Q-1" />);
    const canvas = await screen.findByRole('img', { name: 'Quote Q-1, page 1 of 1' }) as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThan(0);
    unmount();
    expect(destroy).toHaveBeenCalled();
    expect([canvas.width, canvas.height]).toEqual([0, 0]);
  });

  it('keeps the old pages, without a skeleton, until the new blob is fully drawn', async () => {
    pdfWithPages(1);
    const { rerender } = render(<PdfPagePreview blob={new Blob(['%PDF-a'])} title="Quote Q-1" />);
    const oldPage = await screen.findByRole('img', { name: 'Quote Q-1, page 1 of 1' }) as HTMLCanvasElement;

    let finish = () => {};
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
      render: vi.fn(() => ({ promise: pending, cancel })),
    };
    getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: 2, getPage: () => Promise.resolve(page) }), destroy });
    rerender(<PdfPagePreview blob={new Blob(['%PDF-b'])} title="Quote Q-1" />);

    await waitFor(() => expect(page.render).toHaveBeenCalled());
    expect(screen.getByRole('img', { name: 'Quote Q-1, page 1 of 1' })).toBe(oldPage);
    expect(screen.queryByText('Loading preview…')).not.toBeInTheDocument();

    finish();
    await waitFor(() => expect(screen.getAllByRole('img', { name: /of 2$/ })).toHaveLength(2));
    expect(screen.queryByRole('img', { name: 'Quote Q-1, page 1 of 1' })).not.toBeInTheDocument();
    expect([oldPage.width, oldPage.height]).toEqual([0, 0]);
  });
});
