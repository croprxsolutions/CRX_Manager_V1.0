/**
 * Reporting a problem with a delivery (short or damaged product, gate locked, refused...) as part of its one
 * completion step. Shared by My Route's stop screen and both delivery detail views through
 * `CompletionProofFields`' `issue` prop, so a driver reports it the same way on every screen.
 *
 * Inputs only: the screen keeps the values and sends them with its own complete_delivery call
 * (p_issue_type, p_issue_notes). The server tells the office when a delivery completes with an issue.
 */
import type { DeliveryIssueType } from '../../types';
import HelpTip from '../ui/HelpTip';
import { ISSUE_TYPE_LABELS } from '../../lib/deliveryIssueTypes';

const FIELD = 'w-full rounded-xl border border-gray-300 bg-white px-3 text-base text-nav-dark placeholder:text-gray-500 focus:border-crx-green focus:outline-none focus:ring-2 focus:ring-crx-green';

export interface DeliveryIssueValue {
  type: DeliveryIssueType;
  notes: string;
  onTypeChange: (type: DeliveryIssueType) => void;
  onNotesChange: (notes: string) => void;
}

export default function DeliveryIssueFields({ idPrefix, issue }: { idPrefix: string; issue: DeliveryIssueValue }) {
  const typeId = `${idPrefix}-issue-type`;
  const notesId = `${idPrefix}-issue-notes`;
  return (
    <div className="space-y-3">
      <div>
        <div className="mb-1 flex items-center">
          <label htmlFor={typeId} className="text-sm font-semibold text-nav-dark">Report an issue (optional)</label>
          <HelpTip
            text="The office is told when you complete the delivery. For short or damaged product, set what was really delivered in the quantities, choose Other here and describe it."
            className="ml-1"
          />
        </div>
        <select
          id={typeId}
          value={issue.type}
          onChange={(e) => issue.onTypeChange(e.target.value as DeliveryIssueType)}
          className={`${FIELD} h-12`}
        >
          {Object.entries(ISSUE_TYPE_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>
      {issue.type !== 'none' && (
        <div>
          <label htmlFor={notesId} className="mb-1 block text-sm font-semibold text-nav-dark">Describe the issue</label>
          <textarea
            id={notesId}
            value={issue.notes}
            onChange={(e) => issue.onNotesChange(e.target.value)}
            placeholder="For example: one jug cracked, 2 cases short"
            rows={3}
            className={`${FIELD} min-h-[88px] resize-none py-2`}
          />
        </div>
      )}
    </div>
  );
}
