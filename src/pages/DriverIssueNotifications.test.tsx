import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { buildInMemoryQuery } from '../test-utils/inMemoryQuery';

const H = vi.hoisted(() => ({ message: '', type: 'delivery_issue_reported' }));
vi.mock('../lib/db', async () => {
  const actual = await vi.importActual<typeof import('../lib/db')>('../lib/db');
  return { ...actual, supabase: { from: () => buildInMemoryQuery([{
    id: 'report-1', user_id: 'office', notification_type: H.type, title: 'Driver issue: Other — DEL-007',
    message: H.message, is_read: true, created_at: '2026-10-28T15:00:00Z',
    related_entity_type: 'delivery', related_entity_id: 'delivery-7',
  }]) } };
});
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ profile: { id: 'office', role: 'admin' } }) }));
vi.mock('../components/ui/Toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('../lib/sentry', () => ({ Sentry: { captureException: vi.fn() } }));
vi.mock('../lib/activityLogger', () => ({ withSenderNames: async <T,>(rows: T) => rows }));
vi.mock('../hooks/useRealtimeSubscription', () => ({ useRealtimeNotifications: () => undefined }));

import Notifications from './Notifications';
import NotificationsPanel from '../components/team/NotificationsPanel';

afterEach(cleanup);
describe('driver report in office notification surfaces', () => {
  for (const panel of [false, true]) {
    it(`keeps the full report readable and user text inert in the ${panel ? 'bell' : 'page'}`, async () => {
      H.type = 'delivery_issue_reported';
      H.message = 'Delivery DEL-007 (Order ORD-42)\nReported issue: Other\nDriver explanation: Damage: cap broken <img src=x onerror=alert(1)>\nDelivery lines:\nAtrazine: planned 5; delivered 3; units GL; short 2';
      const view = render(<MemoryRouter><Routes>
        <Route path="/" element={panel ? <NotificationsPanel /> : <Notifications />} />
        <Route path="/deliveries/delivery-7" element={<p>Correct delivery opened</p>} />
      </Routes></MemoryRouter>);
      if (panel) fireEvent.click(await screen.findByTitle('Notifications'));
      const report = await screen.findByText(/Driver explanation: Damage: cap broken/);
      expect(report.textContent).toBe(H.message);
      expect(report).not.toHaveClass('line-clamp-2');
      expect(report).toHaveClass('whitespace-pre-wrap');
      expect(view.container.querySelector('img')).toBeNull();
      fireEvent.click(report);
      expect(await screen.findByText('Correct delivery opened')).toBeInTheDocument();
    });
  }
  it('keeps ordinary notice previews compact', async () => {
    H.type = 'mention';
    H.message = 'Ordinary notification';
    render(<MemoryRouter><Notifications /></MemoryRouter>);
    expect(await screen.findByText(H.message)).toHaveClass('line-clamp-2');
  });
  it('opens a full-page notification with Enter', async () => {
    H.type = 'delivery_issue_reported';
    H.message = 'Driver report';
    render(<MemoryRouter><Routes>
      <Route path="/" element={<Notifications />} />
      <Route path="/deliveries/delivery-7" element={<p>Correct delivery opened</p>} />
    </Routes></MemoryRouter>);
    fireEvent.keyDown(await screen.findByText(H.message), { key: 'Enter' });
    expect(await screen.findByText('Correct delivery opened')).toBeInTheDocument();
  });
  it.each(['Enter', ' '])('does not open a notice when nested Delete receives %s', async (key) => {
    H.type = 'delivery_issue_reported';
    H.message = 'Driver report';
    render(<MemoryRouter><Routes>
      <Route path="/" element={<NotificationsPanel />} />
      <Route path="/deliveries/delivery-7" element={<p>Correct delivery opened</p>} />
    </Routes></MemoryRouter>);
    fireEvent.click(await screen.findByTitle('Notifications'));
    fireEvent.keyDown(await screen.findByTitle('Delete'), { key });
    expect(screen.queryByText('Correct delivery opened')).not.toBeInTheDocument();
  });
});
