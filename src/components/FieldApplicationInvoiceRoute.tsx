import { useState } from 'react';
import { useNavigationType, useParams, useSearchParams } from 'react-router-dom';
import FieldApplicationInvoice from '../pages/FieldApplicationInvoice';
import { createdInvoiceIdFromAddress } from '../lib/fieldAppNewInvoiceAddress';

// Discard every field and confirmation when the invoice identity changes,
// including an existing invoice -> new invoice. Keep the page's async load
// ownership checks: a discarded request must not navigate or install state.
//
// The created-invoice id in /new?created=<id> (see fieldAppNewInvoiceAddress): the page's own
// address rewrites are REPLACE moves (the first Save writing the id, dropping a rejected id) and
// keep the page, typed values and all. A move away from a created id that the page did not make
// itself — the New buttons (PUSH) or Back/Forward between drafts (POP) — gets a fresh page, so a
// Save there can never update the invoice the old page created.
export default function FieldApplicationInvoiceRoute() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigationType = useNavigationType();
  const createdId = createdInvoiceIdFromAddress(searchParams);
  const [newPageGeneration, setNewPageGeneration] = useState(0);
  const [previousCreatedId, setPreviousCreatedId] = useState(createdId);
  if (createdId !== previousCreatedId) {
    setPreviousCreatedId(createdId);
    if (previousCreatedId && navigationType !== 'REPLACE') setNewPageGeneration((n) => n + 1);
  }
  return <FieldApplicationInvoice key={id ?? `new-field-app-invoice-${newPageGeneration}`} />;
}
