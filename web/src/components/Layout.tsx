import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router';
import { useAccount } from '../lib/account';
import { useImports } from '../lib/queries';
import { useTheme } from '../lib/theme';
import { Icon } from './Icon';

function AccountPicker() {
  const { account, setAccount } = useAccount();
  const [draft, setDraft] = useState(account);
  useEffect(() => setDraft(account), [account]);
  const commit = () => (/^\d{1,15}$/.test(draft) ? setAccount(draft) : setDraft(account));

  return (
    <label className="field" title="No sign-in yet: each account is just an id. It is created on first upload.">
      Account
      <input
        className="input account-input num"
        inputMode="numeric"
        value={draft}
        onChange={(e) => setDraft(e.target.value.replace(/\D/g, ''))}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
        aria-label="Account id"
      />
    </label>
  );
}

export function Layout() {
  const { theme, toggle } = useTheme();
  const { pending } = useImports(); // app-wide: keeps polling and refreshing data while jobs run

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <Link to="/" className="brand">
            <img src="/favicon.svg" alt="" className="brand-mark" />
            Checksum
          </Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/" end>
              Overview
            </NavLink>
            <NavLink to="/transactions">Transactions</NavLink>
            <NavLink to="/imports">Imports</NavLink>
          </nav>
          <div className="topbar-right">
            {pending > 0 && (
              <Link to="/imports" className="badge badge-accent" style={{ textDecoration: 'none' }}>
                <Icon name="spinner" size={13} />
                Processing {pending}
              </Link>
            )}
            <AccountPicker />
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={toggle}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title="Toggle theme"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
          </div>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
