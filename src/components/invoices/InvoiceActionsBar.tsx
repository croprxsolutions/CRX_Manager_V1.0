import { useId, useSyncExternalStore, type ComponentProps, type ReactNode } from 'react';
import { Check, DollarSign, Mail, Printer, Receipt, RotateCcw, Send, X } from 'lucide-react';
import Button from '../ui/Button';
import ActionMenu, { type ActionMenuItem } from '../ui/ActionMenu';

export interface InvoiceAction {
  onClick: () => void;
  loading?: boolean;
  disabled?: boolean;
}

/** Pass an action only when this person may use it on this invoice now; the page owns those rules. */
interface Props {
  save?: InvoiceAction;
  /** dirty: unsaved edits, so Post waits for Save. */
  post?: InvoiceAction & { dirty: boolean };
  print?: InvoiceAction;
  email?: InvoiceAction;
  transfer?: InvoiceAction;
  recordPayment?: InvoiceAction;
  applyCredit?: InvoiceAction;
  writeOff?: InvoiceAction;
  unpost?: InvoiceAction;
  voidInvoice?: InvoiceAction;
}

// Below md the bar keeps only the main button, Save and Print; the rest (Email too) goes under More.
// No matchMedia (tests) = desktop, as in DataTable.
const PHONE_QUERY = '(max-width: 767px)';
const subscribePhone = (onChange: () => void) => {
  if (typeof window.matchMedia !== 'function') return () => {};
  const query = window.matchMedia(PHONE_QUERY);
  query.addEventListener?.('change', onChange);
  return () => query.removeEventListener?.('change', onChange);
};
const isPhoneNow = () => typeof window.matchMedia === 'function' && window.matchMedia(PHONE_QUERY).matches;

type MainAction = 'post' | 'recordPayment' | 'applyCredit' | 'save' | null;

/** One main button per status: Post, else Record payment, else Apply credit, else Save on a new invoice. */
function mainActionOf({ post, recordPayment, applyCredit, save }: Props): MainAction {
  if (post) return 'post';
  if (recordPayment) return 'recordPayment';
  if (applyCredit) return 'applyCredit';
  return save ? 'save' : null;
}

/** What goes under More: Email too below md, and Apply credit unless it is the main button. */
function moreItems({ email, transfer, applyCredit, writeOff, unpost, voidInvoice }: Props, isPhone: boolean, main: MainAction) {
  const more: ActionMenuItem[] = [];
  const add = (id: string, label: string, a: InvoiceAction | undefined, node: ReactNode, danger = false) => {
    if (a) more.push({ id, label, icon: node, onAction: a.onClick, disabled: a.disabled || a.loading, danger });
  };
  if (isPhone) add('email', 'Email', email, <Mail className="h-4 w-4" />);
  add('transfer', 'Transfer to scheduling…', transfer, <RotateCcw className="h-4 w-4" />);
  if (main !== 'applyCredit') add('apply-credit', 'Apply credit…', applyCredit, <Receipt className="h-4 w-4" />);
  add('write-off', 'Write off…', writeOff, <X className="h-4 w-4" />);
  add('unpost', 'Unpost…', unpost, <RotateCcw className="h-4 w-4" />);
  add('void', 'Void invoice…', voidInvoice, <X className="h-4 w-4" />, true);
  return more;
}

function PostButton({ post, hintId, className }: { post: NonNullable<Props['post']>; hintId: string; className: string }) {
  return (
    <>
      <Button className={className} icon={<Send className="h-4 w-4" />} showChevron={false}
        onClick={post.onClick} loading={post.loading} disabled={post.disabled || post.dirty}
        title={post.dirty ? 'Save your changes first' : undefined}
        aria-describedby={post.dirty ? hintId : undefined}>
        Post invoice…
      </Button>
      {/* Said on screen at every width: a title only shows on hover. Its own line above the buttons; from md,
          w-0 + min-w-full keeps it from widening the bar beside the page heading. */}
      {post.dirty && <p id={hintId} className="order-first w-full text-center text-xs text-amber-800 md:w-0 md:min-w-full md:text-right">Save your changes first</p>}
    </>
  );
}

/**
 * The invoice's actions: one main button per status (Post, else Record payment, else Apply credit, else Save on a
 * new invoice), Save, Print and Email beside it, and the rest under More. Below md it is a bar above the bottom nav.
 */
export default function InvoiceActionsBar(props: Props) {
  const { save, post, print, email, recordPayment, applyCredit } = props;
  const isPhone = useSyncExternalStore(subscribePhone, isPhoneNow, () => false);
  const hintId = useId();
  const main = mainActionOf(props);
  const more = moreItems(props, isPhone, main);

  // Tighter below md, so Save, Print and More share one row at 360 px.
  const secondary = 'min-h-11 flex-1 whitespace-nowrap max-md:gap-1.5! max-md:px-3! md:min-h-0 md:flex-none';
  const btn = (a: InvoiceAction, label: string, node: ReactNode, extra: Partial<ComponentProps<typeof Button>> = {}) => (
    <Button variant="secondary" className={secondary} icon={node} showChevron={false}
      onClick={a.onClick} loading={a.loading} disabled={a.disabled} {...extra}>
      {label}
    </Button>
  );
  const primary = 'order-first min-h-11 w-full md:order-none md:min-h-0 md:w-auto';

  if (!main && !print && !email && more.length === 0) return null;
  return (
    <div className="fixed inset-x-0 bottom-[calc(3.5rem+env(safe-area-inset-bottom))] z-20 flex flex-wrap gap-2 border-t border-gray-200 bg-white/95 p-3 backdrop-blur md:static md:z-auto md:shrink-0 md:justify-end md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none">
      {save && btn(save, 'Save changes', <Check className="h-4 w-4" />, main === 'save' ? { variant: 'primary', className: primary } : {})}
      {print && btn(print, 'Print…', <Printer className="h-4 w-4" />)}
      {email && !isPhone && btn(email, 'Email', <Mail className="h-4 w-4" />)}
      {more.length > 0 && <ActionMenu label="More actions" items={more} />}
      {post && <PostButton post={post} hintId={hintId} className={primary} />}
      {main === 'recordPayment' && recordPayment && btn(recordPayment, 'Record payment', <DollarSign className="h-4 w-4" />, { variant: 'primary', className: primary })}
      {main === 'applyCredit' && applyCredit && btn(applyCredit, 'Apply credit…', <Receipt className="h-4 w-4" />, { variant: 'primary', className: primary })}
    </div>
  );
}
