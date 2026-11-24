import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import NextDraftButton from './NextDraftButton';

function InvoicePage() {
  const { id } = useParams();
  const navigate = useNavigate();
  return (
    <div>
      <h1>Invoice {id}</h1>
      <NextDraftButton currentId={id} />
      <button type="button" onClick={() => navigate(-1)}>Back</button>
    </div>
  );
}

const renderFromList = (state: unknown) => render(
  <MemoryRouter initialEntries={['/invoices', { pathname: '/invoices/a', state }]} initialIndex={1}>
    <Routes>
      <Route path="/invoices" element={<p>Invoice list</p>} />
      <Route path="/invoices/:id" element={<InvoicePage />} />
    </Routes>
  </MemoryRouter>,
);

describe('NextDraftButton', () => {
  it('opens each queued draft in turn and hides after the last one; Back returns to the list', () => {
    renderFromList({ nextDrafts: ['c', 'e'] });
    expect(screen.getByRole('heading')).toHaveTextContent('Invoice a');
    fireEvent.click(screen.getByRole('button', { name: /Next draft/ }));
    expect(screen.getByRole('heading')).toHaveTextContent('Invoice c');
    fireEvent.click(screen.getByRole('button', { name: /Next draft/ }));
    expect(screen.getByRole('heading')).toHaveTextContent('Invoice e');
    expect(screen.queryByRole('button', { name: /Next draft/ })).not.toBeInTheDocument();
    // Each step replaced the page in history, so one Back goes straight back to the list.
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByText('Invoice list')).toBeInTheDocument();
  });

  it('shows how many drafts are left', () => {
    renderFromList({ nextDrafts: ['c', 'e'] });
    expect(screen.getByRole('button', { name: /Next draft/ })).toHaveTextContent('2 left');
  });

  it('shows nothing when the invoice was not opened from the list', () => {
    renderFromList(null);
    expect(screen.queryByRole('button', { name: /Next draft/ })).not.toBeInTheDocument();
  });
});
