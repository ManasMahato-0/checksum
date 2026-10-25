import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, type Me } from '../lib/api';
import { useAccount } from '../lib/account';
import { keys } from '../lib/queries';
import { Icon } from './Icon';
import { useToast } from './Toast';

/** Header menu: switch account, add an account, sign out. */
export function AccountMenu({ email }: { email: string }) {
  const { accounts, current, setAccount } = useAccount();
  const qc = useQueryClient();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.createAccount(name.trim()),
    onSuccess: (account) => {
      qc.setQueryData<Me | null>(keys.me, (me) => (me ? { ...me, accounts: [...me.accounts, account] } : me));
      setAccount(account.id);
      setName('');
      setOpen(false);
      toast('good', <>Created <strong>{account.name}</strong>.</>);
    },
    onError: (e) => toast('critical', `Could not create account: ${e.message}`),
  });

  const logout = useMutation({
    mutationFn: api.logout,
    onSettled: () => {
      qc.clear();
      qc.setQueryData(keys.me, null);
    },
  });

  return (
    <div className="popover-anchor" ref={root}>
      <button type="button" className="btn account-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="account-avatar" aria-hidden>
          {email[0]?.toUpperCase()}
        </span>
        <span className="account-name">{current.name}</span>
        <Icon name="chevronDown" size={14} />
      </button>
      {open && (
        <div className="popover popover-right menu" role="menu">
          <div className="menu-label">Signed in as</div>
          <div className="menu-email">{email}</div>
          <div className="menu-sep" />
          <div className="menu-label">Accounts</div>
          {accounts.map((a) => (
            <button
              key={a.id}
              type="button"
              role="menuitemradio"
              aria-checked={a.id === current.id}
              className="menu-item"
              onClick={() => {
                setAccount(a.id);
                setOpen(false);
              }}
            >
              <span className="menu-check">{a.id === current.id && <Icon name="check" size={14} />}</span>
              {a.name}
            </button>
          ))}
          <form
            className="menu-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) create.mutate();
            }}
          >
            <input className="input" placeholder="New account name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            <button type="submit" className="btn" disabled={!name.trim() || create.isPending}>
              Add
            </button>
          </form>
          <div className="menu-sep" />
          <button type="button" role="menuitem" className="menu-item" onClick={() => logout.mutate()}>
            <span className="menu-check">
              <Icon name="logout" size={14} />
            </span>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
