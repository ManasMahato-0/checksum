import { createContext, useContext, useState, type ReactNode } from 'react';
import type { Account } from './api';
import { load, save } from './storage';

// The account being viewed, always one the signed-in user owns.
type AccountCtx = { account: string; accounts: Account[]; current: Account; setAccount: (id: string) => void };
const Ctx = createContext<AccountCtx | null>(null);

export function AccountProvider({ accounts, children }: { accounts: Account[]; children: ReactNode }) {
  const [chosen, setChosen] = useState(() => load('account'));
  // Fall back to the first account if the remembered one is gone (or belonged to another user).
  const current = accounts.find((a) => a.id === chosen) ?? accounts[0]!;
  const setAccount = (id: string) => {
    setChosen(id);
    save('account', id);
  };
  return <Ctx.Provider value={{ account: current.id, accounts, current, setAccount }}>{children}</Ctx.Provider>;
}

export function useAccount() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAccount outside AccountProvider');
  return ctx;
}
