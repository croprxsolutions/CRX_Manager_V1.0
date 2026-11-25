import { useState } from 'react';
import Button from '../ui/Button';
import Modal from '../ui/Modal';
import { useToast } from '../ui/Toast';
import { useIdempotencyKey } from '../../hooks/useIdempotencyKey';
import { hasRpcCode, RpcErrorCodes, sanitizeError } from '../../lib/db';
import { formatExactUSD } from '../../lib/money';
import {
  commitParentRateCutover, previewParentRateCutover,
  type ProductParent, type RateCutoverPreview, type RateSource,
} from '../../lib/productParents';
import { ReasonField } from './ProductParentPanel';
import { OpenWorkList } from './ParentRatesModal';

type Eligible = Extract<RateCutoverPreview, { eligible: true }>;

// The database's reason without the generic prefix, for messages that say what happened in their own words.
const refusalText = (error: unknown) => sanitizeError(error).replace(/^Nothing was saved\.\s*/, '');
const ALREADY = [RpcErrorCodes.PRODUCT_PARENT_CUTOVER_ALREADY_APPROVED, RpcErrorCodes.PRODUCT_PARENT_CUTOVER_ALREADY_LEGACY];
const alreadySwitched = (error: unknown) => ALREADY.some((code) => hasRpcCode(error, code));
// 20270301200000 (#2379): an approved rate above today's label maximum switches only with a typed over-label reason.
const OVER_LABEL = [RpcErrorCodes.PRODUCT_PARENT_CUTOVER_OVER_LABEL, RpcErrorCodes.PRODUCT_PARENT_CUTOVER_OVER_LABEL_REASON_TOO_LONG];
const needsOverLabelReason = (preview: RateCutoverPreview | null) => (preview?.eligible === false
  ? OVER_LABEL.some((code) => hasRpcCode({ message: preview.refusal }, code))
  : preview?.label_check?.status === 'above');

// An over-label preview counts only for the reason in the box now; after an edit, preview again.
function switchablePlan(preview: RateCutoverPreview | null, overLabel: string): Eligible | null {
  if (!preview?.eligible) return null;
  return !needsOverLabelReason(preview) || (preview.over_label_reason ?? '') === overLabel.trim() ? preview : null;
}
const planKeyParts = (plan: Eligible | null) => [plan?.expected ?? null, plan?.over_label_reason ?? null];

// The label maximums the over-label reason is given for, as the preview read them.
function OverLabelMaximums({ plan }: { plan: Eligible }) {
  return (
    <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" data-testid="rate-cutover-label-max">
      {`Above the label maximum: ${(plan.label_check?.above ?? [])
        .map((max) => `EPA ${max.epa_registration} allows ${max.max_label_rate} ${max.max_label_rate_unit}`).join('; ')}.`}
    </p>
  );
}

// Text that belongs to one scope (a group and direction); another scope starts empty.
function useScopedText(scope: string): [string, (text: string) => void] {
  const [held, setHeld] = useState({ scope: '', text: '' });
  return [held.scope === scope ? held.text : '', (text) => setHeld({ scope, text })];
}

const isServerRefusal = (error: unknown) => {
  const message = error instanceof Error ? error.message
    : typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : '';
  return /^[A-Z][A-Z0-9_]{5,}(?::|$)/.test(message);
};

const TIERS = [1, 2, 3] as const;
const perAcre = (value: number | null | undefined) => (value == null ? 'none' : formatExactUSD(value));
// A blank rate still keeps its unit (the field app offers it when someone types a rate), so show it.
const rateText = (rate: string | null, unit: string | null) => (rate == null ? (unit?.trim() ? `none (${unit.trim()})` : 'none') : `${rate} ${unit ?? ''}`.trim());
const text = (value: string | null) => (value?.trim() ? value : 'none');

// A switch that changes no rate writes no prices (the server skips the rate write), so the saved prices stay.
const afterPrices = (plan: Eligible, size: Eligible['expected']['sizes'][number]) => (plan.changes ? size.prices : size.before_prices);
// Every per-acre price shown, old and new, reads as an exact dollar amount (or none), so the admin switches to what they saw.
const allShownExactly = (plan: Eligible) => plan.expected.sizes.every((size) => TIERS.every((tier) =>
  [size.before_prices, afterPrices(plan, size)].every((prices) => perAcre(prices[`tier${tier}_price_per_acre`]) !== 'Invalid amount')));

// Why Switch stays off (shown in the warning box), or null when the preview may be switched. Old values a switch
// back could not re-save, and approved units field-app invoicing cannot convert, are refused by the database.
function cutoverWarning(preview: RateCutoverPreview | null): string | null {
  if (!preview) return null;
  if (!preview.eligible) return `Can't switch. ${refusalText({ message: preview.refusal })}`;
  // Not a box of its own: an inexact price already reads "Invalid amount" in the table.
  return allShownExactly(preview) ? null : '';
}

function CutoverTable({ plan, seedOrEach }: { plan: Eligible; seedOrEach: boolean }) {
  return (
    <div className="space-y-3">
      {!plan.changes && <p className="text-sm text-secondary">The rate is the same either way, so no rate or price changes; only the record of which rate is in use does.</p>}
      {plan.changes && plan.direction === 'promote' && plan.target.rate_per_acre == null && (
        <p className="text-sm text-secondary">The rate review decided this group has no per-acre rate, so its rate and per-acre prices become blank.</p>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" data-testid="rate-cutover-table">
          <thead>
            <tr className="text-secondary">
              <th className="pr-2 font-medium">Size</th>
              <th className="pr-2 font-medium">Rate per acre</th>
              <th className="pr-2 font-medium">Suggested rate</th>
              {TIERS.map((tier) => <th key={tier} className="pr-2 font-medium">Tier {tier} per acre</th>)}
            </tr>
          </thead>
          <tbody>
            {plan.expected.sizes.map((size) => (
              <tr key={size.product_id}>
                <td className="pr-2">{size.product_name}</td>
                <td className="pr-2">
                  {rateText(size.rate_per_acre, size.rate_unit)} → <span className="font-medium text-nav-dark">
                    {rateText(plan.target.rate_per_acre, seedOrEach ? size.rate_unit : plan.target.rate_unit)}</span>
                </td>
                <td className="pr-2">{text(size.suggested_rate)} → <span className="font-medium text-nav-dark">{text(plan.target.suggested_rate)}</span></td>
                {TIERS.map((tier) => (
                  <td key={tier} className="pr-2">
                    {perAcre(size.before_prices[`tier${tier}_price_per_acre`])} → <span className="font-medium text-nav-dark">{perAcre(afterPrices(plan, size)[`tier${tier}_price_per_acre`])}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <OpenWorkList productIds={plan.expected.sizes.map((size) => size.product_id)} />
    </div>
  );
}

/**
 * RT-4a: switch one group from its old rate to its approved RT-3 rate, or back. Preview shows what the
 * database would write; Switch sends the preview back, so the database refuses if anything changed since.
 */
export default function ParentRateCutoverModal({ parent, profileId, rateSource, onClose, onSaved }: {
  parent: ProductParent;
  profileId: string;
  rateSource: RateSource;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const direction = rateSource === 'approved' ? 'restore' : 'promote';
  const seedOrEach = parent.product_form === 'seed' || parent.product_form === 'each';
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [heldPreview, setPreview] = useState<RateCutoverPreview | null>(null);
  // A preview counts only for the group and direction on screen now; otherwise preview again.
  const preview = heldPreview?.parent_id === parent.id && heldPreview.direction === direction ? heldPreview : null;
  const [overLabel, setOverLabel] = useScopedText(`${parent.id}:${direction}`);
  const needsOverLabel = needsOverLabelReason(preview);
  const plan = switchablePlan(preview, overLabel);
  const warning = cutoverWarning(preview);
  const { getKey, resetKey } = useIdempotencyKey('commit_parent_rate_cutover', profileId,
    JSON.stringify([parent.id, direction, ...planKeyParts(plan), reason.trim()]));

  const showPreview = async () => {
    setSaving(true);
    try {
      const result = await previewParentRateCutover(parent.id, direction, overLabel);
      // Switched under this page (another admin): reload so the panel shows the true rate in use.
      if (!result.eligible && alreadySwitched({ message: result.refusal })) {
        toast('info', `${refusalText({ message: result.refusal })}; page reloaded`);
        onSaved();
        return;
      }
      setPreview(result);
    } catch (error) {
      toast('error', sanitizeError(error));
    } finally {
      setSaving(false);
    }
  };
  const commit = async () => {
    if (!plan) return;
    setSaving(true);
    try {
      await commitParentRateCutover(plan, reason.trim(), getKey());
      resetKey();
      const unchanged = plan.changes ? '' : '; rate and prices unchanged';
      toast('success', direction === 'promote'
        ? `${parent.name} now uses its approved rate on all ${plan.expected.sizes.length} size(s)${unchanged}`
        : `${parent.name} is back on its old rate on all ${plan.expected.sizes.length} size(s)${unchanged}`);
      onSaved();
    } catch (error) {
      // Already switched (another admin, or this admin's own lost reply): not a failure, the page reloads.
      if (alreadySwitched(error)) {
        toast('info', `${refusalText(error)}; page reloaded`);
        onSaved();
        return;
      }
      toast('error', sanitizeError(error));
      // A database refusal retires the preview: preview again. Only a lost reply (no refusal code) keeps it, so
      // Switch resends the same key and payload.
      if (isServerRefusal(error)) setPreview(null);
    } finally {
      setSaving(false);
    }
  };

  const title = direction === 'promote' ? 'Switch to approved rate' : 'Switch back to old rate';
  return (
    <Modal
      open
      onClose={onClose}
      closeDisabled={saving}
      size="large"
      title={title}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancel</Button>
          {plan
            ? <Button onClick={() => void commit()} loading={saving} disabled={saving || reason.trim() === '' || warning !== null}>{title}</Button>
            : <Button onClick={() => void showPreview()} loading={saving} disabled={saving}>Preview</Button>}
        </>
      )}
    >
      <fieldset disabled={saving} className="space-y-3">
        <p className="text-sm text-secondary">
          {direction === 'promote'
            ? `Switches ${parent.name} and all ${parent.sizes.length} size(s) from today's rate to the rate approved in the rate review, and reprices their per-acre prices. Saved quotes, orders and jobs keep their prices. You can switch back.`
            : `Puts back the rate, unit and suggested rate ${parent.name} had before the switch, on all ${parent.sizes.length} size(s), with per-acre prices at today's stock prices.`}
        </p>
        {needsOverLabel && (
          <ReasonField id="rate-cutover-over-label" label="Over-label reason (why use a rate above the label maximum)" value={overLabel} onChange={setOverLabel} maxLength={500} />
        )}
        {plan?.label_check?.status === 'above' && <OverLabelMaximums plan={plan} />}
        {warning && <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900" role="alert">{warning}</p>}
        {plan && <CutoverTable plan={plan} seedOrEach={seedOrEach} />}
        {plan && <ReasonField id="rate-cutover-reason" label="Reason" value={reason} onChange={setReason} />}
      </fieldset>
    </Modal>
  );
}
