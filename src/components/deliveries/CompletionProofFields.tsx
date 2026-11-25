/**
 * The completion step every delivery screen shares (My Route's stop screen, and the delivery detail for a
 * driver and for the office): who signed, how the customer confirmed (on-screen signature, or a photo of a
 * signed paper ticket), and the receipt email. Inputs only: each screen keeps its own state, checks and
 * save call, so what a completion sends is decided by the screen, never here.
 *
 * Screen-specific proof paths come in through `extraOptions` (more ways to confirm, such as "No one
 * present" or the office's "Record without proof") and `alternateProof` (what replaces the signature for
 * that path). A problem with the delivery (short, damaged, refused...) is reported in this same step through
 * `issue` (`DeliveryIssueFields`); the screen sends it with its own completion.
 */
import type { ReactNode } from 'react';
import { Camera, CheckCircle2 } from 'lucide-react';
import SignatureCanvas from '../ui/SignatureCanvas';
import HelpTip from '../ui/HelpTip';
import { todayInBusinessTz } from '../../lib/dateUtils';
import DeliveryIssueFields, { type DeliveryIssueValue } from './DeliveryIssueFields';

const CHECKBOX = 'h-5 w-5 shrink-0 rounded border-gray-300 text-crx-green focus:ring-crx-green';
const TEXT_INPUT = 'h-12 w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-nav-dark placeholder:text-gray-500 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500';
const SECONDARY_BUTTON = 'flex h-12 w-full items-center justify-center gap-2 rounded-xl border border-gray-300 bg-white font-semibold text-nav-dark active:scale-[0.99] disabled:opacity-50';

interface PaperTicketProof {
  /** A photo of the signed ticket is saved on the delivery. */
  hasPhoto: boolean;
  deliveredOn: string;
  onDeliveredOnChange: (value: string) => void;
  /** Opens the screen's own camera input. */
  onTakePhoto: () => void;
  takePhotoDisabled: boolean;
  uploading: boolean;
}

interface CompletionProofFieldsProps {
  /** Keeps input ids unique on a page. */
  idPrefix: string;
  signedBy: string;
  onSignedByChange: (value: string) => void;
  /** The name is set by the chosen proof path (no one present, no proof) and cannot be typed. */
  signerLocked?: boolean;
  /** The farm's contact on file, offered as a one-tap Signed by name. */
  contactName?: string;
  usePaperTicket: boolean;
  onUsePaperTicketChange: (checked: boolean) => void;
  showPaperTicketOption?: boolean;
  paperTicket: PaperTicketProof;
  onSignatureChange: (dataUrl: string | null) => void;
  /** A new key gives a fresh, empty signature box. */
  signatureKey?: string;
  extraOptions?: ReactNode;
  /** Replaces the signature or ticket photo when another proof path is chosen. */
  alternateProof?: ReactNode;
  /** The receipt email box; leave out where the screen asks it elsewhere or cannot send one. */
  receipt?: { checked: boolean; onChange: (checked: boolean) => void };
  /** Report a problem with the delivery; the screen sends it as complete_delivery's p_issue_type and p_issue_notes. */
  issue?: DeliveryIssueValue;
}

/** One way to confirm the delivery: a full-size checkbox row with optional help outside the label. */
export function ProofOption({ checked, onChange, help, children }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  help?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-1">
      <label className="flex min-h-[44px] cursor-pointer items-center gap-3 text-base text-nav-dark">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className={CHECKBOX} />
        {children}
      </label>
      {/* Outside the label, so opening help never toggles the option. */}
      {help && <HelpTip text={help} className="ml-1" />}
    </div>
  );
}

/** "Email delivery receipt to customer": shown whenever a receipt can be asked for, even when the screen
 * cannot see the customer's email (the server finds it). */
export function EmailReceiptOption({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <ProofOption
      checked={checked}
      onChange={onChange}
      help="If checked, the customer receives an email with the items delivered and who signed (no photos). Uncheck if this is an internal transfer."
    >
      Email delivery receipt to customer
    </ProofOption>
  );
}

function PaperTicketPanel({ idPrefix, proof }: { idPrefix: string; proof: PaperTicketProof }) {
  return (
    <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-3">
      {proof.hasPhoto ? (
        <p className="flex items-center gap-2 text-sm text-green-700">
          <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> Photo of the signed ticket saved
        </p>
      ) : (
        <p className="text-sm text-amber-800">Take a photo of the signed paper ticket. It replaces the on-screen signature.</p>
      )}
      <div>
        <label htmlFor={`${idPrefix}-paper-delivered-on`} className="mb-1 block text-sm font-semibold text-nav-dark">Delivered on (date on the ticket)</label>
        <input
          id={`${idPrefix}-paper-delivered-on`}
          type="date"
          value={proof.deliveredOn}
          max={todayInBusinessTz()}
          onChange={(e) => proof.onDeliveredOnChange(e.target.value)}
          className={TEXT_INPUT}
        />
      </div>
      <button type="button" disabled={proof.takePhotoDisabled} onClick={proof.onTakePhoto} className={SECONDARY_BUTTON}>
        <Camera className="h-5 w-5" aria-hidden="true" /> {proof.uploading ? 'Uploading…' : 'Take Photo of Signed Ticket'}
      </button>
    </div>
  );
}

export default function CompletionProofFields({
  idPrefix, signedBy, onSignedByChange, signerLocked = false, contactName = '', usePaperTicket, onUsePaperTicketChange,
  showPaperTicketOption = true, paperTicket, onSignatureChange, signatureKey, extraOptions, alternateProof, receipt, issue,
}: CompletionProofFieldsProps) {
  const signerId = `${idPrefix}-signed-by`;
  const offerContact = !!contactName && !signerLocked && signedBy.trim() !== contactName;
  const proof = alternateProof
    ?? (usePaperTicket
      ? <PaperTicketPanel idPrefix={idPrefix} proof={paperTicket} />
      : <SignatureCanvas key={signatureKey} onSignatureChange={onSignatureChange} label="Customer signature" />);

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor={signerId} className="mb-1 block text-sm font-semibold text-nav-dark">Signed by (name)</label>
        {offerContact && (
          <button type="button" onClick={() => onSignedByChange(contactName)} className="mb-2 inline-flex min-h-[44px] max-w-full items-center rounded-full border border-crx-green bg-crx-green-light px-4 text-base font-semibold text-crx-green-hover active:scale-[0.99]">
            <span className="truncate">Use {contactName}</span>
          </button>
        )}
        <input
          id={signerId}
          type="text"
          value={signedBy}
          onChange={(e) => onSignedByChange(e.target.value)}
          placeholder="Customer name"
          disabled={signerLocked}
          className={TEXT_INPUT}
          autoComplete="off"
        />
      </div>
      <div>
        {showPaperTicketOption && (
          <ProofOption
            checked={usePaperTicket}
            onChange={(checked) => {
              onUsePaperTicketChange(checked);
              if (checked) onSignatureChange(null);
            }}
            help="Use this when the customer signed a paper delivery ticket instead of the screen, for example with no signal at the site. A photo of the signed ticket is required in place of the on-screen signature."
          >
            Customer signed a paper ticket
          </ProofOption>
        )}
        {extraOptions}
      </div>
      {proof}
      {receipt && <EmailReceiptOption checked={receipt.checked} onChange={receipt.onChange} />}
      {issue && (
        <div className="border-t border-gray-200 pt-3">
          <DeliveryIssueFields idPrefix={idPrefix} issue={issue} />
        </div>
      )}
    </div>
  );
}
