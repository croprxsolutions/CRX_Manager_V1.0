import { useEffect, useId, useRef, useCallback, type ReactNode } from 'react';
import { X, type LucideIcon } from 'lucide-react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  closeDisabled?: boolean;
  title: string;
  accent?: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
  maxWidth?: string;
  /**
   * wide: a fixed-height work dialog (preview and send) whose content manages its own scroll.
   * alert: a short confirm. A centred card from md up, a bottom sheet on phone, no X. The
   * footer's buttons go safe action first, main action last; the phone sheet stacks them
   * with the main action on top. Initial focus lands on the first button (the safe one).
   */
  size?: 'default' | 'large' | 'wide' | 'fullscreen' | 'alert';
  /** A tinted icon circle before the title. Tint it with iconClassName (e.g. 'bg-red-50 text-red-700'). */
  icon?: LucideIcon;
  iconClassName?: string;
}

/** A button in an alert-layout footer: 48px full width on the phone sheet, 40px inline from md up. */
export const ALERT_BUTTON = 'min-h-12 w-full md:min-h-10 md:w-auto max-md:rounded-xl max-md:text-base';

const FOCUSABLE = 'a[href], button:not([disabled]), textarea:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]):not([type="hidden"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

export default function Modal({
  open,
  onClose,
  closeDisabled = false,
  title,
  accent,
  subtitle,
  children,
  footer,
  maxWidth,
  size = 'default',
  icon: Icon,
  iconClassName = '',
}: ModalProps) {
  const panelSizeClass = size === 'fullscreen'
    ? 'h-[100dvh] max-h-[100dvh] max-w-full rounded-none'
    : `h-[100dvh] max-h-[100dvh] max-w-full rounded-none ${maxWidth === 'max-w-2xl'
      ? 'md:max-w-2xl'
      : size === 'large'
        ? 'md:max-w-4xl'
        : size === 'wide'
          ? 'md:max-w-6xl'
          : 'md:max-w-lg'} md:mx-4 ${size === 'wide' ? 'md:h-[90vh]' : 'md:h-auto'} md:max-h-[90vh] md:rounded-2xl`;
  const dialogRef = useRef<HTMLDivElement>(null);
  // useId gives every open modal a unique, render-stable id (a random id read from a ref is
  // impure during render and can collide).
  const baseId = useId();
  const titleId = `modal-title-${baseId}`;
  const descriptionId = `modal-description-${baseId}`;

  // Escape key handler
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (!closeDisabled) onClose();
        return;
      }
      // Focus trap: cycle focus within modal
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE);
        if (focusable.length === 0) {
          e.preventDefault();
          dialogRef.current.focus();
          return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    },
    [closeDisabled, onClose]
  );

  // Separate effect for keyboard listener (updates when handler changes)
  useEffect(() => {
    if (open) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, handleKeyDown]);

  // Separate effect for focus + body overflow (only runs when open changes)
  useEffect(() => {
    if (!open) {
      document.body.style.overflow = '';
      return;
    }
    // Remember what had focus so closing hands it back (the button that opened the dialog).
    const opener = document.activeElement;
    document.body.style.overflow = 'hidden';
    const frame = requestAnimationFrame(() => {
      const panel = dialogRef.current;
      const preferred = panel?.querySelector<HTMLElement>('[data-autofocus]:not([disabled])');
      const focusable = panel?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (preferred) {
        preferred.focus();
      } else if (focusable && focusable.length > 0) {
        focusable[0].focus();
      } else {
        panel?.focus();
      }
    });
    return () => {
      cancelAnimationFrame(frame);
      document.body.style.overflow = '';
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const iconCircle = Icon && (
    <span
      data-modal-icon
      aria-hidden="true"
      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full md:h-10 md:w-10 ${iconClassName}`}
    >
      <Icon className="h-5 w-5" />
    </span>
  );

  if (size === 'alert') {
    return (
      <div
        className="fixed inset-0 z-50 m-0! flex items-end justify-center md:items-center"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div
          className="fixed inset-0 bg-black/50"
          onClick={closeDisabled ? undefined : onClose}
          aria-hidden="true"
        />
        {/* Phone: a sheet that slides up (translate only). md+: the card fades and zooms in.
            @starting-style gives the entry frame; no transition under reduced motion. */}
        <div
          ref={dialogRef}
          data-modal-panel
          tabIndex={-1}
          className="relative flex max-h-[90dvh] w-full max-w-full flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl motion-safe:transition-[translate,scale,opacity] motion-safe:duration-200 motion-safe:ease-out max-md:starting:translate-y-full md:mx-4 md:max-w-md md:rounded-2xl md:border md:border-gray-100 md:starting:scale-95 md:starting:opacity-0"
        >
          <span aria-hidden="true" className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-gray-300 md:hidden" />
          <div data-modal-body className="flex min-h-0 gap-3.5 overflow-y-auto overscroll-contain px-5 pb-4 pt-4 md:px-6 md:pb-5 md:pt-6">
            {iconCircle}
            <div className="flex min-w-0 flex-col gap-1.5">
              <h2 id={titleId} className="font-heading text-[22px] font-semibold leading-tight text-nav-dark">
                {title}
                {accent && <span className="split-heading-accent"> {accent}</span>}
              </h2>
              <div id={descriptionId} className="break-words text-[15px] text-secondary md:text-sm">
                {children}
              </div>
            </div>
          </div>
          {footer && (
            <div
              data-modal-footer
              className="flex shrink-0 flex-col-reverse gap-2.5 px-5 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-1 md:flex-row md:justify-end md:border-t md:border-cream-dark md:bg-cream md:px-6 md:py-3.5"
            >
              {footer}
            </div>
          )}
        </div>
      </div>
    );
  }

  const heading = (
    <>
      <h2 id={titleId} className="text-xl md:text-2xl font-semibold font-heading text-nav-dark">
        {title}
        {accent && <span className="split-heading-accent"> {accent}</span>}
      </h2>
      {subtitle && <p className="truncate text-sm text-secondary">{subtitle}</p>}
    </>
  );

  return (
    // m-0!: callers render dialogs inside space-y stacks, whose child margin pushed the whole overlay down (a gap at the top on phone).
    <div className="fixed inset-0 z-50 m-0! flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div
        className="fixed inset-0 bg-black/50"
        onClick={closeDisabled ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        ref={dialogRef}
        data-modal-panel
        tabIndex={-1}
        className={`
          relative flex w-full flex-col bg-white shadow-2xl border border-gray-100
          ${panelSizeClass}
          animate-in fade-in zoom-in-95
        `}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gray-100 px-6 py-4 pt-[calc(1rem+env(safe-area-inset-top))]">
          {iconCircle ? (
            <div className="flex min-w-0 items-center gap-3">
              {iconCircle}
              <div className="min-w-0">{heading}</div>
            </div>
          ) : (
            <div className="min-w-0">{heading}</div>
          )}
          <button
            onClick={onClose}
            disabled={closeDisabled}
            aria-label="Close"
            className="inline-flex h-11 w-11 md:h-10 md:w-10 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:text-nav-dark hover:bg-gray-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div data-modal-body className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-5">
          {children}
        </div>
        {footer && (
          <div
            data-modal-footer
            className="sticky bottom-0 shrink-0 border-t border-gray-100 bg-white px-6 py-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
