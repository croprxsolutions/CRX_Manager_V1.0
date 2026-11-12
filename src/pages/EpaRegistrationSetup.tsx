import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Power } from 'lucide-react';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import ConfirmModal from '../components/ui/ConfirmModal';
import SplitHeading from '../components/ui/SplitHeading';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { useIdempotencyKey } from '../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../lib/db';
import { isDefinitiveRpcRejection } from '../lib/idempotency';
import { Sentry } from '../lib/sentry';
import {
  allPicked, FACT_LABELS, factText, getEpaSalesToCheck, listSeedLines, previewEpaRegistrationSeed, seedEpaRegistrations,
  type SaleToCheck, type SeedFactValue, type SeedLine, type SeedPicks, type SeedPreview,
} from '../lib/epaRegistrationSeed';

const REASON_TEXT: Record<SaleToCheck['reason'], string> = {
  not_captured: 'Not captured: check what was sold',
  restricted_use_to_record: 'Restricted use: record it in the RUP register',
  no_epa_number: 'Restricted use with no EPA number: add one',
  now_restricted_use: 'Now restricted use: check whether to record it',
  not_reviewed: 'Restricted use not reviewed: review the label',
  brand_no_epa_number: 'Brand has no EPA number: add one',
  brand_split_mismatch: 'Brands do not add up to what was delivered: correct the delivery brands',
  overlapping_invoices: 'Another invoice bills the same delivery: check the invoices',
  payer_split_changed: 'Split-bill payers no longer agree on brands: check the invoices',
  billed_above_delivered: 'Billed more than was delivered: check the invoice',
  brand_lines_stale: 'Delivery brands changed after posting: check the record',
  brand_not_recorded: 'No brand recorded for this delivery: check what was sold',
};

/** Where a line's capture comes from: the seed always takes the product's current number. */
function lineNumberText(line: SeedLine): string {
  const productNumber = line.products?.epa_registration?.trim();
  const own = line.epa_registration?.trim();
  // Restricted use is decided by the seed from the product's tick and any registration, so it is not guessed here.
  if (!productNumber) return own ? `No EPA number on the product (line says ${own})` : 'No EPA number on the product';
  if (!own) return `${productNumber} (assumed from the product)`;
  return own === productNumber ? productNumber : `${productNumber} (line says ${own})`;
}

/** The captured number, never replaced by the line's saved one: a missing capture must look missing. */
function capturedNumberText(r: SaleToCheck): string {
  const captured = r.epa_registration ?? 'None captured';
  return r.saved_number && r.saved_number !== r.epa_registration ? `${captured} (line saved ${r.saved_number})` : captured;
}

function SalesToCheck() {
  const [rows, setRows] = useState<SaleToCheck[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    getEpaSalesToCheck()
      .then((r) => { if (live) setRows(r); })
      .catch((e) => { if (live) setError(sanitizeError(e)); });
    return () => { live = false; };
  }, []);
  return (
    <Card>
      <h2 className="text-lg font-semibold text-nav-dark mb-2">Sales to check</h2>
      {error ? <p className="text-sm text-red-600">Could not load the list: {error}. This is a failed read, not an empty list.</p>
        : rows === null ? <p className="text-sm text-secondary">Loading…</p>
        : rows.length === 0 ? <p className="text-sm text-secondary">Nothing to check.</p>
        : (
          <table className="w-full text-left text-sm">
            <thead><tr className="text-secondary"><th>Invoice</th><th>Date</th><th>Product</th><th>EPA number</th><th>Qty</th><th>Why</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.line_id}|${r.brand_key ?? ''}|${r.reason}`} className="border-t border-gray-100">
                  <td>{r.invoice_number ?? '—'}</td>
                  <td>{r.invoice_date ?? '—'}</td>
                  <td>{r.brand_name ? `${r.product_name} (${r.brand_name})` : r.product_name}</td>
                  <td>{capturedNumberText(r)}</td>
                  <td>{r.allocated_quantity ?? r.quantity}</td>
                  <td>{REASON_TEXT[r.reason] ?? r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
    </Card>
  );
}

/** Shown once the setup has run: it is never offered again. */
function SwitchedOn() {
  return (
    <div className="space-y-6">
      <SplitHeading title="EPA registration" accent="setup" />
      <Card>
        <p className="flex items-center gap-2 text-sm text-nav-dark" role="status">
          <CheckCircle2 className="h-5 w-5 text-crx-green" aria-hidden />
          EPA registrations are already switched on. This setup runs only once.
        </p>
      </Card>
      <SalesToCheck />
    </div>
  );
}

/** What the setup will do, the picks it needs, and the Run button. */
function PreviewBody({ preview, lines, picks, setPick, busy, unsure, onRun }: {
  preview: SeedPreview;
  lines: SeedLine[];
  picks: SeedPicks;
  setPick: (num: string, col: string, value: SeedFactValue) => void;
  busy: boolean;
  unsure: boolean;
  onRun: () => void;
}) {
  const disagreeing = preview.registrations.filter((r) => Object.keys(r.disagreements).length > 0);
  const pickCount = disagreeing.reduce((n, r) => n + Object.keys(r.disagreements).length, 0);
  const picked = allPicked(preview, picks);
  const blocked = preview.invalid_numbers.length > 0 || !picked;
  return (
    <>
      <Card>
        <h2 className="text-lg font-semibold text-nav-dark mb-2">What the one-time setup will do</h2>
        <ul className="list-disc pl-5 text-sm space-y-1">
          <li>Create <strong>{preview.registration_count}</strong> EPA registrations, one per EPA number in use.</li>
          <li>Restricted use: a number no product or brand marks restricted use becomes <strong>No</strong> (your answer; update labels before selling).</li>
          <li>Capture <strong>{lines.length}</strong> invoice lines with the EPA number and restricted-use answer they are sold under.</li>
          <li>While it runs (a few seconds) product and invoice saves wait. Afterwards, label facts on registered products are edited on the registration.</li>
          <li>It runs once and cannot be run again.</li>
        </ul>
      </Card>

      {preview.invalid_numbers.length > 0 && (
        <Card>
          <p className="flex gap-2 text-sm text-red-700" role="alert">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            These EPA numbers are not valid, so the setup cannot run until each is corrected where it is stored (a product, brand, parent group, invoice line or job line): {preview.invalid_numbers.join(', ')}
          </p>
        </Card>
      )}

      <Card>
        <h2 className="text-lg font-semibold text-nav-dark mb-2">Disagreements to pick ({pickCount})</h2>
        {disagreeing.length === 0 ? <p className="text-sm text-secondary">None: every product and brand agrees.</p> : (
          <div className="space-y-4">
            {disagreeing.map((r) => Object.entries(r.disagreements).map(([col, cands]) => (
              <fieldset key={`${r.epa_registration}-${col}`} disabled={busy || unsure} className="text-sm">
                <legend className="font-medium text-nav-dark">
                  EPA <span className="font-mono">{r.epa_registration}</span>: {FACT_LABELS[col] ?? col}
                </legend>
                {cands.map((c) => (
                  <label key={factText(c)} className="mr-4 inline-flex items-center gap-1">
                    <input type="radio" name={`${r.epa_registration}-${col}`}
                      checked={JSON.stringify(picks[r.epa_registration]?.[col]) === JSON.stringify(c)}
                      onChange={() => setPick(r.epa_registration, col, c)} />
                    {factText(c)}
                  </label>
                ))}
              </fieldset>
            )))}
          </div>
        )}
      </Card>

      <Card>
        <h2 className="text-lg font-semibold text-nav-dark mb-2">Invoice lines to capture ({lines.length})</h2>
        {lines.length === 0 ? <p className="text-sm text-secondary">No invoice lines.</p> : (
          <table className="w-full text-left text-sm">
            <thead><tr className="text-secondary"><th>Invoice</th><th>Status</th><th>Product</th><th>Captured under</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id} className="border-t border-gray-100">
                  <td>{l.invoices?.invoice_number ?? '—'}</td>
                  <td>{l.invoices?.status ?? '—'}</td>
                  <td>{l.products?.product_name ?? '—'}</td>
                  <td>{lineNumberText(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        {unsure && <p className="mb-2 text-sm text-amber-700" role="alert">The last run's answer was lost. Retry sends the same request; it cannot run twice.</p>}
        <p className="mb-3 text-xs text-secondary">Keep this page open until it finishes.</p>
        <Button icon={<Power className="h-4 w-4" />} showChevron={false} disabled={blocked || busy}
          onClick={onRun}>
          {busy ? 'Running…' : unsure ? 'Not sure this saved: Retry' : 'Run setup'}
        </Button>
        {!picked && <p className="mt-2 text-xs text-secondary">Pick one value for each disagreement first.</p>}
      </Card>
    </>
  );
}

/**
 * EPA registration setup (admins only): preview, then run once, the REG-1 seed that turns on EPA
 * registrations. The database is the guard: it refuses a stale preview, any second run, and non-admins.
 */
export default function EpaRegistrationSetup() {
  const { toast } = useToast();
  const { profile } = useAuth();
  const [preview, setPreview] = useState<SeedPreview | null>(null);
  const [lines, setLines] = useState<SeedLine[]>([]);
  const [picks, setPicks] = useState<SeedPicks>({});
  const [done, setDone] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // A run whose answer was lost: it may have saved. Only the same picks and key are resent.
  const [unsure, setUnsure] = useState(false);
  const reqRef = useRef(0);
  const { getKey, resetKey } = useIdempotencyKey('seed_epa_registrations', profile?.id ?? '',
    JSON.stringify([preview?.fingerprint ?? null, picks]));

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setLoading(true);
    setLoadError(null);
    try {
      const [p, l] = await Promise.all([previewEpaRegistrationSeed(), listSeedLines()]);
      if (req !== reqRef.current) return;
      setPreview(p);
      setLines(l);
      setPicks({});
    } catch (e) {
      if (req !== reqRef.current) return;
      setPreview(null); // never leave an old preview (and its Run button) up after a failed read
      if (hasRpcCode(e, RpcErrorCodes.EPA_REGISTRATION_SEED_DONE)) {
        setDone(true);
      } else {
        Sentry.captureException(e, { tags: { source: 'rpc', action: 'preview_epa_registration_seed' } });
        setLoadError(sanitizeError(e));
      }
    } finally {
      if (req === reqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // A refused or lost run: lost keeps the key for Retry; a definitive answer retires it.
  const onSeedError = async (e: unknown) => {
    if (!isDefinitiveRpcRejection(e)) {
      setUnsure(true);
      toast('error', 'Could not tell whether the setup ran. Press "Not sure this saved: Retry": it will not run twice.');
      return;
    }
    setUnsure(false);
    resetKey();
    if (hasRpcCode(e, RpcErrorCodes.EPA_REGISTRATION_SEED_DONE)) {
      setDone(true);
      setPreview(null);
      toast('info', 'EPA registrations are already switched on.');
    } else if (hasRpcCode(e, RpcErrorCodes.EPA_REGISTRATION_SEED_STALE)) {
      toast('error', 'Products, brands or invoice lines changed since this preview. Nothing was saved. The new preview is below; check it and pick again.');
      await load();
    } else {
      Sentry.captureException(e, { tags: { source: 'rpc', action: 'seed_epa_registrations' } });
      toast('error', sanitizeError(e));
    }
  };

  const run = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await seedEpaRegistrations(picks, preview.fingerprint, getKey());
      resetKey();
      setUnsure(false);
      setConfirming(false);
      setDone(true);
      setPreview(null);
      toast('success', `Switched on: ${result.registrations} registrations created, ${result.lines_captured} invoice lines captured.`);
    } catch (e) {
      setConfirming(false);
      await onSeedError(e);
    } finally {
      setBusy(false);
    }
  };

  const setPick = (num: string, col: string, value: SeedFactValue) =>
    setPicks((prev) => ({ ...prev, [num]: { ...prev[num], [col]: value } }));

  if (done) return <SwitchedOn />;

  return (
    <div className="space-y-6">
      <SplitHeading title="EPA registration" accent="setup" />
      {loading && <Card><p className="text-sm text-secondary">Loading the preview…</p></Card>}
      {loadError && (
        <Card>
          <p className="text-sm text-red-600">Could not load the preview: {loadError}</p>
          <Button className="mt-3" variant="secondary" showChevron={false} onClick={() => void load()}>Try again</Button>
        </Card>
      )}
      {preview && !loading && (
        <PreviewBody preview={preview} lines={lines} picks={picks} setPick={setPick} busy={busy} unsure={unsure}
          onRun={() => (unsure ? void run() : setConfirming(true))} />
      )}

      <ConfirmModal
        open={confirming}
        onClose={() => { if (!busy) setConfirming(false); }}
        onConfirm={() => void run()}
        title="Switch on EPA registrations?"
        message={`This creates ${preview?.registration_count ?? 0} registrations and captures ${lines.length} invoice lines, with restricted use defaulting to No. Saves pause for a few seconds. It runs once and cannot be undone from the app.`}
        confirmLabel="Run setup"
        variant="warning"
        loading={busy}
      />
    </div>
  );
}
