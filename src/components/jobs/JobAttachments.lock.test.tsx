/**
 * #2188 (Sol r2): an attachment delete confirmation already open when editing is taken away
 * (the job was found deleted) closes and cannot delete the file.
 */
import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

const { mockDelete, mockToast } = vi.hoisted(() => ({ mockDelete: vi.fn(), mockToast: vi.fn() }));

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ profile: { id: 'user-1', role: 'admin' }, role: 'admin' }),
}));
vi.mock('../ui/Toast', () => ({ useToast: () => ({ toast: mockToast }) }));
vi.mock('../../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../../lib/db', () => ({ supabase: { from: () => ({ select: () => ({ in: () => Promise.resolve({ data: [], error: null }) }) }) } }));
vi.mock('../../lib/jobAttachmentsData', () => ({
  listJobAttachments: () => Promise.resolve([{
    id: 'a1', job_id: 'job-x', storage_path: 'job-x/a.pdf', file_name: 'log.pdf',
    file_size: 10, content_type: 'application/pdf', uploaded_by: 'user-1', uploaded_at: '2026-11-01T00:00:00Z',
  }]),
  uploadJobAttachment: vi.fn(),
  getAttachmentDownloadUrl: vi.fn(),
  deleteJobAttachment: mockDelete,
}));

import JobAttachments from './JobAttachments';

describe('JobAttachments — editing taken away', () => {
  it('closes an open delete confirmation and deletes nothing', async () => {
    const { rerender } = render(<JobAttachments jobId="job-x" canEdit />);
    const del = await screen.findByRole('button', { name: 'Delete log.pdf' });
    await act(async () => { fireEvent.click(del); });
    expect(screen.getByText(/Permanently delete "log.pdf"/)).toBeTruthy();
    rerender(<JobAttachments jobId="job-x" canEdit={false} />);
    expect(screen.queryByText(/Permanently delete "log.pdf"/)).toBeNull();
    rerender(<JobAttachments jobId="job-x" canEdit />);
    expect(screen.queryByText(/Permanently delete "log.pdf"/)).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
  });
});
