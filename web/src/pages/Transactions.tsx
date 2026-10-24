import { useMemo } from 'react';
import { useSearchParams } from 'react-router';
import { CategoryEditor } from '../components/CategoryEditor';
import { Icon } from '../components/Icon';
import { ErrorState, Loading } from '../components/QueryState';
import type { Txn } from '../lib/api';
import { dayLabel, money, monthLabel, plural, titleCase } from '../lib/format';
import { useTransactions } from '../lib/queries';

const PAGE = 50;
type Dir = 'all' | 'debit' | 'credit';

export function TransactionsPage() {
  const q = useTransactions();
  const [params, setParams] = useSearchParams();
  const search = params.get('q') ?? '';
  const category = params.get('category') ?? '';
  const channel = params.get('channel') ?? '';
  const month = params.get('month') ?? '';
  const dir = (params.get('dir') as Dir) || 'all';
  const page = Math.max(1, Number(params.get('page')) || 1);

  /** Change one filter and go back to page 1. Empty values are dropped from the URL. */
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value && !(key === 'dir' && value === 'all')) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  };

  const all = q.data ?? [];
  const facets = useMemo(() => {
    const cats = new Set<string>();
    const chans = new Set<string>();
    const months = new Set<string>();
    for (const t of all) {
      cats.add(t.category.category);
      chans.add(t.channel);
      months.add(t.date.slice(0, 7));
    }
    return { categories: [...cats].sort(), channels: [...chans].sort(), months: [...months].sort().reverse() };
  }, [all]);

  const rows = useMemo(() => {
    const needle = search.trim().toUpperCase();
    return all
      .filter(
        (t) =>
          (!needle || t.narration.toUpperCase().includes(needle) || (t.merchantKey ?? '').includes(needle)) &&
          (!category || t.category.category === category) &&
          (!channel || t.channel === channel) &&
          (!month || t.date.startsWith(month)) &&
          (dir === 'all' || (dir === 'debit' ? t.debitPaise > 0 : t.creditPaise > 0)),
      )
      .reverse(); // API is oldest-first; newest on top reads better
  }, [all, search, category, channel, month, dir]);

  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const current = Math.min(page, pages);
  const visible = rows.slice((current - 1) * PAGE, current * PAGE);
  const totals = rows.reduce((s, t) => ({ out: s.out + t.debitPaise, in: s.in + t.creditPaise }), { out: 0, in: 0 });
  const filtered = Boolean(search || category || channel || month || dir !== 'all');

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Transactions</h1>
          <p>
            Click a category to relabel a merchant. It applies to all of their transactions, past and future.
          </p>
        </div>
      </div>

      <section className="card">
        <div className="filters">
          <input
            type="search"
            className="input"
            placeholder="Search description or merchant"
            value={search}
            onChange={(e) => set('q', e.target.value)}
            aria-label="Search transactions"
          />
          <select className="select" value={month} onChange={(e) => set('month', e.target.value)} aria-label="Month">
            <option value="">All months</option>
            {facets.months.map((m) => (
              <option key={m} value={m}>
                {monthLabel(m)}
              </option>
            ))}
          </select>
          <select className="select" value={category} onChange={(e) => set('category', e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {facets.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <select className="select" value={channel} onChange={(e) => set('channel', e.target.value)} aria-label="Channel">
            <option value="">All channels</option>
            {facets.channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <div className="seg" role="group" aria-label="Direction">
            {(['all', 'debit', 'credit'] as const).map((d) => (
              <button key={d} type="button" aria-pressed={dir === d} onClick={() => set('dir', d)}>
                {d === 'all' ? 'All' : d === 'debit' ? 'Money out' : 'Money in'}
              </button>
            ))}
          </div>
          {filtered && (
            <button type="button" className="btn btn-ghost" onClick={() => setParams({}, { replace: true })}>
              Clear
            </button>
          )}
        </div>

        {q.error ? (
          <div className="card-pad">
            <ErrorState error={q.error} retry={q.refetch} />
          </div>
        ) : q.isPending ? (
          <div className="card-pad">
            <Loading rows={8} />
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <h2>{all.length ? 'No matching transactions' : 'No transactions yet'}</h2>
            <p>{all.length ? 'Try clearing a filter.' : 'Upload a statement on the Imports page to get started.'}</p>
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="hide-sm">Channel</th>
                    <th>Category</th>
                    <th className="right">Amount</th>
                    <th className="right hide-sm">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((t, i) => (
                    <TxnRow key={`${t.importId}-${t.date}-${i}`} t={t} extraCategories={facets.categories} />
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot">
              <span className="num">
                {plural(rows.length, 'transaction')} · out {money(totals.out)} · in {money(totals.in)}
              </span>
              {pages > 1 && (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-icon"
                    disabled={current === 1}
                    onClick={() => set('page', String(current - 1))}
                    aria-label="Previous page"
                  >
                    <Icon name="chevronLeft" />
                  </button>
                  <span className="num">
                    {current} / {pages}
                  </span>
                  <button
                    type="button"
                    className="btn btn-icon"
                    disabled={current === pages}
                    onClick={() => set('page', String(current + 1))}
                    aria-label="Next page"
                  >
                    <Icon name="chevronRight" />
                  </button>
                </span>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function TxnRow({ t, extraCategories }: { t: Txn; extraCategories: string[] }) {
  const credit = t.creditPaise > 0;
  return (
    <tr>
      <td className="num" style={{ whiteSpace: 'nowrap' }}>
        {dayLabel(t.date)}
      </td>
      <td>
        <div className="desc-main">{t.merchantKey ? titleCase(t.merchantKey) : t.narration}</div>
        {t.merchantKey && (
          <div className="desc-sub" title={t.narration}>
            {t.narration}
          </div>
        )}
      </td>
      <td className="hide-sm">
        <span className="muted">{t.channel}</span>
      </td>
      <td>
        <CategoryEditor txn={t} extraCategories={extraCategories} />
      </td>
      <td className={`right num${credit ? ' amount-credit' : ''}`} style={{ whiteSpace: 'nowrap' }}>
        {credit ? `+${money(t.creditPaise)}` : `−${money(t.debitPaise)}`}
      </td>
      <td className="right num muted hide-sm" style={{ whiteSpace: 'nowrap' }}>
        {t.balancePaise === null ? '—' : money(t.balancePaise)}
      </td>
    </tr>
  );
}
