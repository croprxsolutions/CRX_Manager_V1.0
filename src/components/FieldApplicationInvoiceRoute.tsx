import { useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import FieldApplicationInvoice from '../pages/FieldApplicationInvoice';
import { createdInvoiceIdFromAddress } from '../lib/fieldAppNewInvoiceAddress';

// Discard every field and confirmation when the invoice identity changes,
// including an existing invoice -> new invoice. Keep the page's async load
// ownership checks: a discarded request must not navigate or install state.
//
// /new -> /new?created=<id> is the SAME draft (the first Save wrote the id into the address)
// and keeps the page. /new?created=<id> -> plain /new (e.g. the New button pressed there) is a
// NEW invoice: it gets a fresh page, so a Save cannot keep updating the invoice already created.
export default function FieldApplicationInvoiceRoute() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const createdId = createdInvoiceIdFromAddress(searchParams);
  const [newPageGeneration, setNewPageGeneration] = useState(0);
  const [previousCreatedId, setPreviousCreatedId] = useState(createdId);
  if (createdId !== previousCreatedId) {
    setPreviousCreatedId(createdId);
    if (previousCreatedId && !createdId) setNewPageGeneration((n) => n + 1);
  }
  return <FieldApplicationInvoice key={id ?? `new-field-app-invoice-${newPageGeneration}`} />;
}
