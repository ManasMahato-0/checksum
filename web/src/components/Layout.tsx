import { Link, NavLink, Outlet } from 'react-router';
import { AuthPage } from '../pages/AuthPage';
import { AccountProvider } from '../lib/account';
import { useImports, useMe } from '../lib/queries';
import { useTheme } from '../lib/theme';
import { AccountMenu } from './AccountMenu';
import { Icon } from './Icon';
import { ErrorState } from './QueryState';

/** Session gate: sign-in screen, or the app scoped to the user's accounts. */
export function Layout() {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="auth-wrap" aria-busy="true">
        <Icon name="spinner" size={24} label="Loading" />
      </div>
    );
  }
  if (me.error) {
    return (
      <main>
        <ErrorState error={me.error} retry={me.refetch} />
      </main>
    );
  }
  if (!me.data) return <AuthPage />;
  return (
    <AccountProvider accounts={me.data.accounts}>
      <Shell email={me.data.user.email} />
    </AccountProvider>
  );
}

function Shell({ email }: { email: string }) {
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
                <span className="hide-sm">Processing</span> {pending}
              </Link>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              onClick={toggle}
              aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
              title="Toggle theme"
            >
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
            </button>
            <AccountMenu email={email} />
          </div>
        </div>
      </header>
      <main>
        <Outlet />
      </main>
    </>
  );
}
