import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';

type Tone = 'good' | 'critical' | 'warning';
type Toast = { id: number; tone: Tone; text: ReactNode };

const Ctx = createContext<(tone: Tone, text: ReactNode) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const seq = useRef(0);
  const show = useCallback((tone: Tone, text: ReactNode) => {
    const id = ++seq.current;
    setToast({ id, tone, text });
    setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 4500);
  }, []);

  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toast" role="status" aria-live="polite">
        {toast && (
          <div className={`alert alert-${toast.tone}`}>
            <Icon name={toast.tone === 'good' ? 'check' : toast.tone === 'critical' ? 'x' : 'alert'} />
            <div>{toast.text}</div>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
