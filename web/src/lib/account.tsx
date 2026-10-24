import { createContext, useContext, useState, type ReactNode } from 'react';
import { load, save } from './storage';

// No auth yet: the account is just an id the user picks. Accounts are created on first upload.
type AccountCtx = { account: string; setAccount: (id: string) => void };
const Ctx = createContext<AccountCtx | null>(null);

export function AccountProvider({ children }: { children: ReactNode }) {
  const [account, setState] = useState(() => {
    const saved = load('account');
    return saved && /^\d{1,15}$/.test(saved) ? saved : '1';
  });
  const setAccount = (id: string) => {
    setState(id);
    save('account', id);
  };
  return <Ctx.Provider value={{ account, setAccount }}>{children}</Ctx.Provider>;
}

export function useAccount() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAccount outside AccountProvider');
  return ctx;
}
