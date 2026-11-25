import { useLayoutEffect, useRef, useState } from 'react';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { useLoad } from '../../hooks/useLoad';
import {
  BRAND_DOCUMENT_TITLES, changeBrandDocumentLinks, isBrandDocumentConflict, previewBrandDocumentLinks, readBrandDocumentWorkspace,
  type BrandDocumentWorkspaceRow,
} from '../../lib/brandDocuments';
import { sanitizeError } from '../../lib/errorSanitizer';
import type { BrandDocumentImport, ParsedBrandDocuments } from '../../lib/productSetupBrandDocumentsWorkbook';
import Button from '../ui/Button';

async function previewRow(row: BrandDocumentImport, brand: BrandDocumentWorkspaceRow | undefined): Promise<string> {
  const changed = row.brandName + ' changed. Download a fresh workbook.';
  if (!brand || brand.owner_name !== row.ownerName || brand.brand_name !== row.brandName) return changed;
  try {
    await previewBrandDocumentLinks(row.target, row.changes);
    return '';
  } catch (err) {
    if (typeof err !== 'object' || err === null || !('message' in err)) throw err;
    const message = String(err.message);
    if (isBrandDocumentConflict(err)) return changed;
    if (message.startsWith('BRAND_DOCUMENT_')) return row.brandName + ' · ' + sanitizeError(err);
    throw err;
  }
}

async function previewRows(rows: BrandDocumentImport[], isCurrent: () => boolean): Promise<string[]> {
  const workspace = await readBrandDocumentWorkspace(false);
  const current = new Map(workspace.map((entry) => [JSON.stringify([entry.parent_brand, entry.id]), entry]));
  const issues: string[] = [];
  for (let start = 0; start < rows.length && isCurrent(); start += 8) {
    const batch = await Promise.all(rows.slice(start, start + 8).map((row) =>
      previewRow(row, current.get(JSON.stringify([row.target.parent_brand, row.target.id])))));
    issues.push(...batch.filter(Boolean));
  }
  return issues;
}

function PreviewStatus({ preview, disabled }: { preview: ReturnType<typeof useLoad<string[]>>; disabled: boolean }) {
  if (preview.status === 'loading') return <p role="status">Checking brand links…</p>;
  if (preview.status === 'failed' || (preview.status === 'loaded' && preview.stale)) {
    return <Button variant="secondary" disabled={disabled} onClick={() => void preview.reload()}>Retry link preview</Button>;
  }
  return null;
}

export default function BrandDocumentWorkbookPanel({ parsed, profileId, parentBusy, onBusyChange }: {
  parsed: ParsedBrandDocuments; profileId: string; parentBusy: boolean; onBusyChange: (busy: boolean) => void;
}) {
  const [remaining, setRemaining] = useState(parsed.rows);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(0);
  const [saveError, setSaveError] = useState<{ message: string; stale: boolean } | null>(null);
  const active = useRef(false);
  const saveLock = useRef(false);
  const { getKeyFor, resetKeyFor } = useIdempotencyKey('change_brand_document_links', profileId);
  const preview = useLoad(parsed.rows.length > 0 && parsed.issues.length === 0 ? profileId : null,
    (isCurrent) => previewRows(remaining, isCurrent));
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  const issues = [...parsed.issues, ...(preview.status === 'loaded' ? preview.data : [])];
  const canSave = preview.status === 'loaded' && !preview.stale && !preview.refreshing && issues.length === 0 && !saveError?.stale;

  async function save() {
    if (saveLock.current || !canSave) return;
    saveLock.current = true;
    setSaving(true);
    onBusyChange(true);
    setSaveError(null);
    try {
      for (const row of remaining) {
        if (!active.current) return;
        const intent = JSON.stringify([row.target, row.changes]);
        try {
          await changeBrandDocumentLinks(row.target, row.changes, getKeyFor(intent));
        } catch (err) {
          if (active.current) {
            const stale = isBrandDocumentConflict(err);
            const message = stale ? row.brandName + ' changed. Download a fresh workbook'
              : row.brandName + ' · ' + sanitizeError(err);
            setSaveError({ message, stale });
          }
          return;
        }
        if (!active.current) return;
        resetKeyFor(intent);
        setSaved((count) => count + 1);
        setRemaining((rows) => rows.slice(1));
      }
    } finally {
      saveLock.current = false;
      if (active.current) {
        setSaving(false);
        onBusyChange(false);
      }
    }
  }

  return (
    <section className="space-y-2 rounded-lg border border-gray-200 p-3">
      <h3 className="font-semibold text-nav-dark">Brand links</h3>
      {saved > 0 && <p role="status">Saved links for {saved} {saved === 1 ? 'brand' : 'brands'}.</p>}
      {remaining.length === 0 && saved === 0 && !issues.length && <p className="text-secondary">No link changes.</p>}
      {remaining.length > 0 && (
        <ul className="max-h-48 space-y-1 overflow-auto">
          {remaining.map((row) => (
            <li key={JSON.stringify([row.target.parent_brand, row.target.id])} className="text-sm">
              {row.brandName} · {row.ownerName}
              <ul className="pl-4 text-secondary">
                {row.changes.map((change, index) => change.action === 'save' && (
                  <li key={index} className="break-all">{BRAND_DOCUMENT_TITLES[change.kind]} · {change.url}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {issues.length > 0 && <ul className="text-red-700" role="alert">{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
      {saveError && <p role="alert" className="text-red-700">{saveError.message}. Earlier confirmed brands remain saved.</p>}
      <PreviewStatus preview={preview} disabled={parentBusy} />
      {remaining.length > 0 && (
        <Button disabled={parentBusy || !canSave} loading={saving}
          onClick={() => void save()}>Save brand links</Button>
      )}
    </section>
  );
}
