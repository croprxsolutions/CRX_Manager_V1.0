import { useRef, useState } from 'react';
import { Download, Upload } from 'lucide-react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { sanitizeError } from '../../lib/db';
import {
  commitRateReview,
  generateRateReviewWorkbook,
  labelCheckText,
  loadRateReviewWorkbook,
  parseRateReviewWorkbook,
  previewRateReview,
  problemText,
  type ParsedRateReview,
} from '../../lib/rateReviewWorkbook';
import type { CommitRateReviewResult, RateReviewResult, RateReviewWorkbook } from '../../types';

const ACTION_WORDS: Record<string, string> = { save: 'save values', approve: 'approve', reopen: 'send back to draft', delete: 'delete' };
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a preview shows: changes, problems, and whether Confirm may run. */
function previewRows(upload: ParsedRateReview, preview: RateReviewResult) {
  const rates = preview.rates.map((r) => ({ ...r, kind: 'rate' as const, sheetRow: upload.rates[r.index]?.sheetRow, label: r.name ?? upload.rates[r.index]?.parent_name, isNew: upload.rates[r.index]?.rate_id == null }));
  const outcomes = preview.outcomes.map((o) => ({ ...o, kind: 'outcome' as const, sheetRow: upload.outcomes[o.index]?.sheetRow, label: o.name ?? upload.outcomes[o.index]?.parent_name }));
  const all = [...rates, ...outcomes];
  const changes = all.filter((r) => r.status === 'change');
  const problems = all.filter((r) => r.status !== 'change' && r.status !== 'unchanged');
  return { rates, outcomes, changes, problems, blocked: problems.length > 0 || changes.length === 0 };
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

/**
 * RT-3: Mason's rate review. Download the draft rates, approve / correct / add / delete / reopen them and set one
 * outcome per parent in the spreadsheet, upload it for a preview (nothing is kept), then confirm the whole review
 * in one all-or-nothing save. Separate from the setup workbook; nothing reads these rates until RT-4.
 */
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
  // Scoped to the exact upload: a retry of the same file reuses its key (the server returns the first receipt).
  const commitKey = useIdempotencyKey('commit_rate_review', profileId, JSON.stringify(upload));

  const reset = () => { setUpload(null); setPreview(null); setSaved(null); };
  const close = () => { reset(); setTotals(null); onClose(); };

  const download = async () => {
    setBusy(true);
    try {
      const exported = await loadRateReviewWorkbook();
      setTotals(exported.totals);
      const blob = await generateRateReviewWorkbook(exported);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `crx-rate-review-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async (parsed: ParsedRateReview) => {
    setPreview(null);
    setPreview(await previewRateReview(parsed));
  };

  const readFile = async (file: File) => {
    reset();
    setBusy(true);
    try {
      const parsed = await parseRateReviewWorkbook(await file.arrayBuffer());
      setUpload(parsed);
      if (parsed.rates.length + parsed.outcomes.length > 0) await runPreview(parsed);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const retryPreview = async () => {
    if (!upload) return;
    setBusy(true);
    try {
      await runPreview(upload);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!upload || !preview) return;
    setBusy(true);
    try {
      const receipt = await commitRateReview(upload, commitKey.getKey());
      commitKey.resetKey();
      setSaved(receipt);
      toast('success', `Saved ${count(receipt.rates_changed, 'rate', 'rates')} and ${count(receipt.outcomes_changed, 'outcome', 'outcomes')}`);
    } catch (error) {
      toast('error', sanitizeError(error));
      // A refused save is usually stale: drop the preview so the next try checks the database again.
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const shown = upload && preview ? previewRows(upload, preview) : null;
  const nothingEdited = upload && upload.rates.length + upload.outcomes.length === 0;

  return (
    <Modal open={open} onClose={close} closeDisabled={busy} title="Rate review" size="large"
      footer={<Button variant="secondary" onClick={close} disabled={busy}>Close</Button>}>
      <div className="space-y-4 text-sm">
        <p className="text-secondary">
          Review the draft per-acre rates. In the spreadsheet, approve, correct, add, delete or reopen rates on Draft Rates and set
          one outcome per parent on Rate Outcomes, then upload it here. You see every change before anything is saved, and the
          whole review saves at once or not at all. Quotes and jobs do not use these rates yet.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" icon={<Download className="w-4 h-4" />} onClick={() => void download()} loading={busy}>
            Download rate review workbook
          </Button>
          <Button variant="secondary" icon={<Upload className="w-4 h-4" />} onClick={() => fileRef.current?.click()} disabled={busy}>
            Upload and preview
          </Button>
          <input ref={fileRef} type="file" className="hidden" aria-label="Rate review workbook file"
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} />
        </div>
        {totals && <Totals totals={totals} />}

        {nothingEdited && <p className="text-secondary">No edits in this file. Change a rate, decision or outcome, then upload it again.</p>}

        {upload && !nothingEdited && (
          <section className="space-y-2 rounded-lg border border-gray-200 p-3" aria-label="Rate review preview">
            <h3 className="font-semibold text-nav-dark">
              Preview: {count(upload.rates.length, 'edited rate', 'edited rates')}, {count(upload.outcomes.length, 'edited outcome', 'edited outcomes')}
            </h3>
            {!preview && !saved && (
              <Button variant="secondary" onClick={() => void retryPreview()} loading={busy}>Preview again</Button>
            )}
            {shown && shown.problems.length > 0 && (
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
            {shown && shown.changes.length > 0 && (
              <div className="max-h-72 overflow-auto">
                <table className="w-full text-left" aria-label="Rate review changes">
                  <thead><tr className="text-secondary"><th className="font-medium">Row</th><th className="font-medium">Parent</th>
                    <th className="font-medium">Change</th><th className="font-medium">Label check</th></tr></thead>
                  <tbody>
                    {shown.rates.filter((r) => r.status === 'change').map((r) => {
                      const check = labelCheckText(r.label_check);
                      return (
                        <tr key={`rate-${r.index}`}>
                          <td>Draft Rates {r.sheetRow}</td><td>{r.label}</td>
                          <td>{(r.actions ?? []).map((a) => (r.isNew && a === 'save' ? 'add' : ACTION_WORDS[a] ?? a)).join(', ')}</td>
                          <td className={r.label_check?.status === 'above' || r.label_check?.status === 'not_checked' ? 'text-amber-800' : ''}>{check}</td>
                        </tr>
                      );
                    })}
                    {shown.outcomes.filter((o) => o.status === 'change').map((o) => (
                      <tr key={`outcome-${o.index}`}>
                        <td>Rate Outcomes {o.sheetRow}</td><td>{o.label}</td>
                        <td>{o.outcome ? `outcome: ${o.outcome.replace(/_/g, ' ')}` : 'outcome cleared (undecided)'}{o.note ? ` · "${o.note}"` : ''}</td><td />
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {shown && shown.changes.length === 0 && shown.problems.length === 0 && (
              <p className="text-secondary">Everything in this file already matches the database. Nothing to save.</p>
            )}
            {saved
              ? <p className="text-green-700">Saved {count(saved.rates_changed, 'rate', 'rates')} and {count(saved.outcomes_changed, 'outcome', 'outcomes')}. Download a fresh workbook to continue.</p>
              : shown && (
                <Button onClick={() => void confirm()} loading={busy} disabled={shown.blocked}>
                  Confirm rate review ({count(shown.changes.length, 'change', 'changes')})
                </Button>
              )}
          </section>
        )}
      </div>
    </Modal>
  );
}
