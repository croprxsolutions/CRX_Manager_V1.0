import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '../../lib/db';
import { Sentry } from '../../lib/sentry';
import {
  applyLabelCorrections,
  findLabelCorrections,
  type LabelCorrectionRow,
  type ProductLabelValues,
} from '../../lib/jobLabelCorrections';
import Button from '../ui/Button';
import { useToast } from '../ui/Toast';

interface Props<T extends LabelCorrectionRow> {
  rows: T[];
  canEdit: boolean;
  onApply: (next: T[]) => void;
}

function EditableNotice<T extends LabelCorrectionRow>({ rows, onApply }: Omit<Props<T>, 'canEdit'>) {
  const { toast } = useToast();
  const idsKey = [...new Set(rows.map((row) => row.product_id).filter(Boolean))].sort().join(',');
  const [loadedLabels, setLoadedLabels] = useState<{
    idsKey: string;
    values: Map<string, ProductLabelValues>;
  } | null>(null);
  const [failedIdsKey, setFailedIdsKey] = useState<string | null>(null);
  // shortcut: dismissal lasts until the page reloads; persist per job if staff ask.
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(null);

  useEffect(() => {
    if (!idsKey) return;
    let cancelled = false;

    void (async () => {
      const { data, error } = await supabase.from('products')
        .select('id, rei_hours, phi_days')
        .in('id', idsKey.split(','));
      if (cancelled) return;
      if (error) {
        Sentry.captureException(error, { extra: { context: 'job_label_corrections_lookup' } });
        setLoadedLabels(null);
        setFailedIdsKey(idsKey);
        return;
      }
      setFailedIdsKey(null);
      setLoadedLabels({
        idsKey,
        values: new Map((data ?? []).map((product) => [product.id, {
          rei_hours: product.rei_hours,
          phi_days: product.phi_days,
        }])),
      });
    })().catch((error: unknown) => {
      if (cancelled) return;
      Sentry.captureException(error, { extra: { context: 'job_label_corrections_lookup' } });
      setLoadedLabels(null);
      setFailedIdsKey(idsKey);
    });

    return () => { cancelled = true; };
  }, [idsKey]);

  const corrections = loadedLabels?.idsKey === idsKey
    ? findLabelCorrections(rows, loadedLabels.values)
    : [];
  if (failedIdsKey === idsKey && idsKey) {
    return <p className="mb-4 text-xs text-secondary">Could not check this job's lines against the product label.</p>;
  }
  const signature = corrections.map(({ rowIndex, field, jobValue, productValue }) =>
    `${rowIndex}:${rows[rowIndex]?.product_id}:${field}:${jobValue}:${productValue}`).join('|');
  if (corrections.length === 0 || signature === dismissedSignature) return null;

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-3 text-amber-800">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Some lines differ from the product's current label</h3>
          <ul className="list-disc space-y-1 pl-5 text-sm">
            {corrections.map((correction) => (
              <li key={`${correction.rowIndex}-${correction.field}`}>
                {correction.product_name || 'Product'} — {correction.field === 'rei_hours' ? 'REI' : 'PHI'}: {correction.jobValue} {correction.field === 'rei_hours' ? 'hr' : 'days'} → {correction.productValue} {correction.field === 'rei_hours' ? 'hr' : 'days'}
              </li>
            ))}
          </ul>
          <p className="text-xs">Only this open job's lines change, and only after you save. Invoices and restricted-use sale records are never changed.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" onClick={() => {
              onApply(applyLabelCorrections(rows, corrections));
              toast('success', 'Label values updated — save the job to keep them.');
            }}>
              Update to current label
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => setDismissedSignature(signature)}>
              Keep job values
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function JobLabelCorrectionsNotice<T extends LabelCorrectionRow>(props: Props<T>) {
  if (!props.canEdit) return null;
  return <EditableNotice rows={props.rows} onApply={props.onApply} />;
}
