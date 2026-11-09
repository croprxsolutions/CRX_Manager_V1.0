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
  success: <CheckCircle2 className="w-4 h-4" />,
  error: <AlertCircle className="w-4 h-4" />,
  info: <Info className="w-4 h-4" />,
  warning: <AlertTriangle className="w-4 h-4" />,
};

const iconCircle: Record<ToastType, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  error: 'bg-red-50 text-red-700',
  info: 'bg-sky-50 text-sky-800',
  warning: 'bg-amber-50 text-amber-800',
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
      <div
        data-toast-viewport
        className="fixed inset-x-3 bottom-[calc(4.5rem+env(safe-area-inset-bottom)+0.75rem)] z-[100] flex flex-col gap-2 md:inset-x-auto md:bottom-4 md:right-4"
        role="status"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.type === 'error' ? 'alert' : 'status'}
            aria-live={t.type === 'error' ? 'assertive' : 'polite'}
            className={`
              flex min-w-0 w-full items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-3 shadow-lg md:w-auto md:max-w-sm
              animate-in slide-in-from-right
            `}
          >
            <span aria-hidden="true" className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${iconCircle[t.type]}`}>{icons[t.type]}</span>
            <p className="min-w-0 break-words text-sm text-nav-dark">{t.message}</p>
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
