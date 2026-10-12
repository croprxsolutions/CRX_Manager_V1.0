import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import FieldApplicationInvoice from '../pages/FieldApplicationInvoice';
import { createdInvoiceIdFromAddress } from '../lib/fieldAppNewInvoiceAddress';

// Discard every field and confirmation when the invoice identity changes,
// including an existing invoice -> new invoice. Keep the page's async load
// ownership checks: a discarded request must not navigate or install state.
//
// /new -> /new?created=<id> keeps the page: it is how the first Save writes the id into the
// address (the page itself checks an id it did not write). Any change AWAY from a created id —
// to plain /new (the New buttons) or to another created id (Back/Forward between two drafts) —
// gets a fresh page, so a Save there can never update the invoice the old page created.
export default function FieldApplicationInvoiceRoute() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const createdId = createdInvoiceIdFromAddress(searchParams);
  const [newPageGeneration, setNewPageGeneration] = useState(0);
  const [previousCreatedId, setPreviousCreatedId] = useState(createdId);
  if (createdId !== previousCreatedId) {
    setPreviousCreatedId(createdId);
    if (previousCreatedId) setNewPageGeneration((n) => n + 1);
  }
  return <FieldApplicationInvoice key={id ?? `new-field-app-invoice-${newPageGeneration}`} />;
}
