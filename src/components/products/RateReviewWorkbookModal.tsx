import { useEffect, useRef, useState, type RefObject } from 'react';
import { Download, Upload } from 'lucide-react';
import Button from '../ui/Button';
import ConfirmModal from '../ui/ConfirmModal';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { sanitizeError } from '../../lib/db';
import { PricingWorkbookFormatError } from '../../lib/productPricingWorkbook';
import { isDefinitiveRpcRejection } from '../../lib/idempotency';
import { clearPendingRetry, loadPendingRetry, markPendingRetryForCheck, savePendingRetry, type PendingRetry } from '../../lib/pendingRetry';
import {
  commitRateReview,
  generateRateReviewWorkbook,
  labelCheckText,
  loadRateReviewWorkbook,
  parseRateReviewWorkbook,
  previewRateReview,
  problemText,
  rateValueText,
  type ParsedRateReview,
} from '../../lib/rateReviewWorkbook';
import type { CommitRateReviewResult, RateReviewResult, RateReviewWorkbook } from '../../types';

const ACTION_WORDS: Record<string, string> = { save: 'save values', approve: 'approve', reopen: 'send back to draft', delete: 'delete' };
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
type PendingRateReview = { actorId: string; upload: ParsedRateReview; preview: RateReviewResult };
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const nullableText = (value: unknown) => value === null || typeof value === 'string';
const rowNumber = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value > 0;
const versionNumber = (value: unknown) => typeof value === 'number' && Number.isInteger(value) && value >= 0;
const isStoredRate = (value: unknown) => {
  if (!isRecord(value)) return false;
  return rowNumber(value.sheetRow) && typeof value.parent_name === 'string' && typeof value.parent_id === 'string'
    && nullableText(value.rate_id) && (value.expected_row_version === null || versionNumber(value.expected_row_version))
    && ['basis', 'source', 'low', 'recommended', 'high', 'unit', 'over_label_reason', 'reason'].every((field) => nullableText(value[field]))
    && typeof value.is_quoting_default === 'boolean'
    && (value.decision === null || value.decision === 'approve' || value.decision === 'reopen' || value.decision === 'delete');
};
const isStoredOutcome = (value: unknown) => {
  if (!isRecord(value)) return false;
  return rowNumber(value.sheetRow) && typeof value.parent_name === 'string' && typeof value.parent_id === 'string'
    && versionNumber(value.expected_outcome_version) && nullableText(value.note)
    && (value.outcome === null || value.outcome === 'approved_default' || value.outcome === 'no_per_acre_default' || value.outcome === 'needs_label_data');
};
const isStoredPreviewRow = (value: unknown, count: number) => {
  if (!isRecord(value)) return false;
  if (typeof value.index !== 'number' || !Number.isInteger(value.index) || value.index < 0 || value.index >= count
      || typeof value.status !== 'string') return false;
  if (['rate_id', 'parent_id', 'name', 'outcome', 'note', 'problem'].some((field) => value[field] !== undefined && !nullableText(value[field]))) return false;
  if (value.actions != null && (!Array.isArray(value.actions) || !value.actions.every((action: unknown) => typeof action === 'string'))) return false;
  if (value.label_check != null) {
    if (!isRecord(value.label_check) || typeof value.label_check.status !== 'string') return false;
    if (value.label_check.status === 'above' && (!Array.isArray(value.label_check.above) || !value.label_check.above.every(isRecord))) return false;
    if (value.label_check.why != null && typeof value.label_check.why !== 'string') return false;
  }
  return true;
};
const isPendingRateReview = (value: unknown): value is PendingRateReview => {
  if (!isRecord(value) || typeof value.actorId !== 'string' || !isRecord(value.upload) || !isRecord(value.preview)) return false;
  const { rates, outcomes, recorded } = value.upload;
  const previewRates = value.preview.rates;
  const previewOutcomes = value.preview.outcomes;
  return Array.isArray(rates) && rates.every(isStoredRate) && Array.isArray(outcomes) && outcomes.every(isStoredOutcome)
    && isRecord(recorded) && Object.values(recorded).every((outcome) => typeof outcome === 'string')
    && Array.isArray(previewRates) && previewRates.every((row) => isStoredPreviewRow(row, rates.length))
    && Array.isArray(previewOutcomes) && previewOutcomes.every((row) => isStoredPreviewRow(row, outcomes.length));
};
const pendingMatchesSentIntent = (name: string, key: string, request: PendingRateReview) => {
  const current = loadPendingRetry(name, isPendingRateReview);
  return current?.key === key && current.request.actorId === request.actorId
    && JSON.stringify(current.request) === JSON.stringify(request);
};
const clearPendingIfMatching = (name: string, key: string, request: PendingRateReview) => {
  if (pendingMatchesSentIntent(name, key, request)) clearPendingRetry(name);
};
const markPendingIfMatching = (name: string, key: string, request: PendingRateReview, needsCheck: boolean) => {
  if (needsCheck && pendingMatchesSentIntent(name, key, request)) markPendingRetryForCheck(name);
};
const retryProblem = (pending: PendingRetry<PendingRateReview> | null, kept: PendingRetry<PendingRateReview> | null,
  actorId: string, upload: ParsedRateReview): string | null => {
  if (pending && !kept) return 'The earlier retry record is unavailable. No new request was sent. Check a fresh workbook, then clear this reminder.';
  if (kept && (kept.request.actorId !== actorId || JSON.stringify(kept.request.upload) !== JSON.stringify(upload))) {
    return 'An earlier rate review is still unresolved. Finish or check it before another upload.';
  }
  if (kept?.expired) return 'This retry is past its safe window. Check a fresh download before starting another review.';
  return null;
};
const isRateReviewRefusal = (error: unknown) => {
  const raw = String((error as { message?: unknown } | null)?.message ?? '');
  return !raw.startsWith('IDEMPOTENCY_') && (isDefinitiveRpcRejection(error)
    || /^(RATE_REVIEW_|PRODUCT_RATE|ADMIN_REQUIRED|AUTH_REQUIRED)/.test(raw));
};

/** What a preview shows: changes, problems, and whether Confirm may run. */
function previewRows(upload: ParsedRateReview, preview: RateReviewResult) {
  const rates = preview.rates.map((r) => ({ ...r, kind: 'rate' as const, sheetRow: upload.rates[r.index]?.sheetRow, label: r.name ?? upload.rates[r.index]?.parent_name, isNew: upload.rates[r.index]?.rate_id == null }));
  const outcomes = preview.outcomes.map((o) => ({ ...o, kind: 'outcome' as const, sheetRow: upload.outcomes[o.index]?.sheetRow, label: o.name ?? upload.outcomes[o.index]?.parent_name }));
  const all = [...rates, ...outcomes];
  const changes = all.filter((r) => r.status === 'change');
  const problems = all.filter((r) => r.status !== 'change' && r.status !== 'unchanged');
  // The database clears a parent's recorded outcome when any of its rates change; say so unless this file sets it again.
  const outcomeSet = new Set(outcomes.filter((o) => o.status === 'change').map((o) => o.parent_id));
  const cleared = new Map<string, string>();
  for (const r of rates) {
    const parentId = upload.rates[r.index]?.parent_id;
    const was = parentId ? upload.recorded[parentId] : undefined;
    if (r.status === 'change' && parentId && was && !outcomeSet.has(parentId)) cleared.set(parentId, `${r.label ?? parentId} (${was.replace(/_/g, ' ')})`);
  }
  return { rates, outcomes, changes, problems, cleared: [...cleared.values()], blocked: problems.length > 0 || changes.length === 0 };
}

type Shown = ReturnType<typeof previewRows>;

/** Problems, the changes Confirm will save (with each rate's values), and outcomes the save will clear. */
function PreviewDetail({ shown, upload }: { shown: Shown; upload: ParsedRateReview }) {
  return (
    <>
      {shown.problems.length > 0 && (
        <div className="space-y-1">
          {shown.problems.map((p) => (
            <p key={`${p.kind}-${p.index}`} className="text-red-700">
              {p.kind === 'rate' ? 'Draft Rates' : 'Rate Outcomes'} row {p.sheetRow ?? '?'} ({p.label ?? 'unknown parent'}): {problemText(p.problem) || p.status}
            </p>
          ))}
          <p className="text-red-700">
            Nothing will save until these are fixed. Fix them in the file and upload it again; for a row changed by someone else, download a fresh workbook.
          </p>
        </div>
      )}
      {shown.changes.length > 0 && (
        <div className="max-h-72 overflow-auto">
          <table className="w-full text-left" aria-label="Rate review changes">
            <thead><tr className="text-secondary"><th className="font-medium">Row</th><th className="font-medium">Parent</th>
              <th className="font-medium">Change</th><th className="font-medium">Rate saved</th><th className="font-medium">Label check</th></tr></thead>
            <tbody>
              {shown.rates.filter((r) => r.status === 'change').map((r) => (
                <tr key={`rate-${r.index}`}>
                  <td>Draft Rates {r.sheetRow}</td><td>{r.label}</td>
                  <td>{(r.actions ?? []).map((a) => (r.isNew && a === 'save' ? 'add' : ACTION_WORDS[a] ?? a)).join(', ')}</td>
                  <td>{rateValueText(upload.rates[r.index])}</td>
                  <td className={r.label_check?.status === 'above' || r.label_check?.status === 'not_checked' ? 'text-amber-800' : ''}>{labelCheckText(r.label_check)}</td>
                </tr>
              ))}
              {shown.outcomes.filter((o) => o.status === 'change').map((o) => (
                <tr key={`outcome-${o.index}`}>
                  <td>Rate Outcomes {o.sheetRow}</td><td>{o.label}</td>
                  <td>{o.outcome ? `outcome: ${o.outcome.replace(/_/g, ' ')}` : 'outcome cleared (undecided)'}{o.note ? ` · "${o.note}"` : ''}</td><td /><td />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {shown.cleared.length > 0 && (
        <p className="text-amber-800">
          These rate changes clear the recorded outcome of {shown.cleared.join(', ')}. To keep an outcome that still fits the edited rates, mark Reconfirm yes on Rate Outcomes in this workbook and upload again. Otherwise set it later after the rates are approved.
        </p>
      )}
    </>
  );
}

function ReviewPreview({ upload, preview, saved, pending, busy, profileId, onPreview, onConfirm, onClear }: {
  upload: ParsedRateReview;
  preview: RateReviewResult | null;
  saved: CommitRateReviewResult | null;
  pending: PendingRetry<PendingRateReview> | null;
  busy: boolean;
  profileId: string;
  onPreview: () => void;
  onConfirm: () => void;
  onClear: () => void;
}) {
  const shown = preview ? previewRows(upload, preview) : null;
  return (
    <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Rate review preview">
      <h3 className="font-semibold text-nav-dark">
        Preview: {count(upload.rates.length, 'edited rate', 'edited rates')}, {count(upload.outcomes.length, 'edited outcome', 'edited outcomes')}
      </h3>
      {!preview && !saved && <Button variant="secondary" onClick={onPreview} loading={busy}>Preview again</Button>}
      {pending && !saved && (
        <p className="text-amber-800">Your earlier Confirm got no reply. This preview may no longer describe the current database. {pending.needsCheck ? 'The saved retry cannot be used safely. Download a fresh workbook and check these rows before clearing this reminder.' : pending.expired ? 'The retry window has passed. Download a fresh workbook and check these rows before clearing this reminder.' : `This preview is from ${new Date(pending.sentAt).toLocaleString()}. Confirm again to request the original result with the same key.`}</p>
      )}
      {shown && <PreviewDetail shown={shown} upload={upload} />}
      {shown && shown.changes.length === 0 && shown.problems.length === 0 && (
        <p className="text-secondary">Everything in this file already matches the database. Nothing to save.</p>
      )}
      {saved
        ? <p className="text-green-700">Saved {count(saved.rates_changed, 'rate', 'rates')} and {count(saved.outcomes_changed, 'outcome', 'outcomes')}. Download a fresh workbook to continue.</p>
        : shown && <Button onClick={onConfirm} loading={busy} disabled={shown.blocked || !!pending?.expired || !profileId}>
          Confirm rate review ({count(shown.changes.length, 'change', 'changes')})
        </Button>}
      {pending?.expired && <Button variant="secondary" onClick={onClear}>I checked the fresh workbook</Button>}
    </section>
  );
}

function Totals({ totals }: { totals: RateReviewWorkbook['totals'] }) {
  return (
    <p className="text-secondary" aria-label="Rate review totals">
      {count(totals.rates, 'rate', 'rates')}: {totals.drafts} draft, {totals.approved} approved
      ({totals.per_100_gal_approved} of {totals.per_100_gal} per-100-gal approved). {count(totals.parents, 'parent', 'parents')}:{' '}
      {totals.parents_undecided} undecided, {totals.approved_default} approved default, {totals.no_per_acre_default} no per-acre default,{' '}
      {totals.needs_label_data} need label data.
      {totals.outcomes_no_longer_valid > 0 && <span className="text-red-700"> {count(totals.outcomes_no_longer_valid, 'recorded outcome no longer holds', 'recorded outcomes no longer hold')}.</span>}
    </p>
  );
}

function RateWorkbookFileControls({ fileRef, busy, blocked, onDownload, onFile }: {
  fileRef: RefObject<HTMLInputElement | null>; busy: boolean; blocked: boolean; onDownload: () => void; onFile: (file: File) => void;
}) {
  return <>
    <p className="text-secondary">
      Review the draft per-acre rates. In the spreadsheet, approve, correct, add, delete or reopen rates on Draft Rates and set
      one outcome per parent on Rate Outcomes, then upload it here. You see every change before anything is saved, and the
      whole review saves at once or not at all. Quotes and jobs do not use these rates yet.
    </p>
    <div className="flex flex-wrap gap-2">
      <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={onDownload} loading={busy}>
        Download rate review workbook
      </Button>
      <Button variant="secondary" icon={<Upload className="w-4 h-4" />} onClick={() => fileRef.current?.click()} disabled={blocked}>
        Upload and preview
      </Button>
      <input ref={fileRef} type="file" className="hidden" aria-label="Rate review workbook file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); }} />
    </div>
  </>;
}

function WorkbookFileProblems({ error }: { error: string }) {
  const [page, setPage] = useState(0);
  const problems = error.split('\n');
  const start = page * 50;
  return <section aria-label="Workbook file problems" className="space-y-2 text-red-700">
    <p role="alert">Nothing was saved. Fix these problems in the file and upload it again.</p>
    <p aria-live="polite" className="max-h-72 overflow-auto whitespace-pre-line">{problems.slice(start, start + 50).join('\n')}</p>
    {problems.length > 50 && <div className="flex flex-wrap items-center gap-2">
      <span>Problems {start + 1}–{Math.min(start + 50, problems.length)} of {problems.length}</span>
      <Button variant="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous problems</Button>
      <Button variant="secondary" disabled={start + 50 >= problems.length} onClick={() => setPage(page + 1)}>Next problems</Button>
    </div>}
  </section>;
}

/** RT-3 rate review: upload for a preview, then explicitly confirm the whole review in one atomic save. */
export default function RateReviewWorkbookModal({ open, profileId, onClose }: {
  open: boolean;
  profileId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [totals, setTotals] = useState<RateReviewWorkbook['totals'] | null>(null);
  const [upload, setUpload] = useState<ParsedRateReview | null>(null);
  const [preview, setPreview] = useState<RateReviewResult | null>(null);
  const [saved, setSaved] = useState<CommitRateReviewResult | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [actorId, setActorId] = useState(profileId);
  const [pending, setPending] = useState<PendingRetry<PendingRateReview> | null>(null);
  const [clearingPending, setClearingPending] = useState(false);
  const pendingName = `rate-review:${profileId}`;
  // A request started for one actor/opening must never paint its result onto a later actor/opening.
  const view = useRef({ profileId, open, epoch: 0 });
  if (view.current.profileId !== profileId || view.current.open !== open) {
    view.current = { profileId, open, epoch: view.current.epoch + 1 };
  }
  const isCurrent = (epoch: number) => view.current.epoch === epoch && view.current.open;
  const updateCurrent = (epoch: number, update: () => void) => { if (isCurrent(epoch)) update(); };
  // Scoped to the exact upload: a retry of the same file reuses its key (the server returns the first receipt).
  const commitKey = useIdempotencyKey('commit_rate_review', profileId, JSON.stringify(upload));

  // shortcut: sessionStorage survives navigation/reload in this tab, but closing the tab ends recovery; use a server receipt lookup if recovery must cross tabs.
  useEffect(() => {
    if (!open) return;
    const kept = profileId ? loadPendingRetry(pendingName, isPendingRateReview) : null;
    setActorId(profileId);
    setPending(kept?.request.actorId === profileId ? kept : null);
    setUpload(kept?.request.actorId === profileId ? kept.request.upload : null);
    setPreview(kept?.request.actorId === profileId ? kept.request.preview : null);
    setSaved(null);
    setFileError(null);
    setBusy(false);
    setClearingPending(false);
  }, [open, pendingName, profileId]);
  useEffect(() => () => { view.current.epoch += 1; }, []);

  const reset = () => { setUpload(null); setPreview(null); setSaved(null); setFileError(null); };
  const close = () => { reset(); setTotals(null); onClose(); };

  const download = async () => {
    const epoch = view.current.epoch;
    setBusy(true);
    try {
      const exported = await loadRateReviewWorkbook();
      if (!isCurrent(epoch)) return;
      setTotals(exported.totals);
      const blob = await generateRateReviewWorkbook(exported);
      if (!isCurrent(epoch)) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `crx-rate-review-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      if (isCurrent(epoch)) toast('error', sanitizeError(error));
    } finally {
      if (isCurrent(epoch)) setBusy(false);
    }
  };

  const runPreview = async (parsed: ParsedRateReview, epoch: number) => {
    if (isCurrent(epoch)) setPreview(null);
    const result = await previewRateReview(parsed);
    if (isCurrent(epoch)) setPreview(result);
  };

  const readFile = async (file: File) => {
    const epoch = view.current.epoch;
    // The File object is already captured; allow choosing this same file again after navigation or a profile change.
    if (fileRef.current) fileRef.current.value = '';
    if (!profileId || pending || loadPendingRetry(pendingName, isPendingRateReview)) {
      toast('error', !profileId ? 'Wait for your profile to load before uploading.' : 'Finish or check the earlier unanswered rate review before uploading another file.');
      return;
    }
    reset();
    setTotals(null); // they described the last download, not necessarily this file
    setBusy(true);
    try {
      const parsed = await parseRateReviewWorkbook(await file.arrayBuffer());
      if (!isCurrent(epoch)) return;
      setUpload(parsed);
      if (parsed.rates.length + parsed.outcomes.length > 0) await runPreview(parsed, epoch);
    } catch (error) {
      if (isCurrent(epoch)) {
        if (error instanceof PricingWorkbookFormatError) setFileError(error.message);
        else toast('error', sanitizeError(error));
      }
    } finally {
      if (isCurrent(epoch)) setBusy(false);
    }
  };

  const retryPreview = async () => {
    if (!upload) return;
    const epoch = view.current.epoch;
    setBusy(true);
    try {
      await runPreview(upload, epoch);
    } catch (error) {
      if (isCurrent(epoch)) toast('error', sanitizeError(error));
    } finally {
      if (isCurrent(epoch)) setBusy(false);
    }
  };

  const handleRetryProblem = (problem: string, kept: PendingRetry<PendingRateReview> | null, original = pending) => {
    if (original && !kept) {
      // An older mounted instance may have settled and removed storage. Absence alone cannot prove the result here.
      // Keep the exact old key and request for a hand check, including across another navigation when storage works.
      if (savePendingRetry(pendingName, original.key, original.request)) markPendingRetryForCheck(pendingName);
      setPending({ ...original, expired: true, needsCheck: true });
    } else setPending(kept?.request.actorId === profileId ? kept : original);
    toast('error', problem);
  };

  const confirm = async () => {
    if (!upload || !preview || !profileId) return;
    const epoch = view.current.epoch;
    const kept = loadPendingRetry(pendingName, isPendingRateReview);
    const problem = retryProblem(pending, kept, profileId, upload);
    if (problem) {
      handleRetryProblem(problem, kept);
      return;
    }
    const key = kept?.key ?? commitKey.getKey();
    const request = kept?.request ?? { actorId: profileId, upload, preview };
    if (!savePendingRetry(pendingName, key, request)) {
      toast('error', 'This browser could not keep the retry record, so nothing was sent. Allow site storage or review a smaller file.');
      return;
    }
    const sent = loadPendingRetry(pendingName, isPendingRateReview);
    if (!sent || sent.key !== key || JSON.stringify(sent.request) !== JSON.stringify(request)) {
      toast('error', 'This browser could not read back the retry record, so nothing was sent. Download a fresh workbook and try again.');
      return;
    }
    setPending(sent);
    setBusy(true);
    try {
      const receipt = await commitRateReview(request.upload, key);
      commitKey.resetKey();
      clearPendingIfMatching(pendingName, key, request);
      updateCurrent(epoch, () => {
        setPending(null);
        setSaved(receipt);
        setTotals(null); // stale now; the success line asks for a fresh download
        toast('success', `Saved ${count(receipt.rates_changed, 'rate', 'rates')} and ${count(receipt.outcomes_changed, 'outcome', 'outcomes')}`);
      });
    } catch (error) {
      updateCurrent(epoch, () => toast('error', sanitizeError(error)));
      const raw = String((error as { message?: unknown } | null)?.message ?? '');
      // A refusal after any earlier unanswered send cannot prove the earlier send failed; keep its original receipt key.
      if (!kept && isRateReviewRefusal(error)) {
        clearPendingIfMatching(pendingName, key, request);
        commitKey.resetKey();
        updateCurrent(epoch, () => {
          setPending(null);
          setPreview(null);
        });
      } else {
        markPendingIfMatching(pendingName, key, request,
          raw.startsWith('IDEMPOTENCY_') || !!(kept && isRateReviewRefusal(error)));
        updateCurrent(epoch, () => {
          const remaining = loadPendingRetry(pendingName, isPendingRateReview);
          if (!remaining) handleRetryProblem('The earlier retry record is unavailable. Check a fresh workbook, then clear this reminder.', remaining, sent);
          else setPending(remaining);
        });
      }
    } finally {
      updateCurrent(epoch, () => setBusy(false));
    }
  };

  const clearCheckedPending = () => {
    clearPendingRetry(pendingName);
    setPending(null);
    setClearingPending(false);
    commitKey.resetKey();
    reset();
  };

  const nothingEdited = upload && upload.rates.length + upload.outcomes.length === 0;

  if (actorId !== profileId) return <Modal open={open} onClose={onClose} title="Rate review">Loading rate review…</Modal>;

  return (
    <Modal open={open} onClose={close} closeDisabled={busy} title="Rate review" size="large"
      footer={<Button variant="secondary" onClick={close} disabled={busy}>Close</Button>}>
      <div className="space-y-4 text-sm">
        <RateWorkbookFileControls fileRef={fileRef} busy={busy} blocked={busy || !!pending || !profileId}
          onDownload={() => void download()} onFile={(file) => void readFile(file)} />
        {totals && <Totals totals={totals} />}

        {fileError && <WorkbookFileProblems key={fileError} error={fileError} />}

        {nothingEdited && <p className="text-secondary">No edits in this file. Change a rate, decision or outcome, then upload it again.</p>}

        {upload && !nothingEdited && <ReviewPreview upload={upload} preview={preview} saved={saved} pending={pending}
          busy={busy} profileId={profileId} onPreview={() => void retryPreview()} onConfirm={() => void confirm()}
          onClear={() => setClearingPending(true)} />}
      </div>
      <ConfirmModal open={clearingPending} onClose={() => setClearingPending(false)} onConfirm={clearCheckedPending}
        title="Clear unanswered rate review?" message="Only clear this reminder after comparing its rows with a fresh workbook. The old receipt can no longer be recovered here."
        confirmLabel="I checked; clear reminder" variant="warning" />
    </Modal>
  );
}
