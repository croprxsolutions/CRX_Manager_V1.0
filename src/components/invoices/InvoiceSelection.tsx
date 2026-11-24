import type { ReactNode } from 'react';
import { Send, X } from 'lucide-react';
import Button from '../ui/Button';
import { publishPageBarHeight } from '../../lib/pageBar';
import { formatCents } from '../../lib/money';

/**
 * The tick-and-post pieces both invoice lists share (Chemical Invoices and the Field Invoices
 * Drafts tab), so the bookkeeper learns one way to post. They only collect the selection and
 * call the screen's own handlers: which invoices can be ticked, what Post sends, and the confirm
 * it opens all stay with each screen.
 */

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface InvoiceRowCheckboxProps {
  invoiceNumber: string;
  checked: boolean;
  onToggle: () => void;
}

/** One row's tick box. It never opens the row it sits in. */
export function InvoiceRowCheckbox({ invoiceNumber, checked, onToggle }: InvoiceRowCheckboxProps) {
  return (
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onClick={(e) => e.stopPropagation()}
      aria-label={`Select invoice ${invoiceNumber}`}
      className="w-4 h-4 rounded border-gray-300 text-crx-green focus:ring-crx-green"
    />
  );
}

interface SelectAllToggleProps {
  /** True when a press clears the selection ("Deselect All"); otherwise it selects ("Select All"). */
  clears: boolean;
  disabled?: boolean;
  onToggle: () => void;
  title: string;
}

/** "Select All" / "Deselect All" for the rows in view. Each screen decides which rows that picks. */
export function SelectAllToggle({ clears, disabled = false, onToggle, title }: SelectAllToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className="text-sm font-medium text-crx-green hover:underline disabled:text-gray-400 disabled:no-underline disabled:cursor-not-allowed"
      title={title}
    >
      {clears ? 'Deselect All' : 'Select All'}
    </button>
  );
}

interface InvoiceSelectionBarProps {
  /** Ticked invoices on screen. The bar shows only while this is above 0. */
  selectedCount: number;
  /** The ticked invoices' totals added up, in cents. */
  selectedTotalCents: number;
  onClear: () => void;
  /** How many invoices Post will post (a split counts every member it posts); 0 hides Post. */
  postCount: number;
  /** Opens the screen's own post confirm. */
  onPost: () => void;
  posting?: boolean;
  /** The screen's other actions on the selection (Print, More). */
  children?: ReactNode;
}

/**
 * One selection bar: count and total of the ticked invoices, the screen's other actions, and
 * "Post n invoices…" as the primary. Below md it is fixed above the bottom nav, Post first.
 */
export default function InvoiceSelectionBar({
  selectedCount,
  selectedTotalCents,
  onClear,
  postCount,
  onPost,
  posting = false,
  children,
}: InvoiceSelectionBarProps) {
  if (selectedCount === 0) return null;
  return (
    <div
      // Below md the bar is fixed above the bottom nav; the update notice sits above it.
      ref={publishPageBarHeight}
      role="toolbar"
      aria-label={`${plural(selectedCount, 'invoice')} selected`}
      className="mb-4 flex flex-wrap items-center gap-2 rounded-xl bg-nav-dark px-3 py-2.5 text-white max-md:fixed max-md:inset-x-0 max-md:bottom-[calc(3.5rem+env(safe-area-inset-bottom))] max-md:z-20 max-md:mb-0 max-md:rounded-none max-md:border-t max-md:border-gray-200 max-md:bg-white max-md:p-3 max-md:text-nav-dark max-md:shadow-lg"
    >
      <span className="mr-auto flex flex-wrap items-baseline gap-x-2">
        <strong className="font-semibold">{selectedCount} selected</strong>
        <span className="text-sm tabular-nums opacity-80" title="Total of the selected invoices">
          {formatCents(selectedTotalCents)}
        </span>
      </span>
      <button
        type="button"
        aria-label="Clear selection"
        onClick={onClear}
        className="rounded-lg px-2 text-sm font-medium text-crx-green md:order-last md:p-1.5 md:text-white/80 md:hover:text-white"
      >
        <span className="md:hidden">Clear</span>
        <X className="hidden h-5 w-5 md:block" aria-hidden="true" />
      </button>
      {children}
      {postCount > 0 && (
        <Button
          className="max-md:order-1 max-md:min-h-11 max-md:w-full md:h-10"
          icon={<Send className="w-4 h-4" />}
          onClick={onPost}
          loading={posting}
        >
          Post {plural(postCount, 'invoice')}…
        </Button>
      )}
    </div>
  );
}
