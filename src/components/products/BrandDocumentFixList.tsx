import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useLoad } from '../../hooks/useLoad';
import { BRAND_DOCUMENT_TITLES, readBrandDocumentWorkspace } from '../../lib/brandDocuments';
import Button from '../ui/Button';
import Modal from '../ui/Modal';

export default function BrandDocumentFixList() {
  const [open, setOpen] = useState(false);
  const list = useLoad(open ? 'reported-brand-documents' : null, () => readBrandDocumentWorkspace(true));
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>Reported links</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Reported manufacturer links">
        {list.status === 'failed' || (list.status === 'loaded' && list.stale) ? (
          <div className="space-y-2" role="alert">
            <p>The reported links could not be loaded.</p>
            <Button variant="secondary" onClick={() => void list.reload()}>Try again</Button>
          </div>
        ) : list.status !== 'loaded' ? (
          <p role="status" className="text-secondary">Loading reported links…</p>
        ) : list.data.length === 0 ? (
          <p className="text-secondary">No broken links reported.</p>
        ) : (
          <ul className="divide-y divide-gray-200">
            {list.data.map((brand) => (
              <li key={brand.id} className="space-y-1 py-3">
                <Link to={`/products/${brand.product_id}`} className="font-medium text-nav-dark underline">
                  {brand.brand_name} · {brand.owner_name}
                </Link>
                <ul className="space-y-1 text-sm text-secondary">
                  {brand.links.map((link) => (
                    <li key={link.id} className="break-all">
                      {BRAND_DOCUMENT_TITLES[link.document_kind]} {link.state_code} · {link.url}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </Modal>
    </>
  );
}
