import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';

type ToastType = 'success' | 'error' | 'info' | 'warning';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
}

const ToastContext = createContext<ToastContextValue>({ toast: () => {} });

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  return useContext(ToastContext);
}

const icons: Record<ToastType, ReactNode> = {
  success: <CheckCircle2 className="w-5 h-5" />,
  error: <AlertCircle className="w-5 h-5" />,
  info: <Info className="w-5 h-5" />,
  warning: <AlertTriangle className="w-5 h-5" />,
};

const iconCircle: Record<ToastType, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  error: 'bg-red-50 text-red-700',
  info: 'bg-sky-50 text-sky-800',
  warning: 'bg-amber-50 text-amber-800',
};

// A coloured left edge so the type reads at a glance, even before the icon.
const accent: Record<ToastType, string> = {
  success: 'border-l-emerald-600',
  error: 'border-l-red-600',
  info: 'border-l-sky-600',
  warning: 'border-l-amber-500',
};

let nextId = 0;

// The mounted provider's toast, for library code that runs outside React (PDF generators).
let providerToast: ToastContextValue['toast'] | null = null;

// eslint-disable-next-line react-refresh/only-export-components
export function toastOutsideReact(type: ToastType, message: string) {
  providerToast?.(type, message);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = nextId++;
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const removeToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Memoized so consumers don't re-render on every toast (the wrapping object
  // used to be rebuilt each render even though addToast itself was stable).
  // The destructured `toast` function consumers put in effect deps was already
  // stable — an identity-UNSTABLE stub in tests is what produces the
  // load-fail→toast→reload infinite loop; Toast.loopguard.test.tsx pins the
  // real-provider behavior.
  const contextValue = useMemo(() => ({ toast: addToast }), [addToast]);

  useEffect(() => {
    providerToast = addToast;
    return () => { if (providerToast === addToast) providerToast = null; };
  }, [addToast]);

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {/* Toasts never cover a dialog's buttons or the bottom nav. Phone: top, full width.
          md+: top right, below the 64px app header. While a dialog is open (any Modal marks its
          panel data-modal-panel) they move clear of its header X: inset from the right on phone,
          top centre from md up. Dialog footers are at the bottom, so the top is always clear. */}
      <div
        data-toast-viewport
        className="fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-[100] flex flex-col gap-2 md:left-auto md:right-4 md:top-[4.75rem] [body:has([data-modal-panel])_&]:max-md:right-[4.5rem] [body:has([data-modal-panel])_&]:md:right-1/2 [body:has([data-modal-panel])_&]:md:translate-x-1/2"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            aria-live={t.type === 'error' ? 'assertive' : 'polite'}
            className={`
              flex min-w-0 w-full items-center gap-3 rounded-xl border border-l-4 border-gray-200 ${accent[t.type]} bg-white py-2 pl-3 pr-1.5 shadow-lg md:w-auto md:max-w-sm md:py-3 md:pr-3
              motion-safe:transition-[translate,opacity] motion-safe:duration-200 starting:opacity-0 max-md:starting:-translate-y-2 md:starting:translate-x-4
            `}
          >
            <span aria-hidden="true" className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${iconCircle[t.type]}`}>{icons[t.type]}</span>
            <p className="min-w-0 break-words text-[15px] font-medium leading-snug text-nav-dark md:text-sm">{t.message}</p>
            <button
              onClick={() => removeToast(t.id)}
              aria-label="Dismiss notification"
              className="ml-auto inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-gray-400 hover:text-gray-600 md:h-8 md:w-8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-crx-green focus-visible:ring-offset-2"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
