/**
 * Private staff photos (Goal 1): the app shows photos only through a download made with the
 * signed-in user's session, never through a storage URL, and holds up on weak field signal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';

const H = vi.hoisted(() => ({
  download: vi.fn(),
  from: vi.fn(),
}));

vi.mock('./db', () => ({
  supabase: { storage: { from: (bucket: string) => { H.from(bucket); return { download: H.download }; } } },
}));
vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

import { storagePathFromPublicUrl, deliveryPhotoPath } from './privatePhotos';
import PrivatePhoto, { PrivatePhotoButton } from '../components/ui/PrivatePhoto';
import Modal from '../components/ui/Modal';

const PUBLIC = 'https://rhyzpcqhnizqbxphqdkr.supabase.co/storage/v1/object/public';
const blob = () => new Blob(['x'], { type: 'image/jpeg' });

describe('storagePathFromPublicUrl', () => {
  it('returns the object path inside the bucket, keeping a repeated bucket folder', () => {
    expect(storagePathFromPublicUrl(`${PUBLIC}/team-note-attachments/team-note-attachments/u1/1_0.jpg`, 'team-note-attachments'))
      .toBe('team-note-attachments/u1/1_0.jpg');
  });
  it('drops a query string and decodes escapes', () => {
    expect(storagePathFromPublicUrl(`${PUBLIC}/delivery-photos/delivery-photos/d1/a%20b.jpg?t=1`, 'delivery-photos'))
      .toBe('delivery-photos/d1/a b.jpg');
  });
  it('refuses a URL for another bucket, a non-public URL or nothing', () => {
    expect(storagePathFromPublicUrl(`${PUBLIC}/delivery-photos/x.jpg`, 'team-note-attachments')).toBeNull();
    expect(storagePathFromPublicUrl('https://example.com/x.jpg', 'delivery-photos')).toBeNull();
    expect(storagePathFromPublicUrl(null, 'delivery-photos')).toBeNull();
  });
  it('prefers a delivery photo\'s storage_path and falls back to its old URL', () => {
    expect(deliveryPhotoPath({ storage_path: 'delivery-photos/d1/1.jpg', image_url: 'ignored' })).toBe('delivery-photos/d1/1.jpg');
    expect(deliveryPhotoPath({ storage_path: null, image_url: `${PUBLIC}/delivery-photos/delivery-photos/d1/2.jpg` })).toBe('delivery-photos/d1/2.jpg');
  });
});

describe('PrivatePhoto', () => {
  let urls = 0;
  const createObjectURL = vi.fn(() => `blob:tab-local-${++urls}`);
  const revokeObjectURL = vi.fn();

  beforeEach(() => {
    urls = 0;
    H.download.mockReset();
    H.from.mockReset();
    createObjectURL.mockClear();
    revokeObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });
  afterEach(cleanup);

  it('downloads with the session and shows only a blob: URL, released on unmount', async () => {
    H.download.mockResolvedValue({ data: blob(), error: null });
    const view = render(<PrivatePhoto bucket="delivery-photos" path="delivery-photos/d1/1.jpg" alt="Delivery photo" />);
    const img = await screen.findByRole('img', { name: 'Delivery photo' });
    expect(img.getAttribute('src')).toBe('blob:tab-local-1');
    expect(H.from).toHaveBeenCalledWith('delivery-photos');
    expect(H.download).toHaveBeenCalledWith('delivery-photos/d1/1.jpg', {}, { signal: expect.any(AbortSignal), cache: 'no-store' });
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:tab-local-1');
  });

  it('aborts an unfinished download on unmount and never creates a blob for it', async () => {
    let signal: AbortSignal | undefined;
    let finish: (v: unknown) => void = () => {};
    H.download.mockImplementation((_p: string, _o: unknown, params: { signal: AbortSignal }) => {
      signal = params.signal;
      return new Promise((resolve) => { finish = resolve; });
    });
    const view = render(<PrivatePhoto bucket="delivery-photos" path="delivery-photos/d1/1.jpg" alt="Delivery photo" />);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => { finish({ data: blob(), error: null }); });
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('shows a placeholder, never a URL, when the download is refused', async () => {
    H.download.mockResolvedValue({ data: null, error: new Error('Object not found') });
    render(<PrivatePhoto bucket="team-note-attachments" path="team-note-attachments/u1/1.jpg" alt="Note photo" />);
    await screen.findByRole('img', { name: 'Note photo unavailable' });
    expect(document.querySelector('img')).toBeNull();
  });

  it('ends a dropped connection in a retryable placeholder, not an endless spinner, and retries on tap', async () => {
    H.download.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ data: blob(), error: null });
    render(<PrivatePhoto bucket="delivery-photos" path="delivery-photos/d1/1.jpg" alt="Delivery photo" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry loading Delivery photo' }));
    const img = await screen.findByRole('img', { name: 'Delivery photo' });
    expect(img.getAttribute('src')).toMatch(/^blob:/);
    expect(H.download).toHaveBeenCalledTimes(2);
  });

  it('retries by itself when the device comes back online', async () => {
    H.download.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue({ data: blob(), error: null });
    render(<PrivatePhoto bucket="delivery-photos" path="delivery-photos/d1/1.jpg" alt="Delivery photo" />);
    await screen.findByRole('img', { name: 'Delivery photo unavailable' });
    act(() => { window.dispatchEvent(new Event('online')); });
    await screen.findByRole('img', { name: 'Delivery photo' });
    expect(H.download).toHaveBeenCalledTimes(2);
  });

  it('shows a placeholder without downloading when there is no path', () => {
    render(<PrivatePhoto bucket="delivery-photos" path={null} alt="Delivery photo" />);
    expect(screen.getByRole('img', { name: 'Delivery photo unavailable' })).toBeTruthy();
    expect(H.download).not.toHaveBeenCalled();
  });

  it('opens the full-size photo in an in-app viewer that reuses the thumbnail download', async () => {
    H.download.mockResolvedValue({ data: blob(), error: null });
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<PrivatePhotoButton bucket="delivery-photos" path="delivery-photos/d1/1.jpg" alt="Delivery photo" viewerTitle="Drop site" />);
    fireEvent.click(await screen.findByRole('button', { name: 'View Delivery photo' }));
    await screen.findByRole('dialog', { name: 'Drop site' });
    const imgs = screen.getAllByRole('img', { name: 'Delivery photo' });
    expect(imgs).toHaveLength(2);
    expect(imgs.every((i) => i.getAttribute('src') === 'blob:tab-local-1')).toBe(true);
    expect(H.download).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('closes only the photo viewer on Escape when opened inside a dialog', async () => {
    H.download.mockResolvedValue({ data: blob(), error: null });
    const onCloseNote = vi.fn();
    render(
      <Modal open onClose={onCloseNote} title="Team note">
        <PrivatePhotoButton bucket="team-note-attachments" path="team-note-attachments/u1/1.jpg" alt="Note photo" viewerTitle="Note photo" />
      </Modal>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'View Note photo' }));
    await screen.findByRole('dialog', { name: 'Note photo' });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Note photo' })).toBeNull());
    expect(onCloseNote).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onCloseNote).toHaveBeenCalledTimes(1);
  });
});
