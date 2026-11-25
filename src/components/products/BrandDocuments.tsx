import { useId, useRef, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useLoad } from '../../hooks/useLoad';
import {
  BRAND_DOCUMENT_TITLES, changeBrandDocumentLinks, checkedDocumentUrl, readBrandDocumentHistory,
  type BrandDocumentChange, type BrandDocumentTarget,
} from '../../lib/brandDocuments';
import { BUSINESS_TIMEZONE, todayInBusinessTz } from '../../lib/dateUtils';
import { sanitizeError } from '../../lib/errorSanitizer';
import type { BrandDocumentKind, BrandDocumentLink } from '../../types';
import Button from '../ui/Button';
import Input from '../ui/Input';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';

const kinds: BrandDocumentKind[] = ['specimen', 'sds', 'supplemental'];

function title(link: BrandDocumentLink): string {
  return [BRAND_DOCUMENT_TITLES[link.document_kind], link.state_code].filter(Boolean).join(' · ');
}

function safeHref(url: string): string | null {
  try {
    return checkedDocumentUrl(url);
  } catch {
    return null;
  }
}

type DocumentEdit =
  | { action: 'save'; kind: BrandDocumentKind; link?: BrandDocumentLink }
  | { action: 'hide' | 'dismiss'; link: BrandDocumentLink };

function DocumentEditForm({ edit, busy, onCancel, onSubmit }: {
  edit: DocumentEdit; busy: boolean; onCancel: () => void;
  onSubmit: (change: BrandDocumentChange) => Promise<void>;
}) {
  const id = useId();
  const [url, setUrl] = useState(edit.link?.url ?? '');
  const [state, setState] = useState(edit.link?.state_code ?? '');
  const [expiry, setExpiry] = useState(edit.link?.expires_on ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      if (edit.action === 'save') {
        if (edit.kind === 'supplemental' && (!/^[a-z]{2}$/i.test(state.trim()) || !expiry)) {
          setError('Enter a two-letter state code and an expiration date.');
          return;
        }
        await onSubmit({
          action: 'save', kind: edit.kind, url: checkedDocumentUrl(url),
          ...(edit.link ? { id: edit.link.id, version: edit.link.row_version } : {}),
          ...(edit.kind === 'supplemental' ? { state: state.trim().toUpperCase(), expires_on: expiry } : {}),
        });
        return;
      }
      if (!reason.trim()) {
        setError('Enter a reason.');
        return;
      }
      await onSubmit({ action: edit.action, id: edit.link.id, version: edit.link.row_version, reason: reason.trim() });
    } catch (err) {
      setError(sanitizeError(err));
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3" noValidate>
      {edit.action === 'save' ? (
        <>
          <Input id={id + '-url'} label={BRAND_DOCUMENT_TITLES[edit.kind] + ' link'} type="url"
            value={url} maxLength={2048} onChange={(event) => setUrl(event.target.value)} disabled={busy} />
          {edit.kind === 'supplemental' && (
            <div className="grid grid-cols-2 gap-3">
              <Input id={id + '-state'} label="State code" maxLength={2} value={state}
                onChange={(event) => setState(event.target.value)} disabled={busy} />
              <Input id={id + '-expires'} label="Expiration date" type="date" value={expiry}
                onChange={(event) => setExpiry(event.target.value)} disabled={busy} />
            </div>
          )}
        </>
      ) : (
        <Input id={id + '-reason'} label={edit.action === 'hide' ? 'Why hide this link?' : 'Why close this report?'}
          value={reason} maxLength={1000} onChange={(event) => setReason(event.target.value)} disabled={busy} />
      )}
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={busy}>Back</Button>
        <Button type="submit" loading={busy}>
          {edit.action === 'save' ? 'Save link' : edit.action === 'hide' ? 'Hide link' : 'Close report'}
        </Button>
      </div>
    </form>
  );
}

interface BrandDocumentsProps {
  target: BrandDocumentTarget;
  brandName: string;
  links: BrandDocumentLink[];
  canEdit: boolean;
  userId: string;
  onReload: (includeBrand?: boolean) => void;
}

export default function BrandDocuments({ target, brandName, links, canEdit, userId, onReload }: BrandDocumentsProps) {
  const { toast } = useToast();
  const [manageOpen, setManageOpen] = useState(false);
  const [edit, setEdit] = useState<DocumentEdit | null>(null);
  const [busy, setBusy] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyPage, setHistoryPage] = useState(0);
  const locked = useRef(false);
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('change_brand_document_links', userId);
  const history = useLoad(canEdit && manageOpen && historyOpen ? JSON.stringify([userId, target.id, historyPage]) : null,
    () => readBrandDocumentHistory(target, historyPage),
    { refreshToken: links.map((link) => link.id + ':' + link.row_version).join(',') });

  async function apply(change: BrandDocumentChange) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    const intent = JSON.stringify([target, change]);
    try {
      await changeBrandDocumentLinks(target, [change], getKeyFor(intent));
      resetKeyFor(intent);
      setEdit(null);
      toast('success', change.action === 'report' ? 'Broken link reported' : 'Document links updated');
      onReload();
    } catch (error) {
      if (error && typeof error === 'object' && 'message' in error
          && /^BRAND_(?:DOCUMENT_)?CHANGED:/.test(String(error.message))) onReload(true);
      throw error;
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  const close = () => {
    setManageOpen(false);
    setEdit(null);
    setHistoryOpen(false);
    setHistoryPage(0);
  };
  const today = todayInBusinessTz();

  return (
    <div className="min-w-44 space-y-1">
      {links.map((link) => {
        const expired = link.expires_on !== null && link.expires_on < today;
        const href = expired ? null : safeHref(link.url);
        return (
          <div key={link.id} className="flex flex-wrap items-center gap-x-2">
            {href ? (
              <a href={href} target="_blank" rel="noopener noreferrer"
                className="inline-flex min-h-11 items-center gap-1 text-primary-700 underline md:min-h-6">
                {title(link)}<ExternalLink size={13} aria-hidden="true" />
              </a>
            ) : (
              <span className="text-secondary">{title(link)}{expired ? ' · Expired' : ' · Link unavailable'}</span>
            )}
            {link.expires_on && <time className="text-xs text-secondary" dateTime={link.expires_on}>{link.expires_on}</time>}
            {link.reported_at ? <span className="text-xs text-amber-800">Reported</span> : href && userId && (
              <Button type="button" variant="ghost" size="sm" disabled={busy} showChevron={false}
                aria-label={'Report broken link for ' + brandName + ' ' + title(link)}
                onClick={() => void apply({ action: 'report', id: link.id, version: link.row_version })
                  .catch((err: unknown) => toast('error', sanitizeError(err)))}>
                Report broken link
              </Button>
            )}
          </div>
        );
      })}
      {links.length === 0 && <span className="text-secondary">No manufacturer links</span>}
      {canEdit && (
        <div>
          <Button type="button" variant="ghost" size="sm" onClick={() => setManageOpen(true)} showChevron={false}
            aria-label={'Manage documents for ' + brandName}>Manage links</Button>
        </div>
      )}
      {canEdit && manageOpen && (
        <Modal open onClose={close} closeDisabled={busy} title={brandName + ' documents'}>
          {edit ? (
            <DocumentEditForm edit={edit} busy={busy} onCancel={() => setEdit(null)} onSubmit={apply} />
          ) : (
            <div className="space-y-3">
              {links.map((link) => (
                <div key={link.id} className="space-y-1 border-b border-gray-200 pb-2">
                  <p className="font-medium">{title(link)} {link.reported_at && '· Reported broken'}</p>
                  <p className="break-all text-sm text-secondary">{link.url}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" variant="secondary" onClick={() => setEdit({ action: 'save', kind: link.document_kind, link })}>Edit link</Button>
                    <Button size="sm" variant="secondary" onClick={() => setEdit({ action: 'hide', link })}>Hide link</Button>
                    {link.reported_at && <Button size="sm" variant="secondary" onClick={() => setEdit({ action: 'dismiss', link })}>Close report</Button>}
                  </div>
                </div>
              ))}
              <div className="flex flex-wrap gap-2">
                {kinds.filter((kind) => kind === 'supplemental' || !links.some((link) => link.document_kind === kind)).map((kind) => (
                  <Button key={kind} size="sm" variant="secondary" onClick={() => setEdit({ action: 'save', kind })}>
                    Add {BRAND_DOCUMENT_TITLES[kind]}
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => { setHistoryPage(0); setHistoryOpen(!historyOpen); }}>
                  {historyOpen ? 'Hide history' : 'Show history'}
                </Button>
              </div>
              {historyOpen && <DocumentHistory history={history} page={historyPage} onPage={setHistoryPage} />}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}

function DocumentHistory({ history, page, onPage }: {
  history: ReturnType<typeof useLoad<Awaited<ReturnType<typeof readBrandDocumentHistory>>>>;
  page: number;
  onPage: (page: number) => void;
}) {
  if (history.status === 'failed' || (history.status === 'loaded' && history.stale)) {
    return <Button variant="secondary" size="sm" onClick={() => void history.reload()}>Retry history</Button>;
  }
  if (history.status !== 'loaded') return <p className="text-secondary">Loading history…</p>;
  const { events, names, hasOlder } = history.data;
  if (events.length === 0 && page === 0) return <p className="text-secondary">No document changes yet.</p>;
  return (
    <>
      <ul className="space-y-2 text-sm">
        {events.map((event) => (
          <li key={event.id} className="break-all">
            <span className="capitalize">{event.action}</span> · {names.get(event.changed_by) ?? 'Unknown staff member'} ·{' '}
            <time dateTime={event.created_at}>{new Date(event.created_at).toLocaleString([], {
              timeZone: BUSINESS_TIMEZONE, dateStyle: 'medium', timeStyle: 'short',
            })}</time>
            {event.before_value?.url && event.before_value.url !== event.after_value?.url && <span className="block">{event.before_value.url}</span>}
            {event.after_value?.url && <span className="block">{event.after_value.url}</span>}
            {event.reason && <span className="block">{event.reason}</span>}
          </li>
        ))}
      </ul>
      {(page > 0 || hasOlder) && <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" disabled={page === 0 || history.refreshing} onClick={() => onPage(page - 1)}>Newer changes</Button>
        <Button size="sm" variant="secondary" disabled={!hasOlder || history.refreshing} onClick={() => onPage(page + 1)}>Older changes</Button>
      </div>}
    </>
  );
}
